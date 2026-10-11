import { afterAll, expect, test } from 'bun:test'
import { kv } from './platform/store.ts'
import { registry } from './hosts/registry.ts'
import { saveEverything } from './core.ts'
import { saveDraftsAtOnce, setDraft } from './claude/drafts.ts'

afterAll(() => saveDraftsAtOnce(false))

const saved = () => kv.get<Record<string, { text: string }>>('drafts') ?? {}

test('a draft is written a moment later, or at once when the app or hub is about to close', () => {
  setDraft('box:%7', { text: 'half a thought', source: 'app', at: 1 })
  // typing writes on a short wait, not on every key
  expect(saved()['box:%7']).toBeUndefined()
  saveEverything()
  expect(saved()['box:%7']?.text).toBe('half a thought')
})

test('while the phone app is in the background every draft is written straight away', () => {
  saveDraftsAtOnce(true)
  setDraft('box:%8', { text: 'typed just before leaving', source: 'app', at: 2 })
  expect(saved()['box:%8']?.text).toBe('typed just before leaving')
  setDraft('box:%8', undefined)
  expect(saved()['box:%8']).toBeUndefined()
})

test("a machine's latest sessions are saved before closing, even inside the 15 s limit", () => {
  const hosts = (registry as any).hosts as Map<string, any>
  const config = { id: 'snap-test', name: 'snap', kind: 'ssh', target: 'me@x' }
  const sessions = [{ id: '$1', name: 'new one', attached: 0, windows: [] }]
  // saved a moment ago, before "new one" was started: the limit holds the newer look back
  hosts.set('snap-test', { host: { id: 'snap-test', config }, state: { config, status: 'online', sessions, agents: [], updatedAt: 1 }, savedSnapshot: '[]', savedAt: Date.now() })
  try {
    saveEverything()
    expect(kv.get<any>('snapshots/snap-test')?.sessions.map((s: any) => s.name)).toEqual(['new one'])
  } finally {
    hosts.delete('snap-test')
    kv.del('snapshots/snap-test')
  }
})
