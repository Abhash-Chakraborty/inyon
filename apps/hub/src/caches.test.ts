import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { clientMessage, clients, closeClient, newClient } from './core.ts'
import { lruCache } from './features/features.ts'
import { registry } from './hosts/registry.ts'
import { watchers } from './claude/watcher.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())

test('the command and file caches drop old entries and keep to a size', async () => {
  const c = lruCache<number>(50, 3)
  for (const k of ['a', 'b', 'c']) c.set(k, 1)
  c.get('a') // used, so b is now the oldest
  c.set('d', 1)
  expect([c.get('a'), c.get('b'), c.get('c'), c.get('d')]).toEqual([1, undefined, 1, 1])
  expect(c.size).toBe(3)
  await Bun.sleep(60)
  expect(c.get('a')).toBeUndefined()
  c.set('e', 1)
  expect(c.size).toBe(1)
})

test('watching a chat starts a watcher only for a pane the machine has', () => {
  let pane: unknown
  const spies = [
    spyOn(registry, 'get').mockReturnValue({} as any),
    spyOn(registry, 'findPane').mockImplementation(() => pane as any),
    spyOn(watchers, 'get').mockReturnValue({ subscribe: mock(), unsubscribe: mock() } as any),
  ]
  const started = spies[2]!
  const c = newClient()
  clients.add(c)
  clientMessage(c, JSON.stringify({ t: 'sub.chat', host: 'h', pane: '%7' }))
  clientMessage(c, JSON.stringify({ t: 'sub.chat', host: 'h', pane: 'not-a-pane' }))
  expect(started).not.toHaveBeenCalled()
  expect(c.chats.size).toBe(1)
  // the pane shows up (a session that was just launched): now it's watched
  pane = { pane: { id: '%7' } }
  ;(registry as any).emit({ type: 'overview' })
  expect(started).toHaveBeenCalledWith('h', '%7')
  closeClient(c)
  for (const s of spies) s.mockRestore()
})
