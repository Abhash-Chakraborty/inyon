import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test'
import { clearSnapshots, flushSnapshots, loadChat, loadOverview, saveChat, saveOverview } from './snapshot.ts'
import { agentPane, chatInfo, host, item } from '../test/fixtures.ts'

// another test file may have left a save behind, written by its timer after it finished
beforeEach(() => clearSnapshots())

afterEach(() => {
  clearSnapshots()
  setSystemTime()
})

test('the overview comes back as it was saved', () => {
  const hosts = [host('a', { panes: [agentPane('%1', 'claude')] })]
  saveOverview(hosts)
  expect(loadOverview()).toBeUndefined()
  flushSnapshots()
  expect(loadOverview()).toEqual(hosts)
})

test('a week later it is not shown any more', () => {
  saveOverview([host('a')])
  flushSnapshots()
  setSystemTime(new Date(Date.now() + 8 * 24 * 3600_000))
  expect(loadOverview()).toBeUndefined()
})

test('a chat keeps its last 40 messages and says there are more', () => {
  const items = Array.from({ length: 50 }, (_, i) => item.text(`m${i}`))
  saveChat('h:%1', { info: chatInfo({ title: 'T' }), items, hasMore: false })
  flushSnapshots()
  const kept = loadChat('h:%1')!
  expect(kept.items).toHaveLength(40)
  expect(kept.items[0]!.seq).toBe(items[10]!.seq)
  expect(kept.hasMore).toBe(true)
  expect(kept.info?.title).toBe('T')
})

test('only the last three chats stay', () => {
  for (const k of ['a', 'b', 'c', 'd']) {
    saveChat(k, { items: [item.text(k)], hasMore: false })
    flushSnapshots()
  }
  expect(loadChat('a')).toBeUndefined()
  expect(loadChat('b')).toBeDefined()
  expect(loadChat('d')).toBeDefined()
})

test('signing out clears everything', () => {
  saveOverview([host('a')])
  saveChat('k', { items: [item.text('x')], hasMore: false })
  flushSnapshots()
  clearSnapshots()
  expect(loadOverview()).toBeUndefined()
  expect(loadChat('k')).toBeUndefined()
})
