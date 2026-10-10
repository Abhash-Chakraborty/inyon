import { expect, test } from 'bun:test'
import { codexAccepted, inputContains } from './delivery.ts'
import { parseScreen } from './screen.ts'
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
  expect(inputContains('[Pasted text #1 +20 lines]', 'long message')).toBe(true)
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
  expect(inputContains('[Pasted Content 1824 chars]', text)).toBe(true)
  expect(inputContains('[Pasted Content 1823 chars]', text)).toBe(false)
  expect(inputContains('[Pasted Content 1824 chars] extra', text)).toBe(false)
  expect(hasPastePreview('[Pasted text #1 +20 lines]')).toBe(true)
})
