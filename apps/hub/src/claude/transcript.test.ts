import { expect, test } from 'bun:test'
import { newMeta, normalize } from './transcript.ts'

test('queued messages leave the queue when Claude pulls them all back into the input box', () => {
  const meta = newMeta()
  const op = (operation: string, content?: string) => normalize({ type: 'queue-operation', operation, content, timestamp: '2026-10-10T10:00:00Z' } as any, meta)
  op('enqueue', 'first')
  op('enqueue', 'second')
  op('popAll', 'first\nsecond')
  expect(meta.queue).toEqual([])
  op('enqueue', 'first')
  op('remove', 'first')
  expect(meta.queue).toEqual([])
})
