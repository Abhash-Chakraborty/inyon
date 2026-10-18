import { describe, expect, test } from 'bun:test'
import { codexHistory, codexPermission, codexScript, codexTitle, normalizeCodex, pickCodexRollout, scriptSteps, unifiedHunks } from './codex.ts'
import { newMeta } from '../claude/transcript.ts'
import { parseCodexModels } from './codex-models.ts'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../hosts/host.ts'

test('Codex permission presets are read from current and legacy settings', () => {
  expect(codexPermission({ permission_profile: { type: 'disabled' } })).toBe('full-access')
  expect(codexPermission({ approvals_reviewer: 'auto_review' })).toBe('auto-review')
  expect(codexPermission({ permission_profile: { type: 'managed', file_system: { entries: [{ access: 'read' }] } } })).toBe('read-only')
  expect(codexPermission({ permission_profile: { type: 'managed', file_system: { entries: [{ access: 'write' }] } } })).toBe('default')
  expect(codexPermission({ thread_settings: { sandbox_policy: { type: 'read-only' } } })).toBe('read-only')
  expect(codexPermission({})).toBeUndefined()
})

describe('codex exec scripts', () => {
  test('one shell command reads as Bash', () => {
    const code = 'const r = await tools.exec_command({cmd:"curl -sI https://example.com | head -1", yield_time_ms:30000});\ntext(r.output);\n'
    expect(codexScript(code)).toEqual({ name: 'Bash', input: { command: 'curl -sI https://example.com | head -1' } })
  })

  test('a patch held in a variable reads as ApplyPatch', () => {
    const code = 'const p = "*** Begin Patch\\n*** Update File: calc.py\\n@@\\n+def subtract(a, b):\\n*** End Patch";\ntext(await tools.apply_patch(p));\n'
    expect(codexScript(code)).toEqual({ name: 'ApplyPatch', input: { patch: '*** Begin Patch\n*** Update File: calc.py\n@@\n+def subtract(a, b):\n*** End Patch' } })
  })

  test('mixed calls show the script', () => {
    const code = 'await tools.exec_command({cmd:"ls"}); await tools.view_image({path:"a.png"})'
    expect(codexScript(code).name).toBe('Script')
  })

  test('script output drops the header and reads the exit code', () => {
    const meta = newMeta()
    const out = (texts: string[]) =>
      normalizeCodex({ type: 'response_item', timestamp: 't', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: texts.map((text) => ({ type: 'input_text', text })) } }, meta)[0] as any
    const ok = out(['Script completed\nWall time 0.1 seconds\nOutput:\n', 'HTTP/2 200\n', 'exit_code=0'])
    expect(ok.text).toBe('HTTP/2 200')
    expect(ok.isError).toBe(false)
    const bad = out(['Script completed\nWall time 0.1 seconds\nOutput:\n', 'curl: (6) Could not resolve host\n', 'exit_code=6'])
    expect(bad.isError).toBe(true)
    expect(bad.text).toBe('curl: (6) Could not resolve host')
  })
})

describe('codex terminal title', () => {
  test('keeps the thread name', () => {
    expect(codexTitle('[!] Action Required | Use gpt-6-luna high | codex', '/tmp/qa/codex')).toBe('Use gpt-6-luna high')
    expect(codexTitle('Respond to greeting | custom-tmux', '/home/u/custom-tmux')).toBe('Respond to greeting')
    expect(codexTitle('⠋ Working | Fix the parser | app', '/src/app')).toBe('Fix the parser')
  })
  test('no thread name yet is no title', () => {
    expect(codexTitle('codex', '/src/app')).toBe('')
    expect(codexTitle('app', '/src/app')).toBe('')
  })
})

