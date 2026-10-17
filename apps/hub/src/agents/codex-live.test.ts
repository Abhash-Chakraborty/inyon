import { describe, expect, test } from 'bun:test'
import { CodexLiveState, codexLiveCommand, codexLiveScript, codexThreadId } from './codex-live.ts'

// Lines as the helper on the machine prints them, from a Codex 0.162.1 TUI thread joined through
// its app-server daemon (0.163.0) while it answered "say hi again" and ran a sub-agent.
const T = '01a14ac8-3abe-7402-9e85-7440d1fce2e7'
const TURN = '01a14ace-d21b-7a50-a37f-66449ab41d18'
const MSG = 'msg_05b5d60b8898bebc016ad3a9afaa7c81919a0a99b324450b29'
const line = (m: string, p: Record<string, unknown>) => JSON.stringify({ m, p })
const delta = (itemId: string, delta: string, method = 'item/agentMessage/delta', more: Record<string, unknown> = {}) => line(method, { threadId: T, turnId: TURN, itemId, delta, ...more })

describe('Codex live state', () => {
  test('a reply streams in by deltas, is finished by its item, and leaves once its record is in', () => {
    const s = new CodexLiveState()
    expect(s.apply(line('turn/started', { threadId: T, turn: { id: TURN, startedAt: 1792256430, status: 'inProgress' } }))).toEqual({ turn: true })
    expect(s.turn).toEqual({ id: TURN, startedAt: 1792256430000 })
    expect(s.apply(line('item/started', { item: { type: 'agentMessage', id: MSG, text: '', phase: 'final_answer' }, threadId: T, turnId: TURN, startedAtMs: 1 }))).toEqual({})
    expect(s.apply(delta(MSG, 'Hi'))).toEqual({ live: true })
    s.apply(delta(MSG, ' again'))
    s.apply(delta(MSG, '!'))
    expect(s.list()).toEqual([{ id: MSG, kind: 'text', text: 'Hi again!', turnId: TURN }])
    // the finished item carries the whole text, in case a delta was lost on the way
    s.apply(line('item/completed', { item: { type: 'agentMessage', id: MSG, text: 'Hi again!', phase: 'final_answer' }, threadId: T, turnId: TURN, completedAtMs: 1792256431865 }))
    expect(s.list()[0].text).toBe('Hi again!')
    expect(s.done.get(MSG)).toBe(1792256431865)
    expect(s.apply(line('turn/completed', { threadId: T, turn: { id: TURN, status: 'completed', durationMs: 1239 } }))).toEqual({ turn: true, live: true })
    expect(s.turn).toBeUndefined()
    // the rollout line for the same message id arrives: the live copy goes
    expect(s.settle([MSG])).toBe(true)
    expect(s.list()).toEqual([])
  })

  test('thinking summaries and a plan stream as their own kinds, paragraphs apart', () => {
    const s = new CodexLiveState()
    s.apply(delta('rs_1', 'Looking at', 'item/reasoning/summaryTextDelta', { summaryIndex: 0 }))
    s.apply(delta('rs_1', ' the folder', 'item/reasoning/summaryTextDelta', { summaryIndex: 0 }))
    s.apply(delta('rs_1', 'Then the plan', 'item/reasoning/summaryTextDelta', { summaryIndex: 1 }))
    s.apply(delta('plan_1', '## Steps', 'item/plan/delta'))
    expect(s.list()).toEqual([
      { id: 'rs_1', kind: 'thinking', text: 'Looking at the folder\n\nThen the plan', turnId: TURN },
      { id: 'plan_1', kind: 'plan', text: '## Steps', turnId: TURN },
    ])
  })

  test("a command's output keeps only its end, and a finished item nobody records expires", () => {
    const s = new CodexLiveState()
    s.apply(delta('exec-1', 'x'.repeat(5000), 'item/commandExecution/outputDelta'))
    s.apply(delta('exec-1', 'tail', 'item/commandExecution/outputDelta'))
    expect(s.list()[0].text.length).toBe(4000)
    expect(s.list()[0].text.endsWith('tail')).toBe(true)
    s.apply(line('item/completed', { item: { type: 'commandExecution', id: 'exec-1', status: 'completed' }, threadId: T, turnId: TURN, completedAtMs: 1000 }))
    expect(s.expire(6000, 6999)).toBe(false)
    expect(s.expire(6000, 7001)).toBe(true)
    expect(s.list()).toEqual([])
  })

  test('status, usage, name and queue changes are reported, with the waiting flags', () => {
    const s = new CodexLiveState()
    expect(s.apply(line('thread/status/changed', { threadId: T, status: { type: 'active', activeFlags: ['waitingOnApproval'] } }))).toEqual({ status: true })
    expect(s.status).toBe('active')
    expect(s.flags).toEqual(['waitingOnApproval'])
    expect(s.apply(line('thread/tokenUsage/updated', { threadId: T, turnId: TURN, tokenUsage: { total: { totalTokens: 1 } } }))).toEqual({ usage: true })
    expect(s.apply(line('account/rateLimits/updated', { rateLimits: {} }))).toEqual({ usage: true })
    expect(s.apply(line('thread/name/updated', { threadId: T, threadName: 'Say hi' }))).toEqual({ name: 'Say hi' })
    expect(s.apply(line('thread/queue/changed', { threadId: T }))).toEqual({ queue: true })
    expect(s.apply(JSON.stringify({ m: 'item/commandExecution/requestApproval', p: { threadId: T, itemId: 'exec-9' }, req: true }))).toEqual({ ask: true })
    expect(s.apply(line('serverRequest/resolved', { threadId: T, requestId: 0 }))).toEqual({ ask: true })
    expect(s.apply(JSON.stringify({ e: 'resumed', model: 'gpt-6-luna', effort: null, tier: 'default', status: { type: 'idle' } }))).toEqual({ status: true })
    expect(s.settings).toEqual({ model: 'gpt-6-luna', effort: undefined, tier: 'default' })
    expect(s.status).toBe('idle')
    expect(s.apply('not json')).toEqual({})
    expect(s.apply(JSON.stringify({ e: 'waiting', error: 'no rollout found' }))).toEqual({})
  })

  test('a sub-agent is listed from its activity and its own thread, and finishes with it', () => {
    const s = new CodexLiveState()
    const child = '01a14ae4-8cfb-7252-9639-34db58c5b1c9'
    expect(s.apply(line('thread/started', { thread: { id: child, parentThreadId: T, preview: '', model: 'gpt-6-luna', createdAt: 1792257854 } }))).toEqual({ agents: true })
    s.apply(line('item/started', { item: { type: 'subAgentActivity', model: 'gpt-6-luna', id: 'call_2d3', kind: 'started', agentThreadId: child, agentPath: '/root/pong_only' }, threadId: T, turnId: TURN, startedAtMs: 1792257854760 }))
    expect([...s.agents.values()]).toMatchObject([{ threadId: child, description: 'Sub-agent', status: 'running', model: 'gpt-6-luna' }])
    // its own status changes don't touch the main thread's
    s.apply(line('thread/status/changed', { threadId: T, status: { type: 'active', activeFlags: [] } }))
    expect(s.apply(line('thread/status/changed', { threadId: child, status: { type: 'idle' } }))).toEqual({ agents: true })
    expect(s.status).toBe('active')
    expect(s.agents.get(child)?.status).toBe('done')
    // a thread of someone else's isn't a sub-agent
    expect(s.apply(line('thread/started', { thread: { id: 'other', parentThreadId: null } }))).toEqual({})
  })
})

