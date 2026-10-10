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
