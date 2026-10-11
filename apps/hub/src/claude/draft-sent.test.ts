import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import type { ServerMsg } from '@tether/protocol'
import { Host } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { getDraft, setDraft } from './drafts.ts'
import { watchers } from './watcher.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())
const KEY = 'draft-test:%9'
afterAll(() => {
  watchers.stop(KEY)
  setDraft(KEY, undefined)
})

test("a phone keyboard putting a sent message back in the box doesn't make it a draft again", () => {
  const config = { id: 'draft-test', name: 'Box', kind: 'local' as const }
  spyOn(registry, 'get').mockReturnValue({ host: new Host(config as any), state: { status: 'online' } } as any)
  spyOn(registry, 'host').mockReturnValue(new Host(config as any))
  spyOn(registry, 'findPane').mockReturnValue({ pane: { id: '%9', title: 'claude', agent: { kind: 'claude' } } } as any)
  const w = watchers.get('draft-test', '%9')
  const got: ServerMsg[] = []
  const phone = { send: (m: ServerMsg) => got.push(m) }
  w.subscribe(phone)

  w.draftFromApp('I see only problem when I send', phone)
  w.draftSent('I see only problem when I send', Date.now() - 1000)
  expect(getDraft(KEY)).toBeUndefined()

  // a moment later the keyboard puts the message (or its last word) back, and the app passes it on
  got.length = 0
  w.draftFromApp('I see only problem when I send', phone)
  w.draftFromApp('send', phone)
  expect(getDraft(KEY)).toBeUndefined()
  // and that app is told the box is empty, so its own copy clears too
  expect(got.filter((m) => m.t === 'chat.draft').map((m: any) => m.text)).toEqual(['', ''])

  // a new message is a draft as usual
  w.draftFromApp('and another thing', phone)
  expect(getDraft(KEY)?.text).toBe('and another thing')
})