test('the helper is run with node on the machine, for the thread the rollout file names', () => {
  expect(codexThreadId('/home/me/.codex/sessions/2026/10/17/rollout-2026-10-17T16-53-18-01a14ac8-3abe-7402-9e85-7440d1fce2e7.jsonl')).toBe('01a14ac8-3abe-7402-9e85-7440d1fce2e7')
  expect(codexThreadId('/x/rollout-2026-10-10T16-56-05-01a1255b-fbc5-7371-ab05-ee0aa808a95d_01a12590-2495-7421-bf23-e68d82d406bc.jsonl')).toBe('01a1255b-fbc5-7371-ab05-ee0aa808a95d')
  const cmd = codexLiveCommand('01a14ac8-3abe-7402-9e85-7440d1fce2e7')
  expect(cmd).toContain("node -e '")
  expect(cmd.endsWith("' '01a14ac8-3abe-7402-9e85-7440d1fce2e7'")).toBe(true)
  // the script speaks WebSocket to the daemon's socket itself and joins the thread, nothing else
  expect(codexLiveScript).toContain('Sec-WebSocket-Key')
  expect(codexLiveScript).toContain("'thread/resume'")
  expect(codexLiveScript).not.toContain("'turn/start'")
  expect(codexLiveScript).not.toContain("'turn/steer'")
})
