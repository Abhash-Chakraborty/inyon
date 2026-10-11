import { expect, test } from 'bun:test'
import { codexAccepted, inputContains, sameMessage, SendLedger } from './delivery.ts'
import { parseScreen } from './screen.ts'
import { draftRows } from './drafts.ts'
import { readFileSync } from 'node:fs'

test('missing composer and approval screens do not confirm delivery', () => {
  expect(codexAccepted({ width: 100, working: false }, 'hello')).toBe(false)
  expect(codexAccepted({ width: 100, working: false, model: 'GPT-6-Luna', prompt: { body: [], options: [], footer: '', multi: false } }, 'hello')).toBe(false)
  expect(codexAccepted({ width: 100, working: false, model: 'GPT-6-Luna', draft: 'hello' }, 'hello')).toBe(false)
  expect(codexAccepted({ width: 100, working: true, model: 'GPT-6-Luna' }, 'hello')).toBe(true)
})

test('unrelated or partial input is not enough to submit', () => {
  expect(inputContains('unrelated text of similar length', 'send this message')).toBe(false)
  expect(inputContains('this message', 'send this message')).toBe(false)
  expect(inputContains('send\nthis message', 'send this message')).toBe(true)
  // a paste preview hides its text: it's this message only when known to be (just typed, or mirrored)
  expect(inputContains('[Pasted text #1 +20 lines]', 'long message', true)).toBe(true)
  expect(inputContains('[Pasted text #1 +20 lines]', 'long message')).toBe(false)
  // leftovers of an older draft in front of the paste would be sent along with it
  expect(inputContains('Hey also for mobile I want [Pasted text #1 +20 lines]', 'long message')).toBe(false)
})

test('a long dictated line needs a clear for every row it wraps onto', () => {
  expect(draftRows('short', 100)).toBe(3)
  expect(draftRows('x'.repeat(640), 100)).toBe(Math.ceil(640 / 94) + 2)
  expect(draftRows('one\ntwo\n' + 'y'.repeat(300), 80)).toBe(1 + 1 + Math.ceil(300 / 74) + 2)
})

test('real Codex queue confirms only the queued message, despite another draft', () => {
  const capture = readFileSync(new URL('./fixtures/codex-queued.txt', import.meta.url), 'utf8')
  const screen = parseScreen(capture.split('\n'), 100, 'codex')
  expect(screen.working).toBe(true)
  expect(codexAccepted(screen, 'second message queued')).toBe(true)
  expect(codexAccepted(screen, 'different message')).toBe(false)
})

test('Antigravity identifies each permission mode, including returning to default', () => {
  const capture = (name: string) => parseScreen(readFileSync(new URL(`./fixtures/agy-${name}.txt`, import.meta.url), 'utf8').split('\n'), 150, 'antigravity')
  expect(capture('accept-edits').mode).toBe('accept-edits')
  expect(capture('plan').mode).toBe('plan')
  expect(capture('idle').mode).toBe('default')
  expect(parseScreen([], 150, 'antigravity').mode).toBeUndefined()
})

test('Codex image path conversion is recognized before submit and in its queue', () => {
  const text = 'Check this\n\nAttached files:\n/tmp/a.png\n/tmp/b.jpg\n/tmp/notes.txt'
  const rendered = 'Check this\n\nAttached files:\n[Image #1]\n[Image #2]\n/tmp/notes.txt'
  expect(inputContains(rendered, text)).toBe(true)
  expect(inputContains(rendered.replace('Check this', 'Different text'), text)).toBe(false)
  expect(inputContains(rendered.replace('[Image #2]', '[Image #3]'), text)).toBe(false)
  expect(inputContains(rendered.replace('/tmp/notes.txt', '/tmp/other.txt'), text)).toBe(false)
  expect(codexAccepted({ width: 100, working: true, model: 'GPT-6-Luna', draft: 'new draft', queue: [rendered] }, text)).toBe(true)
})

test('Codex collapsed content preserves the real draft and checks its size', async () => {
  const { hasPastePreview } = await import('./delivery.ts')
  const text = 'x'.repeat(1824)
  expect(hasPastePreview('[Pasted Content 1824 chars]')).toBe(true)
  expect(inputContains('[Pasted Content 1824 chars]', text, true)).toBe(true)
  expect(inputContains('[Pasted Content 1823 chars]', text, true)).toBe(false)
  expect(inputContains('[Pasted Content 1824 chars] extra', text, true)).toBe(false)
  // an older paste of the same length isn't this message unless it was just put there
  expect(inputContains('[Pasted Content 1824 chars]', text)).toBe(false)
  expect(hasPastePreview('[Pasted text #1 +20 lines]')).toBe(true)
})

