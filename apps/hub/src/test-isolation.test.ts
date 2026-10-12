import { expect, test } from 'bun:test'
import { Host } from './hosts/host.ts'

// A test once stopped the user's real tmux server: with $TMUX set, tmux ignores TMUX_TMPDIR.
test("commands run by tests can't reach the tmux server the tests were started from", async () => {
  const host = new Host({ id: 'iso', name: 'iso', kind: 'local' } as any)
  const r = await host.exec(`echo "[$TMUX][$TMUX_PANE][$TMUX_TMPDIR]"`)
  const [tmux, pane, dir] = r.stdout.trim().slice(1, -1).split('][')
  expect(tmux).toBe('')
  expect(pane).toBe('')
  expect(dir).toContain('inyon-test-tmux-')
})

// Bun keeps a spyOn() mock in place for every test file that runs after it, in whatever order it
// picks. A mocked registry.get once sent CI's phone tests into an endless search for a free id.
test('a test file that mocks something puts it back when it ends', async () => {
  const leaks: string[] = []
  for await (const file of new Bun.Glob('**/*.test.ts').scan(import.meta.dir)) {
    const text = await Bun.file(`${import.meta.dir}/${file}`).text()
    if (/\bspyOn\(/.test(text) && !text.includes('afterAll(() => mock.restore())')) leaks.push(file)
  }
  expect(leaks).toEqual([])
})
