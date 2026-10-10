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

test('a cleared goal is gone, not met; a met goal stays as the last one', () => {
  const meta = newMeta()
  let n = 0
  const goal = (a: object) => normalize({ type: 'attachment', uuid: `u${n++}`, timestamp: '2026-10-11T02:40:00Z', attachment: { type: 'goal_status', ...a } } as any, meta)
  // what Claude Code 2.1 writes for "/goal …", a failed check, then "/goal clear"
  expect(goal({ met: false, sentinel: true, condition: 'tests pass' })).toMatchObject([{ kind: 'goal', met: false, condition: 'tests pass' }])
  expect(goal({ met: false, condition: 'tests pass', reason: 'two still fail' })).toEqual([])
  expect(meta.goal).toMatchObject({ condition: 'tests pass', met: false })
  expect(goal({ met: true, sentinel: true, condition: 'tests pass' })).toMatchObject([{ kind: 'goal', cleared: true, met: false }])
  expect(meta.goal).toBeUndefined()
  // clearing when nothing is set adds nothing
  expect(goal({ met: true, sentinel: true, condition: 'tests pass' })).toEqual([])
  goal({ met: false, sentinel: true, condition: 'build is green' })
  expect(goal({ met: true, condition: 'build is green', reason: 'it is' })).toMatchObject([{ kind: 'goal', met: true }])
  expect(meta.goal).toMatchObject({ condition: 'build is green', met: true })
})
