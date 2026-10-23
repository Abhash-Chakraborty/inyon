import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../hosts/host.ts'
import { pasteCommand, pasteText, typeText } from './tmux.ts'

// What an agent's input box receives, byte for byte, when text is typed into its pane: through the
// buffer now, as send-keys -l before 0.20. Claude Code, Codex, OpenCode and a shell all get their
// messages through typeText, so the same bytes mean the same bracketed paste, the same markers and
// no early submit. A tmux server of its own, never the user's: $TMUX would make tmux ignore
// TMUX_TMPDIR, so every command drops it first.
const dir = mkdtempSync(join(tmpdir(), 'inyon-typed-'))
const own = `unset TMUX TMUX_PANE; export TMUX_TMPDIR='${dir}';`
const host = new Host({ id: 'typed', name: 'typed', kind: 'local' } as any)
const tmuxHost = { ...host, exec: (cmd: string, o?: any) => host.exec(`${own} ${cmd}`, o) } as unknown as Host
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

beforeAll(async () => {
  await tmuxHost.exec(`tmux new-session -d -s guard 'sleep 600'`)
  const socket = (await tmuxHost.exec(`tmux display -p -t guard '#{socket_path}'`)).stdout.trim()
  if (!socket.startsWith(dir)) throw new Error(`tmux used ${socket || 'an unknown server'}, not the test's own`)
})
afterAll(async () => {
  await host.exec(`[ -S '${dir}/tmux-'"$(id -u)"/default ] && tmux -S '${dir}/tmux-'"$(id -u)"/default kill-server 2>/dev/null; true`)
  rmSync(dir, { recursive: true, force: true })
})

/** A pane whose program asks for bracketed paste, as the agents' input boxes do, and records every byte it's sent. */
async function recorder() {
  const out = join(dir, `o${Math.random().toString(36).slice(2)}`)
  const script = join(dir, `s${Math.random().toString(36).slice(2)}.sh`)
  writeFileSync(script, `stty raw -echo; printf '\\033[?2004h'; : > '${out}.ready'; exec cat > '${out}'\n`)
  const pane = (await tmuxHost.exec(`tmux new-session -d -x 100 -y 30 -P -F '#{pane_id}' sh ${script}`)).stdout.trim()
  for (let i = 0; i < 100 && !existsSync(`${out}.ready`); i++) await Bun.sleep(20)
  // tmux reads the mode switch from the pane's output: give it a moment
  await Bun.sleep(300)
  const read = () => (existsSync(out) ? readFileSync(out, 'latin1') : '')
  return {
    pane,
    /** Everything sent, once nothing more has come for 400 ms. */
    settled: async () => {
      let last = read()
      let quiet = 0
      for (const until = Date.now() + 8000; quiet < 400 && Date.now() < until; ) {
        await Bun.sleep(50)
        const now = read()
        quiet = now !== last || !now ? 0 : quiet + 50
        last = now
      }
      return last
    },
  }
}

/** How text was typed before 0.20: send-keys -l per line, C-j between lines; long or multi-line text as the same bracketed paste. */
async function typedBefore(pane: string, text: string, submit: boolean) {
  if (text.length > 800 || /[\r\n]/.test(text)) {
    const old = pasteCommand(`inyon-old-${Math.random().toString(36).slice(2)}`, pane)
      .replace(`trap '[ -z "$f" ] || rm -f "$f"'`, `trap 'rm -f "$f"'`)
      .replace('rm -f "$f"; f=;', 'rm -f "$f";')
    await tmuxHost.exec(old, { input: pasteText(text) })
    if (submit) {
      await Bun.sleep(150)
      await tmuxHost.exec(`tmux send-keys -t ${shq(pane)} Enter`)
    }
    return
  }
  const parts = text ? [`tmux send-keys -t ${shq(pane)} -l -- ${shq(text)}`] : []
  if (submit) parts.push('sleep 0.12', `tmux send-keys -t ${shq(pane)} Enter`)
  await tmuxHost.exec(parts.join(' && '))
}

const samples: [string, string, boolean][] = [
  ['one line, sent', 'fix the failing test', true],
  ['one line, left in the box', 'it\'s "quoted" $HOME `id`', false],
  ['UTF-8', 'ünïcødé — 🙂', true],
  ['several lines, sent', 'first line\nsecond line\n\nfourth', true],
  ['Windows line ends', 'a\r\nb\rc', true],
  ['several lines, left in the box', 'draft\nstill a draft', false],
  ['a paste marker inside', 'x\n\x1b[201~\x15!id\r', true],
  ['long text', `${'y'.repeat(850)} end`, true],
]

for (const [name, text, submit] of samples) {
  test(`typed text reaches the pane as the same bytes as before: ${name}`, async () => {
    const before = await recorder()
    await typedBefore(before.pane, text, submit)
    const was = await before.settled()
    const now = await recorder()
    await typeText(tmuxHost, now.pane, text, submit)
    const got = await now.settled()
    expect(was.length).toBeGreaterThan(0)
    expect(JSON.stringify(got)).toBe(JSON.stringify(was))
    // several lines (or long text) are one bracketed paste, and the only Enter outside it is the submit
    if (text.length > 800 || /[\r\n]/.test(text)) {
      expect(got.startsWith('\x1b[200~')).toBe(true)
      const outside = got.slice(got.indexOf('\x1b[201~') + 6)
      expect(outside).toBe(submit ? '\r' : '')
      expect(got.match(/\x1b\[201~/g)?.length).toBe(1)
    } else {
      expect(got).toBe(Buffer.from(text, 'utf8').toString('latin1') + (submit ? '\r' : ''))
    }
  }, 20_000)
}
