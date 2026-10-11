import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { Host } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { watchers } from './watcher.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())
afterAll(() => {
  watchers.quiet(false)
  watchers.stop('quiet-test:%7')
})

test('in the background an open chat reads its screen rarely, and again at once on return', async () => {
  let reads = 0
  const host = new Host({ id: 'quiet-test', name: 'Box', kind: 'local' } as any)
  Object.assign(host, {
    exec: async (cmd: string) => {
      if (cmd.includes('capture-pane')) reads++
      return { code: 0, stdout: '', stderr: '' }
    },
    stream: () => ({ kill() {}, exited: new Promise(() => {}) }),
  })
  spyOn(registry, 'get').mockReturnValue({ host, state: { status: 'online' } } as any)
  spyOn(registry, 'host').mockReturnValue(host)
  spyOn(registry, 'findPane').mockReturnValue({ pane: { id: '%7', title: 'claude', width: 100, agent: { kind: 'claude' } } } as any)
  watchers.get('quiet-test', '%7')
  await Bun.sleep(2300)
  // in the foreground it's every 2 s
  expect(reads).toBeGreaterThanOrEqual(2)

  watchers.quiet(true)
  await Bun.sleep(100)
  reads = 0
  await Bun.sleep(2300)
  expect(reads).toBe(0)

  watchers.quiet(false)
  await Bun.sleep(100)
  expect(reads).toBe(1)
}, 10_000)

test('a very long Gemini or Antigravity chat keeps only its latest messages, like the others', () => {
  const w = watchers.get('quiet-test', '%7')
  const items = Array.from({ length: 5000 }, (_, i) => ({ kind: 'user', seq: i, text: `message ${i}` }))
  ;(w as any).publishSnapshot(items)
  const held = (w as any).items
  expect(held).toHaveLength(4000)
  expect(held.at(-1).text).toBe('message 4999')
})