describe('codex goals', () => {
  test('set from the goal event, met from update_goal output; the bookkeeping call is hidden', () => {
    const meta = newMeta()
    const goal = { objective: 'Create goal.txt', status: 'active' }
    const set = normalizeCodex({ type: 'event_msg', timestamp: 't1', payload: { type: 'thread_goal_updated', goal } }, meta)
    expect(set).toMatchObject([{ kind: 'goal', condition: 'Create goal.txt', met: false }])
    const call = normalizeCodex({ type: 'response_item', timestamp: 't2', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'g', input: 'text(await tools.update_goal({status:"complete"}));\n' } }, meta)
    expect(call).toEqual([])
    const out = [{ type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' }, { type: 'input_text', text: JSON.stringify({ goal: { ...goal, status: 'complete' } }) }]
    const met = normalizeCodex({ type: 'response_item', timestamp: 't3', payload: { type: 'custom_tool_call_output', call_id: 'g', output: out } }, meta)
    expect(met).toMatchObject([{ kind: 'goal', condition: 'Create goal.txt', met: true }])
    expect(meta.goal).toMatchObject({ condition: 'Create goal.txt', met: true })
  })

  test("Codex's internal goal context is not a user message", () => {
    const text = '<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n</codex_internal_context>'
    expect(normalizeCodex({ type: 'response_item', timestamp: 't', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }, newMeta())).toEqual([])
  })
})

describe('codex file changes', () => {
  test('the reported diff becomes the patch result', () => {
    expect(unifiedHunks('@@ -2 +2,5 @@\n     return a + b\n+\n+\n+def subtract(a, b):\n+    return a - b\n')).toEqual([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 5, lines: ['     return a + b', '+', '+', '+def subtract(a, b):', '+    return a - b'] },
    ])
    const meta = newMeta()
    const ev = (payload: any) => normalizeCodex({ type: payload.type === 'item_completed' ? 'event_msg' : 'response_item', timestamp: 't', payload }, meta)
    ev({ type: 'custom_tool_call', name: 'exec', call_id: 'p1', input: 'const p = "*** Begin Patch\\n*** Update File: a.py\\n@@\\n+x\\n*** End Patch";\ntext(await tools.apply_patch(p));' })
    ev({ type: 'item_completed', item: { type: 'FileChange', changes: { '/w/a.py': { type: 'update', unified_diff: '@@ -1 +1,2 @@\n a\n+x\n' } } } })
    const [r] = ev({ type: 'custom_tool_call_output', call_id: 'p1', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: '{}' }] }) as any[]
    expect(r.meta.patch).toEqual([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+x'] }])
  })
})

describe('codex rollout matching', () => {
  const row = (id: string, created: number, mtime: number, cwd = '/w') => ({ path: `/s/rollout-${id}.jsonl`, id, cwd, created, mtime })
  const none = new Map<string, string>()

  test('two sessions in one folder each keep their own thread', () => {
    const a = { pid: 1, cwd: '/w', startedAt: 100 }
    const b = { pid: 2, cwd: '/w', startedAt: 200 }
    // A's thread was written most recently, B's was created after B started
    const rows = [row('ta', 101, 500), row('tb', 201, 400)]
    expect(pickCodexRollout(rows, a, [a, b], none)).toBe('/s/rollout-ta.jsonl')
    expect(pickCodexRollout(rows, b, [a, b], none)).toBe('/s/rollout-tb.jsonl')
  })

  test('a thread picked with /resume is found by the name Codex shows', () => {
    const a = { pid: 1, cwd: '/w', startedAt: 1000 }
    const b = { pid: 2, cwd: '/w', startedAt: 1100 }
    const names = new Map([['greet', 'Respond to greeting']])
    // made two days earlier, written again since this Codex started
    const rows = [row('greet', 100, 1200), row('other', 150, 1150)]
    expect(pickCodexRollout(rows, { ...a, title: 'Respond to greeting' }, [a], names)).toBe('/s/rollout-greet.jsonl')
    expect(pickCodexRollout(rows, { ...a, title: 'Respond to greeting' }, [a, b], names)).toBe('/s/rollout-greet.jsonl')
    // without the name it can't be told from a thread another Codex is writing
    expect(pickCodexRollout(rows, a, [a], none)).toBeUndefined()
  })

  test('/new in a lone session moves to the new thread', () => {
    const a = { pid: 1, cwd: '/w', startedAt: 100 }
    expect(pickCodexRollout([row('old', 101, 300), row('new', 400, 450)], a, [a], none)).toBe('/s/rollout-new.jsonl')
  })

  test('the thread name in the title settles it; a resume id beats everything', () => {
    const a = { pid: 1, cwd: '/w', startedAt: 100, title: 'Fix parser | w' }
    const b = { pid: 2, cwd: '/w', startedAt: 200 }
    const rows = [row('ta', 101, 300), row('tb', 201, 400)]
    // A ran /new after B started: only the name says which thread is A's
    const later = [...rows, row('ta2', 250, 500)]
    expect(pickCodexRollout(later, a, [a, b], new Map([['ta2', 'Fix parser']]))).toBe('/s/rollout-ta2.jsonl')
    expect(pickCodexRollout(rows, { ...b, resume: 'ta' }, [a, b], none)).toBe('/s/rollout-ta.jsonl')
  })

  test('other folders and threads from before the process started are ignored', () => {
    const a = { pid: 1, cwd: '/w', startedAt: 100 }
    expect(pickCodexRollout([row('x', 101, 900, '/elsewhere'), row('old', 50, 800)], a, [a], none)).toBeUndefined()
  })
})

