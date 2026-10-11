import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PRELUDE from '../../../node/win-prelude.sh' with { type: 'text' }

// a stand-in for psmux's tmux.exe: logs its argv and answers like psmux would
const bin = mkdtempSync(join(tmpdir(), 'psmux-'))
writeFileSync(
  join(bin, 'tmux'),
  `#!/bin/sh
for a in "$@"; do printf '[%s]' "$a" >> "${bin}/argv"; done; echo >> "${bin}/argv"
case "$1" in
  list-panes) echo '$14 $14:%1 $14:@1 x'; echo '$16 $16:%1 $16:@1 y'; exit 3 ;;
  list-sessions) printf '$14\\n$16\\n' ;;
  list-clients) [ "$3" = '$14' ] && echo '/dev/pts/2: a: pwsh [80x24] (utf8) (control mode) [activity=1s ago]' ;;
esac
`,
)
chmodSync(join(bin, 'tmux'), 0o755)

const run = (cmd: string) => {
  writeFileSync(join(bin, 'argv'), '')
  const r = Bun.spawnSync(['/bin/sh', '-c', `${PRELUDE}\n${cmd}`], { env: { PATH: `${bin}:/usr/bin:/bin` } })
  return { out: r.stdout.toString(), code: r.exitCode, argv: Bun.file(join(bin, 'argv')).text() }
}

test('psmux targets: %session.pane and @session.window become qualified ids', async () => {
  const r = run(`tmux send-keys -t '%14.1' -l -- '%3.4 #{pane_id}' && tmux select-window -t @16.2 && tmux send-keys -t %14.1 Enter`)
  expect(await r.argv).toBe('[send-keys][-t][$14:.%1][-l][--][%3.4 #{pane_id}]\n[select-window][-t][$16:@2]\n[send-keys][-t][$14:.%1][Enter]\n')
})

test('pane and window ids print as %session.pane, and the exit code survives', async () => {
  const r = run(`tmux list-panes -a -F '#{session_id} #{pane_id} #{window_id} x'; echo "rc=$?"`)
  expect(await r.argv).toBe('[list-panes][-a][-F][#{session_id} #{session_id}:#{pane_id} #{session_id}:#{window_id} x]\n')
  expect(r.out).toBe('$14 %14.1 @14.1 x\n$16 %16.1 @16.1 y\nrc=3\n')
})

test('list-clients is answered per session from psmux default output', () => {
  expect(run(`tmux list-clients -F '#{session_id} #{client_control_mode}'`).out).toBe('$14 1\n')
})

test('ps reads the snapshot the node wrote; pgrep finds nothing', () => {
  const snap = join(bin, 'ps.txt')
  writeFileSync(snap, '4 0 100 claude claude --resume x\n')
  const r = Bun.spawnSync(['/bin/sh', '-c', `${PRELUDE}\nps -e -o pid=; pgrep -f claude || echo none`], { env: { PATH: `${bin}:/usr/bin:/bin`, TETHER_PS: snap } })
  expect(r.stdout.toString()).toBe('4 0 100 claude claude --resume x\nnone\n')
})

test("the terminal's commands reach the right psmux pane", async () => {
  const { readCommand, inputCommand } = await import('../terminal/mirror.ts')
  const r = run(`${readCommand('%14.1')}; ${inputCommand('%14.1', { keys: ['C-c', 'Up'] }).cmd}; ${inputCommand('%14.1', { hex: ['1b', '5b'] }).cmd}`)
  expect(await r.argv).toBe(
    '[display][-p][-t][$14:.%1][#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag}]\n' +
      '[capture-pane][-p][-e][-t][$14:.%1]\n' +
      '[send-keys][-t][$14:.%1][C-c][Up]\n' +
      '[send-keys][-t][$14:.%1][-H][1b][5b]\n',
  )
})

test('an agent that exits on Windows leaves PowerShell behind, and remain-on-exit is set on the window', async () => {
  const { remainOnExit, respawnShell } = await import('../claude/actions.ts')
  const r = run(`${remainOnExit(true, "'%14.1'", true)}; ${respawnShell(true, "'%14.1'")}; ${remainOnExit(true, "'%14.1'", false)}`)
  expect(await r.argv).toBe('[set-option][-w][-t][$14:.%1][remain-on-exit][on]\n[respawn-pane][-k][-t][$14:.%1][powershell.exe]\n[set-option][-w][-t][$14:.%1][-u][remain-on-exit]\n')
})

test('a sign-in on Windows is a PowerShell line that prints the exit mark', async () => {
  const { signInWindows } = await import('../features/signin.ts')
  expect(signInWindows('gemini')).toBe(`$env:NO_BROWSER='true'; gemini; Write-Output ''; Write-Output "[tether-exit $([int]$LASTEXITCODE)]"`)
  expect(signInWindows('codex')).toStartWith('codex login --device-auth; ')
})

test("a paste loads its buffer into the pane's own psmux server, since each session has its own", async () => {
  const { pasteCommand } = await import('../tmux/tmux.ts')
  const cmd = pasteCommand('b1', '%14.1')
  const go = (env: Record<string, string>) => {
    writeFileSync(join(bin, 'argv'), '')
    Bun.spawnSync(['/bin/sh', '-c', `${PRELUDE}\n${cmd}`], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, stdin: Buffer.from('x\ny') })
    return Bun.file(join(bin, 'argv')).text()
  }
  expect((await go({ OS: 'Windows_NT' })).replace(/\[[^\]]*tmp[^\]]*\]/, '[file]')).toBe('[-t][$14:.%1][load-buffer][-b][b1][file]\n[paste-buffer][-d][-p][-b][b1][-t][$14:.%1]\n')
  // tmux has one server, and no -t before the command
  expect((await go({})).replace(/\[[^\]]*tmp[^\]]*\]/, '[file]')).toBe('[load-buffer][-b][b1][file]\n[paste-buffer][-d][-p][-b][b1][-t][$14:.%1]\n')
})
