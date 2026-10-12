import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Host } from '../hosts/host.ts'
import { capturePanes, probe, tmuxFields } from './tmux.ts'

// A machine reached over SSH often has no locale at all. tmux then wrote its field separator as
// "_" and the machine listed no sessions, though two were running. A private server (short path:
// tmux sockets have a length limit), with the locale taken away as SSH would.
const dir = mkdtempSync('/tmp/inyon-locale-')
const own = `unset TMUX TMUX_PANE LANG LC_CTYPE LC_MESSAGES; export LC_ALL=C TMUX_TMPDIR='${dir}';`
const host = new Host({ id: 'locale', name: 'locale', kind: 'local' } as any)
const noLocale = { ...host, config: host.config, exec: (cmd: string, o?: any) => host.exec(`${own} ${cmd}`, o) } as unknown as Host

beforeAll(async () => {
  await noLocale.exec(`tmux new-session -d -s 'tëst' -x 80 -y 20 "printf 'räksmörgås ⏺\\\\n'; sleep 600"`)
  await noLocale.exec(`tmux new-session -d -s second 'sleep 600'`)
  const socket = (await noLocale.exec(`tmux display -p -t second '#{socket_path}'`)).stdout.trim()
  if (!socket.startsWith(dir)) throw new Error(`tmux used ${socket || 'an unknown server'}, not the test's own`)
})
afterAll(async () => {
  // by socket path, so it can only ever stop this test's server
  await host.exec(`[ -S '${dir}/tmux-'"$(id -u)"/default ] && tmux -S '${dir}/tmux-'"$(id -u)"/default kill-server 2>/dev/null; true`)
  rmSync(dir, { recursive: true, force: true })
})

test('sessions are listed, with their names intact, when the machine has no locale', async () => {
  const r = await probe(noLocale)
  expect(r.tmux).toBe('ok')
  expect(r.sessions.map((s) => s.name).sort()).toEqual(['second', 'tëst'])
})

test("a pane's screen keeps its non-ASCII text", async () => {
  const r = await probe(noLocale)
  const pane = r.sessions.find((s) => s.name === 'tëst')!.windows[0]!.panes[0]!.id
  const screen = (await capturePanes(noLocale, [pane])).get(pane)!.join('\n')
  expect(screen).toContain('räksmörgås ⏺')
})

test('tmux 3.4 escapes the field separator; its lines read the same as newer ones', () => {
  // as tmux 3.4 printed a session "a\b" holding window "tëst"
  expect(tmuxFields('a\\\\b\\037tëst\\037%0')).toEqual(['a\\b', 'tëst', '%0'])
  // newer tmux: the separator as it is, and a backslash left alone
  expect(tmuxFields('a\\b\u001ftëst\u001f%0')).toEqual(['a\\b', 'tëst', '%0'])
})
