import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { viewCommand } from './terminal.ts'

// The phone's terminal view, attached for real in a pseudo-terminal on a tmux server of the
// test's own: C-b must not take it out of its one window. tmux checks the prefix before the
// view's key table, so the table alone didn't stop C-b s or C-b :.
const dir = mkdtempSync(join(tmpdir(), 'inyon-view-'))
const env = { ...process.env, TMUX_TMPDIR: dir, TERM: 'xterm' } as Record<string, string>
delete env.TMUX
delete env.TMUX_PANE
const tmux = (...args: string[]) => {
  const r = Bun.spawnSync(['tmux', '-f', '/dev/null', ...args], { env })
  return r.stdout.toString().trim()
}
afterAll(() => {
  Bun.spawnSync(['tmux', '-S', `${dir}/tmux-${process.getuid!()}/default`, 'kill-server'], { env })
  rmSync(dir, { recursive: true, force: true })
})

// opens `cmd` on a pseudo-terminal, presses C-b, and says which key table the client is in then
const PROBE = `
import os, pty, subprocess, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp('sh', ['sh', '-c', sys.argv[1]])
for _ in range(50):
    time.sleep(0.1)
    if subprocess.run(['tmux', 'list-clients', '-F', '#{client_session}'], capture_output=True, text=True).stdout.strip():
        break
os.write(fd, b'\\x02')
time.sleep(0.4)
print(subprocess.run(['tmux', 'list-clients', '-F', '#{client_key_table}'], capture_output=True, text=True).stdout.strip())
os.kill(pid, 9)
`

const hasPython = Bun.spawnSync(['python3', '-c', 'import pty'], { env }).exitCode === 0

test.skipIf(!hasPython)("the prefix key does nothing in the phone's terminal view", () => {
  tmux('new-session', '-d', '-s', 'work', '-x', '80', '-y', '20')
  const window = tmux('display', '-p', '-t', 'work', '#{window_id}')
  const pane = tmux('display', '-p', '-t', 'work', '#{pane_id}')
  const probe = (cmd: string) => Bun.spawnSync(['python3', '-c', PROBE, cmd], { env }).stdout.toString().trim()
  expect(probe(viewCommand('inyon-view-t1', window, pane))).toBe('inyon-view')
  // what it did before: the key table alone, and C-b opened tmux's prefix table
  const before = viewCommand('inyon-view-t2', window, pane).replace(/ \\; set-option -t '[^']+' prefix2? None/g, '')
  expect(probe(before)).toBe('prefix')
}, 20_000)
