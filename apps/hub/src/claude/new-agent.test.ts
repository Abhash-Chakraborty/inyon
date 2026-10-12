import { afterAll, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import type { ServerMsg } from '@inyon/protocol'
import { Host } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { TranscriptReader } from './transcript-tail.ts'
import { watchers } from './watcher.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())
const KEY = 'new-agent-test:%5'
afterAll(() => watchers.stop(KEY))

const host = new Host({ id: 'new-agent-test', name: 'Laptop', kind: 'local' } as any)
Object.assign(host, { exec: async () => ({ code: 0, stdout: '', stderr: '' }), stream: () => ({ kill() {}, exited: new Promise(() => {}) }) })
// Claude as it is right after starting: no transcript until something is said
let agent: Record<string, unknown> | undefined
const first = { kind: 'claude', pid: 100, startedAt: 1_000, state: 'idle' }
const second = { kind: 'claude', pid: 200, startedAt: 2_000, state: 'idle' }
spyOn(registry, 'get').mockReturnValue({ host, state: { status: 'online' } } as any)
spyOn(registry, 'host').mockReturnValue(host)
spyOn(registry, 'findPane').mockImplementation(() => ({ pane: { id: '%5', title: 'claude', width: 100, agent } }) as any)

const said = [
  { kind: 'user', seq: 1, uuid: 'u1', text: 'Hello' },
  { kind: 'assistant', seq: 2, uuid: 'a1', text: 'Hi Abhash, what are you working on today?' },
]
/** A chat on this pane showing the first Claude's conversation. */
function chatOfFirst() {
  agent = first
  const w = watchers.get('new-agent-test', '%5')
  Object.assign(w as any, { transcript: '/home/abhash/.claude/projects/x/old.jsonl', proc: '100:1000', reader: new TranscriptReader(400), olderFrom: 0, items: [...said], ready: true })
  return w
}
const texts = (w: unknown) => (w as any).items.map((i: any) => i.text)

beforeEach(() => {
  watchers.stop(KEY)
  ;(watchers as any).parked.delete(KEY)
})

test('a chat left open while Claude exits and starts again empties instead of showing the old conversation', () => {
  const w = chatOfFirst()
  const got: ServerMsg[] = []
  w.subscribe({ send: (m) => got.push(m) })
  // the same Claude, its transcript not known for a moment: nothing changes
  w.sync()
  expect(texts(w)).toEqual(['Hello', 'Hi Abhash, what are you working on today?'])
  // a new Claude in the pane, nothing said to it yet
  agent = second
  got.length = 0
  w.sync()
  expect(texts(w)).toEqual([])
  expect(got.filter((m) => m.t === 'chat.reset').map((m: any) => m.items)).toEqual([[]])
})

test('reopening the chat later shows the new Claude empty, from the saved copy as from a recently closed one', () => {
  for (const from of ['recently closed', 'saved copy']) {
    chatOfFirst().save()
    watchers.stop(KEY)
    if (from === 'saved copy') (watchers as any).parked.delete(KEY)
    agent = second
    expect([from, texts(watchers.get('new-agent-test', '%5'))]).toEqual([from, []])
    watchers.stop(KEY)
  }
})

test('the same Claude reopened still shows its conversation', () => {
  for (const from of ['recently closed', 'saved copy']) {
    chatOfFirst().save()
    watchers.stop(KEY)
    if (from === 'saved copy') (watchers as any).parked.delete(KEY)
    agent = first
    expect([from, texts(watchers.get('new-agent-test', '%5'))]).toEqual([from, ['Hello', 'Hi Abhash, what are you working on today?']])
    watchers.stop(KEY)
  }
})
