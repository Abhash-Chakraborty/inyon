import { expect, test } from 'bun:test'
import { Host } from '../hosts/host.ts'
import { newMeta } from '../claude/transcript.ts'
import { opencodeItems, opencodePost, selectOpenCodeSession, titledSession } from './opencode.ts'
import { OpenCodeClient, opencodeRequest, openCodeAgentsFrom, openCodeCatalogFromProviders, openCodeModel } from './opencode-api.ts'
import { liveValue, selectionFromFooter, selectionFromMessages, storedSelection } from './opencode-controls.ts'

test("an OpenCode session's subagents count as background work, and their questions as waiting", () => {
  const states = { ses_root: { type: 'idle' }, ses_a: { type: 'busy' }, ses_b: { type: 'retry' }, ses_other: { type: 'busy' } }
  const children = new Set(['ses_a', 'ses_b'])
  expect(liveValue(states, [], 'ses_root', children)).toMatchObject({ working: false, background: '2 agents', permission: undefined })
  expect(liveValue({ ...states, ses_b: { type: 'idle' } }, [], 'ses_root', children).background).toBe('1 agent')
  expect(liveValue({ ses_root: { type: 'busy' } }, [], 'ses_root').background).toBeNull()
  // a question from a subagent is this session's to answer; another session's is not
  expect(liveValue(states, [{ id: 'p1', sessionID: 'ses_a' }], 'ses_root', children).permission?.id).toBe('p1')
  expect(liveValue(states, [{ id: 'p2', sessionID: 'ses_other' }], 'ses_root', children).permission).toBeUndefined()
})

const host = new Host({ id: 'test-opencode', kind: 'local', name: 'test' })

/** A stand-in OpenCode server that records what it was asked and answers from `routes`. */
function fakeServer(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body?: any }[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url)
    const body = req.method === 'GET' ? undefined : await req.text().then((t) => (t ? JSON.parse(t) : undefined))
    calls.push({ method: req.method, path: url.pathname + url.search, body })
    const hit = routes[`${req.method} ${url.pathname}`] ?? routes[url.pathname]
    return hit === undefined ? new Response(null, { status: 404 }) : Response.json(hit)
  } })
  return { calls, port: server.port, stop: () => server.stop(true), uri: (session = 'ses_one') => `opencode://127.0.0.1:${server.port}/${session}` }
}

test('OpenCode HTTP failures are never accepted as a delivered message', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ error: 'secret-provider-key' }, { status: 400 }) })
  try {
    expect(await opencodePost(host, `http://127.0.0.1:${server.port}/session/bad/prompt_async`, {})).toBe(false)
    await expect(opencodeRequest(host, `http://127.0.0.1:${server.port}/session`)).rejects.toThrow('HTTP 400')
    await expect(opencodeRequest(host, 'http://example.com:80/session')).rejects.toThrow('local loopback')
  } finally { server.stop(true) }
})

test('OpenCode async prompts preserve provider, model slash, reasoning variant and directory', async () => {
  const s = fakeServer({ 'POST /session/ses_one/prompt_async': {} })
  try {
    const client = new OpenCodeClient(host, s.uri(), '/tmp/a b')
    await client.prompt('hello', { model: 'openrouter/vendor/model', variant: 'high', agent: 'plan' })
    expect(s.calls[0].path).toBe('/session/ses_one/prompt_async?directory=%2Ftmp%2Fa%20b')
    expect(s.calls[0].body).toEqual({ model: { providerID: 'openrouter', modelID: 'vendor/model' }, variant: 'high', agent: 'plan', parts: [{ type: 'text', text: 'hello' }] })
    expect(() => openCodeModel('ambiguous')).toThrow()
  } finally { s.stop() }
})

