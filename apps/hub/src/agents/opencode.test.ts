import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Host } from '../hosts/host.ts'
import { newMeta } from '../claude/transcript.ts'
import { opencodeItems, opencodePost, selectOpenCodeSession } from './opencode.ts'
import { OpenCodeClient, opencodeRequest, openCodeCatalogFromProviders, openCodeModel } from './opencode-api.ts'
import { OpenCodeSelections, liveValue } from './opencode-controls.ts'

test("an OpenCode session's subagents count as background work, and their questions as waiting", () => {
  const states = { ses_root: { type: 'idle' }, ses_a: { type: 'busy' }, ses_b: { type: 'retry' }, ses_other: { type: 'busy' } }
  const children = new Set(['ses_a', 'ses_b'])
  expect(liveValue(states, [], {}, 'ses_root', children)).toMatchObject({ working: false, background: '2 agents', permission: undefined })
  expect(liveValue({ ...states, ses_b: { type: 'idle' } }, [], {}, 'ses_root', children).background).toBe('1 agent')
  expect(liveValue({ ses_root: { type: 'busy' } }, [], {}, 'ses_root').background).toBeNull()
  // a question from a subagent is this session's to answer; another session's is not
  expect(liveValue(states, [{ id: 'p1', sessionID: 'ses_a' }], {}, 'ses_root', children).permission?.id).toBe('p1')
  expect(liveValue(states, [{ id: 'p2', sessionID: 'ses_other' }], {}, 'ses_root', children).permission).toBeUndefined()
})

const host = new Host({ id: 'test-opencode', kind: 'local', name: 'test' })
test('OpenCode HTTP failures are never accepted as a delivered message', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ error: 'secret-provider-key' }, { status: 400 }) })
  try {
    expect(await opencodePost(host, `http://127.0.0.1:${server.port}/session/bad/prompt_async`, {})).toBe(false)
    await expect(opencodeRequest(host, `http://127.0.0.1:${server.port}/session`)).rejects.toThrow('HTTP 400')
    await expect(opencodeRequest(host, 'http://example.com:80/session')).rejects.toThrow('local loopback')
  } finally { server.stop(true) }
})
test('OpenCode async prompts preserve provider, model slash, reasoning variant and directory', async () => {
  let received: any
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    received = { url: req.url, body: await req.json() }
    return new Response(null, { status: 204 })
  } })
  try {
    const client = new OpenCodeClient(host, `opencode://127.0.0.1:${server.port}/ses_one`, '/tmp/a b')
    await client.prompt('hello', { model: 'openrouter/vendor/model', variant: 'high', agent: 'plan' })
    expect(received.url).toContain('/session/ses_one/prompt_async?directory=%2Ftmp%2Fa%20b')
    expect(received.body).toEqual({ model: { providerID: 'openrouter', modelID: 'vendor/model' }, variant: 'high', agent: 'plan', parts: [{ type: 'text', text: 'hello' }] })
    expect(() => openCodeModel('ambiguous')).toThrow()
  } finally { server.stop(true) }
})
test('catalog exposes only connected provider models and does not leak provider credentials', () => {
  const catalog = openCodeCatalogFromProviders({ connected: ['one'], all: [
    { id: 'one', name: 'First', key: 'SECRET', options: { apiKey: 'SECRET' }, models: { m: { id: 'm', name: 'Model', variants: { low: {}, high: {}, disabled: { disabled: true } }, limit: { context: 123 } } } },
    { id: 'two', models: { m: { id: 'm' } } },
  ] })
  expect(catalog.models).toEqual([{ id: 'one/m', label: 'First · Model', context: 123, efforts: ['low', 'high'] }])
  expect(JSON.stringify(catalog)).not.toContain('SECRET')
})
test('session discovery rejects ambiguous or mismatched cwd conversations', () => {
  const sessions = [{ id: 'a', directory: '/a' }, { id: 'b', directory: '/b' }]
  expect(selectOpenCodeSession(sessions, '/a')).toBe('a')
  expect(selectOpenCodeSession(sessions, '/missing')).toBeUndefined()
  expect(selectOpenCodeSession([...sessions, { id: 'c', directory: '/a' }], '/a')).toBeUndefined()
  expect(selectOpenCodeSession(sessions, '/a', 'b')).toBeUndefined()
  expect(selectOpenCodeSession(sessions, '/a', 'a')).toBe('a')
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
test('dashboard selection survives restart, is isolated by session, and newer native input wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inyon-opencode-selection-'))
  try {
    const file = path.join(dir, 'selections.json')
    const old = [{ info: { id: 'one', role: 'user', model: { providerID: 'p', modelID: 'old' } } }]
    new OpenCodeSelections(file).put('h', 'session-a', { model: 'p/new', variant: 'high' }, old)
    const store = new OpenCodeSelections(file)
    expect(store.get('h', 'session-a', old).model).toBe('p/new')
    expect(store.get('h', 'session-b', old).model).toBe('p/old')
    store.put('h', 'session-reset', { model: 'p/new', variant: undefined }, old)
    expect(new OpenCodeSelections(file).get('h', 'session-reset', [{ info: { ...old[0].info, variant: 'high' } }]).variant).toBeUndefined()
    expect(store.get('h', 'session-a', [...old, { info: { id: 'two', role: 'user', model: { providerID: 'p', modelID: 'native' } } }])).toMatchObject({ model: 'p/native', variant: undefined })
  } finally { fs.rmSync(dir, { recursive: true }) }
})

test('direct OpenCode shell produces a delivery receipt and provider errors are visible', () => {
  const rows = opencodeItems([
    { info: { id: 'u', role: 'user', time: { created: 1000 } }, parts: [{ type: 'text', synthetic: true, text: 'The following tool was executed by the user' }] },
    { info: { id: 'a', parentID: 'u', role: 'assistant', time: { created: 1100 }, error: { data: { message: 'Provider is unavailable' } } }, parts: [{ id: 'p', type: 'tool', tool: 'bash', state: { input: { command: 'printf hello' }, status: 'completed', output: 'hello' } }] },
  ], newMeta())
  expect(rows[0]).toMatchObject({ kind: 'user', shell: true, text: 'printf hello' })
  expect(rows.some((r) => r.kind === 'notice' && r.text === 'Provider is unavailable')).toBe(true)
})
