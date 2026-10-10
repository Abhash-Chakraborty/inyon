import { expect, test } from 'bun:test'
import { reconcile, type PendingMessage } from '../../../web/src/lib/pending.ts'
import type { ChatItem } from '@tether/protocol'

const at = Date.parse('2026-10-10T12:00:00Z')
const pending = (text: string, id = 'a'): PendingMessage => ({ id, text, status: 'failed', at })
const receipt = (text: string, offset = 0): ChatItem => ({ kind: 'user', text, images: 0, uuid: 'r', seq: 0, ts: new Date(at + offset).toISOString() })

test('old repeated text and shared 400-character prefixes do not discard recovery messages', () => {
  expect(reconcile([pending('hello')], [receipt('hello', -60_000)])).toHaveLength(1)
  expect(reconcile([pending('x'.repeat(400) + 'one')], [receipt('x'.repeat(400) + 'two')])).toHaveLength(1)
  expect(reconcile([pending('hello')], [receipt('hello')])).toHaveLength(0)
})
test('one transcript message confirms only one repeated send', () => {
  expect(reconcile([pending('hello'), pending('hello', 'b')], [receipt('hello')]).map((p) => p.id)).toEqual(['b'])
})

test('Codex image envelopes confirm the exact uploaded paths', () => {
  const sent = 'Please check these\n\nAttached files:\n/tmp/a.png\n/tmp/b.png'
  const delivered = '<image name=[Image #1] path="/tmp/a.png">\n</image>\n<image name=[Image #2] path="/tmp/b.png">\n</image>\nPlease check these\n\nAttached files:\n[Image #1]\n[Image #2]'
  expect(reconcile([pending(sent)], [receipt(delivered)])).toHaveLength(0)
  expect(reconcile([pending(sent.replace('/tmp/b.png', '/tmp/c.png'))], [receipt(delivered)])).toHaveLength(1)
  expect(reconcile([pending(sent)], [receipt(delivered, -60_000)])).toHaveLength(1)
})

test('native shell input confirms the corresponding ! command', () => {
  expect(reconcile([pending('!printf hello')], [{ ...receipt('printf hello'), shell: true } as ChatItem])).toHaveLength(0)
  expect(reconcile([pending('! printf hello')], [{ ...receipt('printf hello'), shell: true } as ChatItem])).toHaveLength(0)
  expect(reconcile([pending('!printf goodbye')], [{ ...receipt('printf hello'), shell: true } as ChatItem])).toHaveLength(1)
})
