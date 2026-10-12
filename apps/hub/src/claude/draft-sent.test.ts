import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import type { ServerMsg } from '@inyon/protocol'
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

test('finishing a send keeps a new draft typed meanwhile, even one that starts the same way', () => {
  const w = watchers.get('draft-test', '%9')
  const startedAt = Date.now() - 2000
  setDraft(KEY, { text: 'Fix', source: 'app', at: startedAt + 1 })
  w.draftSent('Fix the login bug', startedAt)
  expect(getDraft(KEY)?.text).toBe('Fix')
  // but the message itself, pushed just before the send and arriving after it began, goes
  setDraft(KEY, { text: 'Fix the login bug', source: 'app', at: startedAt + 1 })
  w.draftSent('Fix the login bug\n\nAttached files:\n/x/a.png', startedAt)
  expect(getDraft(KEY)).toBeUndefined()
})

test("emptying the box isn't undone by a screen read from before the terminal caught up", () => {
  const w = watchers.get('draft-test', '%9')
  const got: ServerMsg[] = []
  w.subscribe({ send: (m: ServerMsg) => got.push(m) })
  setDraft(KEY, { text: 'old text here', source: 'app', at: Date.now(), mirrored: 'old text here' })
  const read = (draft?: string) => {
    // a busy agent redraws all the time, so the screen is read again before the box is cleared
    Object.assign(w as any, { screen: { working: true, width: 120, inputVisible: true, draft }, mirroringUntil: 0, sendingUntil: 0 })
    ;(w as any).syncDraftFromScreen()
  }
  w.draftFromApp('')
  read('old text here')
  expect(getDraft(KEY)?.text ?? '').toBe('')
  expect(got.filter((m) => m.t === 'chat.draft' && m.source === 'terminal')).toEqual([])
  // once the terminal's box is empty too, nothing is left over
  read(undefined)
  expect(getDraft(KEY)).toBeUndefined()
  // and typing at the terminal is still picked up
  read('typed on the laptop')
  expect(getDraft(KEY)).toMatchObject({ text: 'typed on the laptop', source: 'terminal' })
})
