import { expect, test } from 'bun:test'
import { Host } from './hosts/host.ts'

// A test once stopped the user's real tmux server: with $TMUX set, tmux ignores TMUX_TMPDIR.
test("commands run by tests can't reach the tmux server the tests were started from", async () => {
  const host = new Host({ id: 'iso', name: 'iso', kind: 'local' } as any)
  const r = await host.exec(`echo "[$TMUX][$TMUX_PANE][$TMUX_TMPDIR]"`)
  const [tmux, pane, dir] = r.stdout.trim().slice(1, -1).split('][')
  expect(tmux).toBe('')
  expect(pane).toBe('')
  expect(dir).toContain('tether-test-tmux-')
})
