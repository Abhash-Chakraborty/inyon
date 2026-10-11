import { describe, expect, test } from 'bun:test'
import { codexHistory, codexPermission, codexScript, codexTitle, normalizeCodex, pickCodexRollout, unifiedHunks } from './codex.ts'
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
