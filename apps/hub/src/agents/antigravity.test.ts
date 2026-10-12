import { describe, expect, test } from 'bun:test'
import { AntigravityDoc, agyStatus, mapAgyTool, userText } from './antigravity.ts'
import { newMeta } from '../claude/transcript.ts'

// Rows shaped like agy 1.3.3's transcript.jsonl (argument values are JSON-encoded strings)
const ROWS = [
  {
    step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-10-10T08:29:09Z',
    content: '<USER_REQUEST>\nRun `date +%Y` and tell me the output.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-10T13:59:09+05:30.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment on this change.\n</USER_SETTINGS_CHANGE>',
  },
  {
    step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-10T08:29:09Z', input_tokens: 11905, cache_read_tokens: 0, output_tokens: 231,
    thinking: 'Run it.',
    tool_calls: [{ name: 'run_command', args: { CommandLine: '"date +%Y"', Cwd: '"/w"', WaitMsBeforeAsync: '5000', toolAction: '"Running date"', toolSummary: '"Run date command"' } }],
  },
  { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-10-10T08:29:14Z', content: 'Created At: 2026-10-10T13:59:14+05:30\nCompleted At: 2026-10-10T13:59:27+05:30\n\nThe command exited with code 0.\nOutput:\n2026\r\n\n' },
  { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-10T08:29:27Z', input_tokens: 12226, content: 'It is 2026.' },
  { step_index: 4, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-10-10T08:30:00Z', content: '<USER_REQUEST>\nRun false\n</USER_REQUEST>' },
  { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-10T08:30:01Z', input_tokens: 12400, tool_calls: [{ name: 'run_command', args: { CommandLine: '"false"' } }] },
  { step_index: 6, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-10-10T08:30:02Z', content: '<SYSTEM_MESSAGE>server restart</SYSTEM_MESSAGE>' },
  { step_index: 7, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-10-10T08:30:03Z', content: 'Created At: x\nCompleted At: y\n\nThe command exited with code 1.\nOutput:\n' },
]

describe('AntigravityDoc', () => {
  test('turns a transcript into chat items', () => {
    const doc = new AntigravityDoc()
    for (const r of ROWS) doc.apply(r)
    const meta = newMeta()
    const items = doc.items(meta)
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'assistant', 'tool_result', 'assistant', 'user', 'assistant', 'tool_result'])
    expect(items[0]).toMatchObject({ kind: 'user', text: 'Run `date +%Y` and tell me the output.' })
    expect(items[1]).toMatchObject({ block: { type: 'thinking', text: 'Run it.' } })
    expect(items[2]).toMatchObject({ block: { type: 'tool_use', id: 's1:0', name: 'Bash', input: { command: 'date +%Y', description: 'Run date command', cwd: '/w' } } })
    expect(items[3]).toMatchObject({ toolUseId: 's1:0', isError: false, text: 'The command exited with code 0.\nOutput:\n2026', meta: { stdout: '2026' } })
    // the system notice in between doesn't take the result's place
    expect(items[7]).toMatchObject({ toolUseId: 's5:0', isError: true })
    expect(items.map((i) => i.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(meta.model).toBe('Gemini 3.8 Flash (High)')
    expect(meta.stats.contextTokens).toBe(12400)
    expect(meta.stats.turns).toBe(1)
    expect(meta.stats.startedAt).toBe('2026-10-10T08:29:09.000Z')
  })

  test('a step written again replaces the earlier copy', () => {
    const doc = new AntigravityDoc()
    doc.apply({ step_index: 0, type: 'PLANNER_RESPONSE', content: 'Draft' })
    doc.apply({ step_index: 0, type: 'PLANNER_RESPONSE', content: 'Final' })
    expect(doc.items(newMeta())).toMatchObject([{ block: { type: 'text', text: 'Final' } }])
  })

  test('/goal opens a goal and the GOAL_COMPLETE marker closes it', () => {
    const doc = new AntigravityDoc()
    doc.apply({ step_index: 0, type: 'USER_INPUT', created_at: 't0', content: '<USER_REQUEST>\n/goal Reply with ready\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>' })
    const meta = newMeta()
    expect(doc.items(meta).map((i) => i.kind)).toEqual(['goal'])
    expect(meta.goal).toMatchObject({ condition: 'Reply with ready', met: false })
    doc.apply({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: 't1', input_tokens: 10, content: 'ready\n<!-- GOAL_COMPLETE -->' })
    const items = doc.items(meta)
    expect(items.map((i) => i.kind)).toEqual(['goal', 'assistant', 'goal'])
    expect((items[1] as any).block.text).toBe('ready')
    expect(meta.goal?.met).toBe(true)
  })

  test('a backgrounded command becomes a task, finished by the system message', () => {
    const doc = new AntigravityDoc()
    doc.apply({ step_index: 0, type: 'PLANNER_RESPONSE', created_at: 't0', tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 20; echo hi"', toolSummary: '"Sleep and echo"' } }] })
    doc.apply({ step_index: 1, type: 'GENERIC', status: 'RUNNING', created_at: 't1', content: 'Created At: x\nTool is running as a background task with task id: conv/task-2\nTask Description: sleep 20; echo hi\nTask logs are available at: file:///h/.gemini/antigravity-cli/brain/conv/.system_generated/tasks/task-2.log\nYOU MUST…' })
    const meta = newMeta()
    doc.items(meta)
    expect(meta.tasks.get('conv/task-2')).toMatchObject({ status: 'running', description: 'Sleep and echo', command: 'sleep 20; echo hi', outputFile: '/h/.gemini/antigravity-cli/brain/conv/.system_generated/tasks/task-2.log' })
    doc.apply({ step_index: 2, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: 't2', content: '<SYSTEM_MESSAGE>\n[Message] content=Task id "conv/task-2" finished with result:\n\nThe command exited with code 0.\nOutput:\nhi\r\n\n\nLog: file:///x.log\n</SYSTEM_MESSAGE>' })
    const items = doc.items(meta)
    expect(meta.tasks.get('conv/task-2')).toMatchObject({ status: 'completed', summary: 'The command exited with code 0.\nOutput:\nhi' })
    expect(items.at(-1)).toMatchObject({ kind: 'notice', subtype: 'task' })
  })

  test('tool names map to the rows Inyon knows', () => {
    expect(mapAgyTool('view_file', { AbsolutePath: '"/a.ts"' })).toEqual({ name: 'Read', input: { file_path: '/a.ts' } })
    expect(mapAgyTool('write_to_file', { TargetFile: '"/b"', CodeContent: '"hi\\n"', Overwrite: 'true' }).input).toEqual({ file_path: '/b', content: 'hi\n' })
    expect(mapAgyTool('replace_file_content', { TargetFile: '"/c"', TargetContent: '"a"', ReplacementContent: '"b"' })).toMatchObject({ name: 'Edit', input: { old_string: 'a', new_string: 'b' } })
    expect(mapAgyTool('mystery_tool', { Foo: '1', toolAction: '"x"' })).toEqual({ name: 'mystery_tool', input: { Foo: 1 } })
    expect(userText('plain text')).toBe('plain text')
  })
})

describe('agyStatus', () => {
  test('current CLI cycle_mode beats legacy execution_mode, including returning to default', () => {
    const pr = { agyIntegration: 'installed' as const, agyStatus: new Map([['%7', { ts: 1000, data: { cycle_mode: 'default', execution_mode: 'PLAN' } }]]) }
    expect(agyStatus(pr, '%7', 990)?.mode).toBe('default')
    pr.agyStatus.get('%7')!.data.cycle_mode = 'accept-edits'
    expect(agyStatus(pr, '%7', 990)?.mode).toBe('accept-edits')
    expect(agyStatus({ ...pr, agyIntegration: 'missing' }, '%7', 990)).toBeUndefined()
  })
  const payload = {
    conversation_id: 'c1', conversation_title: 'Fix the parser', version: '1.3.3', agent_state: 'idle', plan_tier: 'Google AI Pro',
    model: { id: 'gemini-3.8-flash-high', display_name: 'Gemini 3.8 Flash (High)', effort: 'high' },
    context_window: { total_input_tokens: 15077, total_output_tokens: 55, context_window_size: 1048576, used_percentage: 1.4 },
    quota: {
      'gemini-5h': { remaining_fraction: 0.75, reset_time: '2026-10-10T12:00:00Z' },
      'gemini-weekly': { remaining_fraction: 0.9, reset_time: '2026-10-14T00:00:00Z' },
      '3p-5h': { remaining_fraction: 0.1 },
    },
    pending_input_count: 1, tool_confirmation_pending: false, execution_mode: 'ACCEPT_EDITS',
  }
  const pr = (ts: number) => ({ agyStatus: new Map([['%7', { ts, data: payload }]]) })

  test('maps the status line payload', () => {
    const st = agyStatus(pr(1000), '%7', 990, 'c1')!
    expect(st).toMatchObject({ model: 'Gemini 3.8 Flash', modelId: 'gemini-3.8-flash-high', effort: 'high', contextPct: 1.4, contextUsed: 15077, contextSize: 1048576, plan: 'Google AI Pro', title: 'Fix the parser', queued: 1, mode: 'accept-edits' })
    expect(st.fiveHour?.pct).toBeCloseTo(25)
    expect(st.fiveHour?.resetsAt).toBe(Date.parse('2026-10-10T12:00:00Z') / 1000)
    expect(st.sevenDay?.pct).toBeCloseTo(10)
  })

  test('ignores a payload from before the process started, or for another conversation', () => {
    expect(agyStatus(pr(900), '%7', 990, 'c1')).toBeUndefined()
    expect(agyStatus(pr(1000), '%7', 990, 'other')).toBeUndefined()
  })
})
