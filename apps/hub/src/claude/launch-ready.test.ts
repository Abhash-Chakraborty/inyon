import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../hosts/host.ts'
import { capturePanes, typeText } from '../tmux/tmux.ts'
import { shellReady } from './actions.ts'

// A tmux server of its own, never the user's. $TMUX would make tmux ignore TMUX_TMPDIR and use the
// server it runs inside, so every command drops it first.
const dir = mkdtempSync(join(tmpdir(), 'tether-ready-'))
const own = `unset TMUX TMUX_PANE; export TMUX_TMPDIR='${dir}';`
const host = new Host({ id: 'ready', name: 'ready', kind: 'local' } as any)
const tmuxHost = { ...host, exec: (cmd: string, o?: any) => host.exec(`${own} ${cmd}`, o) } as unknown as Host

beforeAll(async () => {
  // refuse to run at all unless the server really is the private one
  await tmuxHost.exec(`tmux new-session -d -s guard 'sleep 600'`)
  const socket = (await tmuxHost.exec(`tmux display -p -t guard '#{socket_path}'`)).stdout.trim()
  if (!socket.startsWith(dir)) throw new Error(`tmux used ${socket || 'an unknown server'}, not the test's own`)
})
afterAll(async () => {
  // by socket path, so it can only ever stop this test's server
  await host.exec(`[ -S '${dir}/tmux-'"$(id -u)"/default ] && tmux -S '${dir}/tmux-'"$(id -u)"/default kill-server 2>/dev/null; true`)
  rmSync(dir, { recursive: true, force: true })
})

const pane = async (script: string) => {
  const f = join(dir, `s${Math.random().toString(36).slice(2)}.sh`)
  writeFileSync(f, script)
  const r = await tmuxHost.exec(`tmux new-session -d -x 100 -y 30 -P -F '#{pane_id}' sh ${f}`)
  return r.stdout.trim()
}
const screen = async (p: string) => ((await capturePanes(tmuxHost, [p])).get(p) ?? []).join('\n')

test('waits for a slow shell, so the command reaches its prompt', async () => {
  // a shell whose startup takes a second and throws away anything typed meanwhile
  const p = await pane(`sleep 1; stty -echo; while read -t 0.01 x; do :; done; stty echo; printf 'me@box ~ $ '; read cmd; echo "ran: $cmd"; sleep 30`)
  await shellReady(tmuxHost, p)
  await typeText(tmuxHost, p, 'claude', true)
  for (let i = 0; i < 20 && !/ran:/.test(await screen(p)); i++) await Bun.sleep(100)
  expect(await screen(p)).toContain('ran: claude')
}, 15_000)

test("steps past zsh's first-run questions without answering them for good", async () => {
  // like zsh-newuser-install: one key, no Enter, and the question stays on screen afterwards
  const p = await pane(
    `echo 'This is the Z Shell configuration function for new users,'; echo 'zsh-newuser-install.'; printf -- '--- Type one of the keys in parentheses --- '; stty -icanon min 1; k=$(dd bs=1 count=1 2>/dev/null); stty icanon; printf '\\nme@box %% '; read cmd; echo "ran: $cmd ($k)"; sleep 30`,
  )
  await shellReady(tmuxHost, p)
  await typeText(tmuxHost, p, 'claude', true)
  for (let i = 0; i < 20 && !/ran:/.test(await screen(p)); i++) await Bun.sleep(100)
  expect(await screen(p)).toContain('ran: claude (q)')
}, 15_000)