test('undo, redo, share, compact and questions go to the routes OpenCode 1.19 has for them', async () => {
  const s = fakeServer({
    'POST /session/ses_one/revert': { id: 'ses_one', revert: { messageID: 'msg_2' } },
    'POST /session/ses_one/unrevert': { id: 'ses_one' },
    'POST /session/ses_one/share': { id: 'ses_one', share: { url: 'https://opencode.ai/s/abc' } },
    'DELETE /session/ses_one/share': { id: 'ses_one' },
    'POST /session/ses_one/summarize': true,
    'GET /question': [{ id: 'que_1', sessionID: 'ses_one', questions: [{ question: 'Tabs or spaces?', header: 'Indentation', options: [{ label: 'Tabs', description: '' }] }] }],
    'POST /question/que_1/reply': true,
    'POST /tui/select-session': true,
    'POST /instance/dispose': true,
  })
  try {
    const client = new OpenCodeClient(host, s.uri(), '/w')
    expect((await client.revert('msg_2')).revert.messageID).toBe('msg_2')
    await client.unrevert()
    expect((await client.share()).share.url).toBe('https://opencode.ai/s/abc')
    await client.unshare()
    await client.summarize('opencode/big-pickle')
    expect((await client.questions())[0].id).toBe('que_1')
    await client.replyQuestion('que_1', [['Tabs']])
    await client.selectSession('ses_two')
    await client.dispose()
    expect(s.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual([
      'POST /session/ses_one/revert', 'POST /session/ses_one/unrevert', 'POST /session/ses_one/share', 'DELETE /session/ses_one/share',
      'POST /session/ses_one/summarize', 'GET /question', 'POST /question/que_1/reply', 'POST /tui/select-session', 'POST /instance/dispose',
    ])
    expect(s.calls[0].body).toEqual({ messageID: 'msg_2' })
    expect(s.calls[4].body).toEqual({ providerID: 'opencode', modelID: 'big-pickle' })
    expect(s.calls[6].body).toEqual({ answers: [['Tabs']] })
    expect(s.calls[7].body).toEqual({ sessionID: 'ses_two' })
    // every call carries the session's folder, which the server keys its state by
    expect(s.calls.every((c) => c.path.endsWith('?directory=%2Fw'))).toBe(true)
  } finally { s.stop() }
})

test('catalog exposes only connected provider models and does not leak provider credentials', () => {
  const catalog = openCodeCatalogFromProviders({ connected: ['one'], all: [
    { id: 'one', name: 'First', key: 'SECRET', options: { apiKey: 'SECRET' }, models: { m: { id: 'm', name: 'Model', variants: { low: {}, high: {}, disabled: { disabled: true } }, limit: { context: 123 } } } },
    { id: 'two', models: { m: { id: 'm' } } },
  ] })
  expect(catalog.models).toEqual([{ id: 'one/m', label: 'First · Model', context: 123, efforts: ['low', 'high'] }])
  expect(JSON.stringify(catalog)).not.toContain('SECRET')
})

test("the agents a session can switch to are the primary ones, custom included, never OpenCode's hidden helpers", () => {
  const agents = openCodeAgentsFrom([
    { name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }, { name: 'reviewer', mode: 'all' },
    { name: 'explore', mode: 'subagent' }, { name: 'title', mode: 'primary', hidden: true },
  ])
  expect(agents).toEqual([{ id: 'build', label: 'Build' }, { id: 'plan', label: 'Plan' }, { id: 'reviewer', label: 'Reviewer' }])
})

test('session discovery rejects ambiguous or mismatched cwd conversations, unless the terminal title names one', () => {
  const sessions = [{ id: 'a', directory: '/a', title: 'first' }, { id: 'b', directory: '/b', title: 'other' }]
  expect(selectOpenCodeSession(sessions, '/a')).toBe('a')
  expect(selectOpenCodeSession(sessions, '/missing')).toBeUndefined()
  const two = [...sessions, { id: 'c', directory: '/a', title: 'second', time: { updated: 5 } }, { id: 'd', directory: '/a', title: 'second', time: { updated: 9 } }]
  expect(selectOpenCodeSession(two, '/a')).toBeUndefined()
  expect(selectOpenCodeSession(two, '/a', undefined, 'first')).toBe('a')
  // two with the same title: the one that moved last
  expect(selectOpenCodeSession(two, '/a', undefined, 'second')).toBe('d')
  expect(selectOpenCodeSession(two, '/a', undefined, 'nope')).toBeUndefined()
  expect(selectOpenCodeSession(sessions, '/a', 'b')).toBeUndefined()
  expect(selectOpenCodeSession(sessions, '/a', 'a')).toBe('a')
  expect(titledSession('OC | pong')).toBe('pong')
  expect(titledSession('OpenCode')).toBeUndefined()
})

test('session metrics count user turns rather than every intermediate tool response and preserve zero cost', () => {
  const meta = newMeta()
  const messages = [
    { info: { id: 'u', role: 'user', model: { providerID: 'one', modelID: 'm' }, agent: 'plan', variant: 'high', time: { created: 100 } }, parts: [{ type: 'text', text: 'hello' }] },
    ...[1, 2].map((id) => ({ info: { id: `a${id}`, role: 'assistant', providerID: 'one', modelID: 'm', cost: 0, time: { completed: 110 } }, parts: [] })),
  ]
  opencodeItems(messages, meta)
  expect(meta.stats.turns).toBe(1)
  expect(meta.stats.costUsd).toBe(0)
  expect(meta.status).toMatchObject({ model: 'one/m', effort: 'high' })
})

test("the context is the last reply's whole usage, reasoning and cache included, as the TUI's sidebar counts it", () => {
  const meta = newMeta()
  opencodeItems([
    { info: { id: 'u', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
    { info: { id: 'a1', role: 'assistant', time: { created: 2, completed: 3 }, tokens: { input: 14049, output: 3, reasoning: 0, cache: { read: 1792, write: 0 } } }, parts: [] },
    // an aborted reply has no usage worth counting
    { info: { id: 'a2', role: 'assistant', time: { created: 4 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] },
  ], meta)
  expect(meta.stats.contextTokens).toBe(15844)
  expect(meta.stats.contextAt).toBe(3)
  const total = newMeta()
  opencodeItems([{ info: { id: 'a', role: 'assistant', time: { created: 2 }, tokens: { total: 36533, input: 14666, output: 74, reasoning: 1441, cache: { read: 20352, write: 0 } } }, parts: [] }], total)
  expect(total.stats.contextTokens).toBe(36533)
})

test('direct OpenCode shell produces a delivery receipt and provider errors are visible', () => {
  const rows = opencodeItems([
    { info: { id: 'u', role: 'user', time: { created: 1000 } }, parts: [{ type: 'text', synthetic: true, text: 'The following tool was executed by the user' }] },
    { info: { id: 'a', parentID: 'u', role: 'assistant', time: { created: 1100 }, error: { data: { message: 'Provider is unavailable' } } }, parts: [{ id: 'p', type: 'tool', tool: 'bash', state: { input: { command: 'printf hello' }, status: 'completed', output: 'hello' } }] },
  ], newMeta())
  expect(rows[0]).toMatchObject({ kind: 'user', shell: true, text: 'printf hello' })
  expect(rows.some((r) => r.kind === 'notice' && r.text === 'Provider is unavailable')).toBe(true)
})

test("what a message runs with comes from the footer first, then the session's record, then the last message", async () => {
  const models = [
    { id: 'opencode/deepseek-v4.1-flash-free', label: 'OpenCode · DeepSeek V4.1 Flash Free', efforts: ['low', 'high', 'max'] },
    { id: 'opencode/big-pickle', label: 'OpenCode · Big Pickle', efforts: [] },
  ]
  expect(selectionFromFooter({ model: 'DeepSeek V4.1 Flash Free OpenCode', effort: 'max', mode: 'plan' }, models)).toEqual({ model: 'opencode/deepseek-v4.1-flash-free', variant: 'max', agent: 'plan' })
  expect(selectionFromFooter({ model: 'Big Pickle OpenCode', mode: 'build' }, models)).toEqual({ model: 'opencode/big-pickle', variant: undefined, agent: 'build' })
  // a footer naming a model the catalogue doesn't know (or no footer at all) decides nothing
  expect(selectionFromFooter({ model: 'Mystery Model Acme', mode: 'build' }, models)).toBeUndefined()
  expect(selectionFromFooter({ mode: 'build' }, models)).toBeUndefined()
  const s = fakeServer({ 'GET /session/ses_one': { id: 'ses_one', agent: 'plan', model: { id: 'deepseek-v4.1-flash-free', providerID: 'opencode', variant: 'max' } } })
  try {
    expect(await storedSelection(new OpenCodeClient(host, s.uri(), '/w'))).toEqual({ model: 'opencode/deepseek-v4.1-flash-free', variant: 'max', agent: 'plan' })
  } finally { s.stop() }
  expect(selectionFromMessages([
    { info: { id: 'one', role: 'user', model: { providerID: 'p', modelID: 'old', variant: 'high' }, agent: 'build' } },
    { info: { id: 'two', role: 'user', model: { providerID: 'p', modelID: 'native' } } },
  ])).toEqual({ model: 'p/native', variant: undefined, agent: 'build' })
})