test("an agent's record matches the sent message despite rewrapping, not a shorter draft", () => {
  const sent = "why can't I paste images? it says \"not supported\" really\n\nAttached files:\n/home/u/.tether/uploads/a.png"
  expect(sameMessage(`<pasted_content id="x">${sent.replace(/\n/g, ' ')}</pasted_content>`, sent)).toBe(true)
  expect(sameMessage(sent.replace(/"/g, '“'), sent)).toBe(true)
  // a draft mirrored before the last edits is a prefix, and must not count as the message
  expect(sameMessage("why can't I paste images? it says \"not supported\" real", sent)).toBe(false)
  // a very long message the transcript cut short still counts
  const long = 'word '.repeat(1000)
  expect(sameMessage(long.slice(0, 2500), long)).toBe(true)
})

const user = (uuid: string, text: string, extra: object = {}) => ({ kind: 'user', seq: 0, uuid, ts: '2026-10-11T03:00:00Z', text, images: 0, ...extra }) as any

test('the ledger matches a send to the first new record of it, never an older look-alike', () => {
  const ledger = new SendLedger()
  const items = [user('a', 'yes')]
  ledger.track('s1', 'yes', items)
  // the old "yes" was there before the send
  expect(ledger.match(items, [])).toBe(false)
  expect(ledger.get('s1')?.state).toBe('sending')
  // queued while the agent works, then taken into the conversation
  expect(ledger.match(items, ['yes'])).toBe(true)
  expect(ledger.get('s1')?.state).toBe('queued')
  items.push(user('b', 'yes', { queued: true }))
  ledger.match(items, [])
  expect(ledger.get('s1')).toMatchObject({ state: 'delivered', uuid: 'b' })
})

test('two identical sends claim two records, and a late record clears a failure', () => {
  const ledger = new SendLedger()
  const items: any[] = []
  ledger.track('s1', 'continue', items)
  ledger.track('s2', 'continue', items)
  items.push(user('x', 'continue'))
  ledger.match(items, [])
  expect(ledger.get('s1')).toMatchObject({ state: 'delivered', uuid: 'x' })
  expect(ledger.get('s2')?.state).toBe('sending')
  ledger.settle('s2', { state: 'failed', error: 'timed out' })
  items.push(user('y', 'continue'))
  ledger.match(items, [])
  expect(ledger.get('s2')).toEqual(expect.objectContaining({ state: 'delivered', uuid: 'y', error: undefined }))
  // and a timeout can't undo a delivery
  ledger.settle('s1', { state: 'sent' })
  expect(ledger.get('s1')?.state).toBe('delivered')
})

test('the ledger reads shell, slash and Codex image records as they were typed', () => {
  const ledger = new SendLedger()
  const items: any[] = []
  ledger.track('sh', '! ls -la', items)
  ledger.track('cmd', '/compact keep the tests', items)
  ledger.track('img', 'look at this\n\nAttached files:\n/tmp/t/a.png', items)
  items.push(user('1', 'ls -la', { shell: true }))
  items.push({ kind: 'command', seq: 1, uuid: '2', ts: '', name: 'compact', args: 'keep the tests' })
  items.push(user('3', 'look at this\n\nAttached files:\n[Image #1]<image name=[Image #1] path="/tmp/t/a.png">x</image>'))
  ledger.match(items, [])
  expect(ledger.list().map((s) => [s.id, s.state, s.uuid])).toEqual([['sh', 'delivered', '1'], ['cmd', 'delivered', '2'], ['img', 'delivered', '3']])
})

test('a brand-new transcript (first message of a conversation) still matches', () => {
  const ledger = new SendLedger()
  ledger.track('s1', 'hello there', [user('old', 'hello there')])
  // the watcher switched files: none of the new items were known
  ledger.match([user('new', 'hello there')], [])
  expect(ledger.get('s1')).toMatchObject({ state: 'delivered', uuid: 'new' })
})

test("a setting from the app's controls is followed like any send but marked, so no device shows it as a message", () => {
  const ledger = new SendLedger()
  ledger.track('m', '/model gpt-6.1-sol', [], true)
  ledger.track('t', 'hello', [])
  expect(ledger.list().map((s) => [s.id, s.setting ?? false])).toEqual([['m', true], ['t', false]])
})

test('before typing, a draft that differs only in spaces or line breaks is not the message', () => {
  expect(inputContains('print("A B")', 'print("AB")')).toBe(false)
  expect(inputContains('def f():\n    pass', 'def f(): pass')).toBe(true)
  // once typed, the terminal's wrapping may split a long word; that still counts
  expect(inputContains('https://example.com/a\n  very/long/path', 'https://example.com/avery/long/path', true)).toBe(true)
})