test('the model list comes from Codex\'s cache, without hidden models', () => {
  const cache = JSON.stringify({ models: [
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.', visibility: 'list', context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }], default_reasoning_level: 'low' },
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
  ] })
  expect(parseCodexModels(cache)).toEqual([{ id: 'gpt-6-luna', label: 'GPT-6-Luna', note: 'Fast and affordable model for easier tasks', context: 272000, efforts: ['low', 'max'], defaultEffort: 'low' }])
})

test('a rewound Codex thread replays the kept part of each earlier segment, oldest first', async () => {
  const day = join(mkdtempSync(join(tmpdir(), 'codex-')), 'sessions/2026/10/10')
  mkdirSync(day, { recursive: true })
  const thread = '01a1255b-fbc5-7371-ab05-ee0aa808a95d'
  const seg1 = '01a1258a-bf79-74b3-aa15-73114039987c'
  const seg2 = '01a12590-2495-7421-bf23-e68d82d406bc'
  const line = (n: string, extra = {}) => JSON.stringify({ type: 'event_msg', payload: { n }, ...extra }) + '\n'
  const meta = (id: string, offset: number) => line('meta', { history_base: { thread_id: id, end_ordinal_exclusive: 1, end_byte_offset: offset } })
  const first = line('a') + line('b')
  writeFileSync(join(day, `rollout-2026-10-10T15-59-07-${thread}.jsonl`), first + line('dropped'))
  const second = meta(thread, first.length) + line('c')
  writeFileSync(join(day, `rollout-2026-10-10T16-50-12-${thread}_${seg1}.jsonl`), second + line('dropped too'))
  const last = join(day, `rollout-2026-10-10T16-56-05-${thread}_${seg2}.jsonl`)
  writeFileSync(last, meta(seg1, second.length) + line('d'))
  const host = new Host({ id: 'local', kind: 'local' } as any)
  const kept = (await codexHistory(host, last)).map((l) => JSON.parse(l).payload.n)
  expect(kept).toEqual(['a', 'b', 'meta', 'c'])
})

test('completed Codex patches accumulate session lines once; failed patches do not', () => {
  const meta = newMeta()
  const event = (id: string, status = 'completed') => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id, status, changes: { '/tmp/a': { type: 'update', unified_diff: '@@ -1,2 +1,3 @@\n same\n-old\n+new\n+extra\n' } } } } })
  normalizeCodex(event('a'), meta)
  normalizeCodex(event('a'), meta)
  normalizeCodex(event('b', 'failed'), meta)
  expect(meta.stats).toMatchObject({ linesAdded: 2, linesRemoved: 1 })
  normalizeCodex(event('c'), meta)
  expect(meta.stats).toMatchObject({ linesAdded: 4, linesRemoved: 2 })
})

