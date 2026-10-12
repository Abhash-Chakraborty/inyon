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

test("a message from another session leaves the queue once Claude takes it, though its tag changed", () => {
  const meta = newMeta()
  const op = (operation: string, content: string, extra = {}) => normalize({ type: 'queue-operation', operation, content, timestamp: '2026-10-12T04:36:35Z', ...extra } as any, meta)
  op('enqueue', '<cross-session-message from="uds:/run/user/1001/cc-socks/49259.sock" hop-chain="d6c7" from-name="custom-tmux-de" from-mode="bypass">\nAnswer: yes\n</cross-session-message>')
  expect(meta.queue.length).toBe(1)
  op('remove', '<cross-session-message from="uds:/run/user/1001/cc-socks/49259.sock" from-name="custom-tmux-de" from-mode="bypass" hop-chain="d6c7">\nAnswer: yes\n</cross-session-message>', { reason: 'absorbed_mid_turn' })
  expect(meta.queue).toEqual([])
})

test('a background subagent leaves the running tasks when it finishes', () => {
  const meta = newMeta()
  let n = 0
  const line = (e: object) => normalize({ uuid: `u${n++}`, timestamp: '2026-10-10T10:00:00Z', ...e } as any, meta)
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'Research Windows support', prompt: 'look', run_in_background: true } }] } })
  // what Claude Code writes while the agent works, then when it's done
  line({ type: 'attachment', attachment: { type: 'task_status', taskId: 'a624', taskType: 'local_agent', description: 'Research Windows support', status: 'running' } })
  expect(meta.tasks.get('a624')?.status).toBe('running')
  line({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>a624</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Agent "Research Windows support" completed</summary>\n</task-notification>' } })
  expect(meta.tasks.get('a624')?.status).toBe('completed')
  expect(meta.subagents.get('toolu_1')?.status).toBe('done')
})