test('Codex default and nested explicit reasoning effort are preserved', () => {
  const meta = newMeta()
  normalizeCodex({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', collaboration_mode: { settings: { reasoning_effort: 'high' } } } }, meta)
  expect(meta.effort).toBe('high')
  normalizeCodex({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', collaboration_mode: { settings: { reasoning_effort: null } } } }, meta)
  expect(meta.effort).toBe('default')
})

test('Codex weekly-only primary quota is not labeled a five-hour window', async () => {
  const { statusFromCodex } = await import('./status.ts')
  const status = statusFromCodex({ rate_limits: { primary: { used_percent: 64, window_minutes: 10080, resets_at: 1791956344 }, secondary: null } }, {}, Date.now())
  expect(status.fiveHour).toBeUndefined()
  expect(status.sevenDay).toEqual({ pct: 64, resetsAt: 1791956344 })
  const both = statusFromCodex({ rate_limits: { primary: { used_percent: 10, window_minutes: 300 }, secondary: { used_percent: 20, window_minutes: 10080 } } }, {}, Date.now())
  expect(both.fiveHour?.pct).toBe(10)
  expect(both.sevenDay?.pct).toBe(20)
})

test('direct shell commands render input and output without an assistant turn', () => {
  const rows = normalizeCodex({ type: 'event_msg', timestamp: '2026-10-10T12:00:00Z', payload: { type: 'item_completed', item: { type: 'CommandExecution', source: 'user_shell', command: ['/bin/sh', '-lc', 'printf hello'], aggregated_output: 'hello' } } }, newMeta())
  expect(rows[0]).toMatchObject({ kind: 'user', text: 'printf hello', shell: true })
  expect(rows[1]).toMatchObject({ kind: 'command', name: '!', output: 'hello' })
})

// Records from a Codex 0.162.1 thread (its app-server 0.163.0 writes the rollout), paths shortened.
const rec = (type: string, payload: any, timestamp = '2026-10-17T17:00:30.000Z') => ({ timestamp, type, payload })
const item = (item: any) => rec('event_msg', { type: 'item_completed', thread_id: 't', turn_id: 'turn-1', item })

describe('codex records keep their own ids', () => {
  test("a reply's item id is the app-server's, so a live copy can be matched to it", () => {
    const meta = newMeta()
    const [a] = normalizeCodex(rec('response_item', { type: 'message', status: 'completed', id: 'msg_05b5d60b8898bebc016ad3a9afaa7c81919a0a99b324450b29', role: 'assistant', content: [{ type: 'output_text', text: 'Hi again!' }], phase: 'final_answer' }), meta) as any[]
    expect(a.uuid).toBe('msg_05b5d60b8898bebc016ad3a9afaa7c81919a0a99b324450b29')
    expect(a.msgId).toBe(a.uuid)
    const [r] = normalizeCodex(rec('response_item', { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Thinking it over' }] }), meta) as any[]
    expect(r.uuid).toBe('rs_1')
    expect(r.block).toEqual({ type: 'thinking', text: 'Thinking it over' })
  })
})

describe('codex turns', () => {
  test('task_started marks the turn under way; task_complete ends it with its duration', () => {
    const meta = newMeta()
    expect(normalizeCodex(rec('event_msg', { type: 'task_started', turn_id: 'turn-1', started_at: 1792256430, model_context_window: 258400 }), meta)).toEqual([])
    expect(meta.turn).toEqual({ id: 'turn-1', startedAt: 1792256430000 })
    const out = normalizeCodex(rec('event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'Hi again!', started_at: 1792256430, completed_at: 1792256431, duration_ms: 1239, time_to_first_token_ms: 1104 }), meta)
    expect(out).toMatchObject([{ kind: 'turn_end', durationMs: 1239 }])
    expect(meta.turn).toBeUndefined()
    expect(meta.stats.turns).toBe(1)
  })

  test('a turn that ends with an error says so', () => {
    const meta = newMeta()
    const out = normalizeCodex(rec('event_msg', { type: 'task_complete', turn_id: 't', duration_ms: 50, error: { message: 'Rate limit reached' } }), meta)
    expect(out).toMatchObject([{ kind: 'notice', level: 'error', text: 'Rate limit reached' }, { kind: 'turn_end', durationMs: 50 }])
  })

  test('an interrupted turn is over too', () => {
    const meta = newMeta()
    normalizeCodex(rec('event_msg', { type: 'task_started', turn_id: 't', started_at: 1 }), meta)
    expect(normalizeCodex(rec('event_msg', { type: 'turn_aborted', turn_id: 't' }), meta)).toMatchObject([{ kind: 'notice', subtype: 'interrupted' }])
    expect(meta.turn).toBeUndefined()
  })
})

describe('codex questions', () => {
  test('request_user_input_async becomes a question card; the reply answers it instead of showing as a bubble', () => {
    const meta = newMeta()
    const call = normalizeCodex(rec('response_item', { type: 'function_call', status: 'completed', id: 'fc_q', name: 'request_user_input_async', arguments: '{"questions":[{"title":"Colour","options":["Red","Blue"]}]}', call_id: 'call_32ce' }), meta) as any[]
    expect(call[0].block).toEqual({ type: 'tool_use', id: 'call_32ce', name: 'AskUserQuestion', input: { questions: [{ id: undefined, header: undefined, question: 'Colour', options: [{ label: 'Red' }, { label: 'Blue' }], isOther: undefined }] } })
    // the async form only acknowledges here
    expect(normalizeCodex(rec('response_item', { type: 'function_call_output', id: 'fco_q', call_id: 'call_32ce', output: '{"accepted":true}' }), meta)).toEqual([])
    // Codex sleeps until the answer; nothing to show for that
    expect(normalizeCodex(rec('response_item', { type: 'function_call', id: 'fc_s', name: 'sleep', namespace: 'clock', arguments: '{"duration_ms":3600000}', call_id: 'call_548b' }), meta)).toEqual([])
    expect(normalizeCodex(rec('response_item', { type: 'function_call_output', id: 'fco_s', call_id: 'call_548b', output: '{}' }), meta)).toEqual([])
    const reply = '<send_user_message_question_reply>\n[{"answer":"Red","question":"Colour","questionItemId":"[\\"request_user_input_async\\",\\"call_32ce\\",0]"}]\n</send_user_message_question_reply>'
    const out = normalizeCodex(rec('response_item', { type: 'message', id: 'msg_reply', role: 'user', content: [{ type: 'input_text', text: reply }] }), meta) as any[]
    expect(out).toMatchObject([{ kind: 'tool_result', toolUseId: 'call_32ce', isError: false, text: 'Colour: Red', meta: { answers: { Colour: 'Red' } } }])
  })

  test('the blocking request_user_input gets its answers from the tool output', () => {
    const meta = newMeta()
    normalizeCodex(rec('response_item', { type: 'function_call', id: 'fc', name: 'request_user_input', arguments: JSON.stringify({ questions: [{ id: 'q1', header: 'Scope', question: 'Which files?', options: [{ label: 'All', description: 'Every file' }, { label: 'Some', description: '' }], isOther: true }] }), call_id: 'call_b' }), meta)
    const [r] = normalizeCodex(rec('response_item', { type: 'function_call_output', id: 'fco', call_id: 'call_b', output: JSON.stringify({ answers: { q1: { answers: ['All'] } } }) }), meta) as any[]
    expect(r).toMatchObject({ kind: 'tool_result', toolUseId: 'call_b', text: 'Which files?: All', meta: { answers: { 'Which files?': 'All' } } })
  })
})

describe('codex plans', () => {
  test('a proposed plan is a plan card, not a tagged message', () => {
    const meta = newMeta()
    const text = '<proposed_plan>\n## Add a Folder File List to README\n\n### Steps\n1. Add a section.\n</proposed_plan>'
    const [a] = normalizeCodex(rec('response_item', { type: 'message', id: 'msg_plan', role: 'assistant', content: [{ type: 'output_text', text }], phase: 'final_answer' }), meta) as any[]
    expect(a.block).toEqual({ type: 'tool_use', id: 'msg_plan', name: 'ExitPlanMode', input: { plan: '## Add a Folder File List to README\n\n### Steps\n1. Add a section.' } })
    expect(normalizeCodex(item({ type: 'Plan', id: 'turn-1-plan', text: '## Add…' }), meta)).toEqual([])
  })
})

describe('codex scripts with several steps', () => {
  const patchScript = 'const r = await tools.apply_patch("*** Begin Patch\\n*** Update File: notes2.txt\\n@@\\n three\\n+four\\n*** End Patch");\ntext(r);\n'

  test('a patch followed by a command reads as a script with both steps', () => {
    const code = 'const r = await tools.apply_patch("*** Begin Patch\\n*** Add File: a.txt\\n+a\\n*** End Patch");\nconst t = await tools.exec_command({cmd:"bun test", yield_time_ms: 30000});\ntext(r + t.output);\n'
    const s = codexScript(code)
    expect(s.name).toBe('Script')
    expect(s.input.steps).toEqual([{ tool: 'apply_patch', arg: '*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch' }, { tool: 'exec_command', arg: 'bun test' }])
    expect(scriptSteps('await tools.view_image({path:"shot.png"}); await tools.write_stdin({session_id: 3, chars: "y\\n"}); tools.mystery(42)')).toEqual([
      { tool: 'view_image', arg: 'shot.png' }, { tool: 'write_stdin', arg: 'y\n' }, { tool: 'mystery' },
    ])
  })

  test('the diffs Codex reported go with the script output, whatever the script was', () => {
    const meta = newMeta()
    const ev = (payload: any) => normalizeCodex(rec(payload.type === 'item_completed' ? 'event_msg' : 'response_item', payload), meta)
    ev({ type: 'custom_tool_call', id: 'ctc_1', name: 'exec', call_id: 'call_1', input: 'await tools.apply_patch("*** Begin Patch\\n*** Add File: a.txt\\n+a\\n*** End Patch"); const t = await tools.exec_command({cmd:"cat a.txt"}); text(t.output)' })
    ev({ type: 'item_completed', item: { type: 'FileChange', id: 'exec-1', status: 'completed', changes: { '/w/a.txt': { type: 'add', content: 'a\n' } } } })
    const [r] = ev({ type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_1', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: 'a\n' }] }) as any[]
    expect(r).toMatchObject({ kind: 'tool_result', toolUseId: 'call_1', text: 'a', meta: { patch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+a'] }] } })
    expect(meta.stats).toMatchObject({ linesAdded: 1 })
  })

  test('a script still running when it answers is finished by the wait that reads its cell', () => {
    const meta = newMeta()
    const ev = (payload: any) => normalizeCodex(rec(payload.type === 'item_completed' ? 'event_msg' : 'response_item', payload), meta)
    const [call] = ev({ type: 'custom_tool_call', id: 'ctc_2', name: 'exec', call_id: 'call_361a', input: patchScript }) as any[]
    expect(call.block.name).toBe('ApplyPatch')
    // approval pending: the script hasn't finished when its output line is written
    expect(ev({ type: 'custom_tool_call_output', id: 'ctco_2', call_id: 'call_361a', output: 'Script running with cell ID 8\nWall time 31.0 seconds\nOutput:\n' })).toEqual([])
    ev({ type: 'item_completed', item: { type: 'FileChange', id: 'exec-65b8', status: 'completed', changes: { '/w/notes2.txt': { type: 'update', unified_diff: '@@ -3 +3,2 @@\n three\n+four\n' } } } })
    expect(ev({ type: 'function_call', id: 'fc_w', name: 'wait', arguments: '{"cell_id":"8","yield_time_ms":30000}', call_id: 'call_6f1b' })).toEqual([])
    const [r] = ev({ type: 'function_call_output', id: 'fco_w', call_id: 'call_6f1b', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' }, { type: 'input_text', text: '{}' }] }) as any[]
    expect(r).toMatchObject({ kind: 'tool_result', toolUseId: 'call_361a', isError: false, meta: { patch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: [' three', '+four'] }] } })
  })
})

describe('codex sub-agents', () => {
  test('spawn, activity and the message back are listed and shown', () => {
    const meta = newMeta()
    const child = '01a14ae4-8cfb-7252-9639-34db58c5b1c9'
    const [spawn] = normalizeCodex(rec('response_item', { type: 'function_call', id: 'fc_sp', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ task_name: 'pong_only', fork_turns: 'none', message: 'gAAAAABq068-Nm8JQY-ZkjyflSH4UWwPULkZEMWxdyRXFnUiFRmABLWf1b6hvrb0teOqmIUvFkNCnPPueIaAwrY0rDoGQAJOJRibh9YvCePKmuJ6r4-0D9gnde95yS1FOYTePwmC4qncvLXGKrdZ4KKNUfiT0kAmjj7R9rrlwj0Gaxj4l-qbXA8=' }), call_id: 'call_2d3' }), meta) as any[]
    expect(spawn.block).toMatchObject({ type: 'tool_use', id: 'call_2d3', name: 'spawn_agent', input: { task_name: 'pong_only', message: '[encrypted]' } })
    normalizeCodex(item({ type: 'SubAgentActivity', model: 'gpt-6-luna', id: 'call_2d3', kind: 'started', agent_thread_id: child, agent_path: '/root/pong_only' }), meta)
    expect([...meta.subagents.values()]).toMatchObject([{ toolUseId: child, type: 'codex', description: 'pong_only', status: 'running' }])
    const [waited] = normalizeCodex(rec('response_item', { type: 'function_call', id: 'fc_wa', name: 'wait_agent', namespace: 'collaboration', arguments: '{"timeout_ms":30000}', call_id: 'call_c74' }), meta) as any[]
    expect(waited.block.name).toBe('wait_agent')
    normalizeCodex(item({ type: 'SubAgentActivity', id: 'subagent-completed-x', kind: 'completed', agent_thread_id: child, agent_path: '/root/pong_only' }), meta)
    expect(meta.subagents.get(child)?.status).toBe('done')
    const [msg] = normalizeCodex(rec('response_item', { type: 'agent_message', id: 'amsg_1', author: '/root/pong_only', recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/pong_only\nPayload:\npong' }] }), meta) as any[]
    expect(msg).toMatchObject({ kind: 'notice', subtype: 'task', level: 'info', text: 'pong_only: pong' })
  })
})

test('a record without an id gets the same id on every read, and two records get two', () => {
  const said = (text: string, timestamp = '2026-01-12T09:00:00.000Z') => ({ timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
  const idOf = (e: any) => normalizeCodex(e, newMeta())[0]?.uuid
  const first = idOf(said('Done.'))
  expect(first).toBeDefined()
  expect(idOf(said('Done.'))).toBe(first!)
  expect(idOf(said('Done, and the tests pass.'))).not.toBe(first!)
  expect(idOf(said('Done.', '2026-01-12T09:00:01.000Z'))).not.toBe(first!)
  // a record with its own id keeps it
  expect(idOf({ ...said('Done.'), payload: { ...said('Done.').payload, id: 'msg_1' } })).toBe('msg_1')
})
