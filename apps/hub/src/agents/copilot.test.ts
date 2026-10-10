import { expect, test } from 'bun:test'
import { normalizeCopilot, guessCopilotSession, pickCopilotSession } from './copilot.ts'
import { parseCopilotModels } from './copilot-models.ts'
import { newMeta } from '../claude/transcript.ts'
import type { Host } from '../hosts/host.ts'

const event = (type: string, data: unknown) => ({ type, data, id: 'event-id', timestamp: '2026-10-10T12:00:00Z' })
test('Copilot records user, tool execution, and final reply without duplicated tool requests', () => {
  const meta = newMeta()
  normalizeCopilot(event('session.start', { copilotVersion: '1.0.95', context: { cwd: '/qa' }, selectedModel: 'auto' }), meta)
  expect(meta.cwd).toBe('/qa')
  expect(normalizeCopilot(event('user.message', { content: 'Run pwd' }), meta)[0]).toMatchObject({ kind: 'user', text: 'Run pwd' })
  expect(normalizeCopilot(event('assistant.message', { content: '', toolRequests: [{ toolCallId: 't' }] }), meta)).toEqual([])
  expect(normalizeCopilot(event('tool.execution_start', { toolCallId: 't', toolName: 'bash', arguments: { command: 'pwd' } }), meta)[0]).toMatchObject({ block: { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } } })
  expect(normalizeCopilot(event('tool.execution_complete', { toolCallId: 't', success: false, error: { message: 'denied' } }), meta)[0]).toMatchObject({ kind: 'tool_result', isError: true, text: 'denied' })
  normalizeCopilot(event('assistant.turn_end', {}), meta)
  expect(meta.stats.turns).toBe(1)
})
test('Copilot credits never become dollar cost and session settings reflect recorded values', () => {
  const meta = newMeta()
  normalizeCopilot(event('session.model_change', { newModel: 'auto', reasoningEffort: null }), meta)
  normalizeCopilot(event('session.permissions_changed', { mode: 'default' }), meta)
  normalizeCopilot(event('assistant.usage', { cost: 8, inputTokens: 100 }), meta)
  normalizeCopilot(event('session.usage_info', { currentTokens: 100, tokenLimit: 1000 }), meta)
  expect(meta.stats.costUsd).toBeUndefined()
  expect(meta.status).toMatchObject({ modelId: 'auto', contextPct: 10 })
  expect(meta.mode).toBe('default')
})
test('Copilot catalog uses model-specific reasoning and excludes disabled models', () => {
  expect(parseCopilotModels({ models: [{ id: 'gpt-test', name: 'Test', supportedReasoningEfforts: ['low', 'high'], capabilities: { limits: { max_context_window_tokens: 1000 } } }, { id: 'blocked', policy: { state: 'disabled' } }] })).toEqual([
    { id: 'auto', label: 'Auto', note: 'Copilot chooses an available model for each task', efforts: [] },
    { id: 'gpt-test', label: 'Test', context: 1000, efforts: ['low', 'high'] },
  ])
  expect(parseCopilotModels({ models: [] })).toHaveLength(1)
  expect(() => parseCopilotModels({ error: 'unauthorized' })).toThrow()
})
test('Copilot discovery refuses ambiguous same-process sessions', async () => {
  const host = { exec: async () => ({ stdout: '/home/u/.copilot/session-state/a/inuse.123.lock\n/home/u/.copilot/session-state/b/inuse.123.lock\n' }) } as unknown as Host
  expect(await guessCopilotSession(host, '/home/u', { pid: 123 })).toBeUndefined()
  expect(await guessCopilotSession(host, '/home/u', { pid: 123, resume: 'b' })).toBe('/home/u/.copilot/session-state/b/events.jsonl')
})

import { parseCopilotScreen } from './copilot-screen.ts'
const rule = '─'.repeat(100)
test('Copilot remains working during silent tools and reads shell input', () => {
  const working = parseCopilotScreen([rule, '❯', rule, ' ◎ Working · 524 B esc interrupt                           Auto → gpt-test'])
  expect(working).toMatchObject({ working: true, model: 'auto', inputVisible: true })
  const shell = parseCopilotScreen([rule, '! printf hello', rule, ' Shell · Manual Approval                            Auto → gpt-test'])
  expect(shell).toMatchObject({ working: false, draft: '!printf hello', mode: 'default' })
  expect(parseCopilotScreen([rule, '❯ /plan [prompt]', rule, ' Plan · Manual Approval                         Auto']).draft).toBe('/plan')
})
test('Copilot reads the block-style composer, not the block-style history above it', () => {
  const top = '╻' + '▄'.repeat(100), bottom = '╹' + '▀'.repeat(100), footer = ' Interactive · Manual Approval · @ files · # issues                Auto → mai-code-1.1-flash'
  const history = [' ' + '▄'.repeat(100), '  ❯ Reply with just the word HELLO905.              21:44', ' ' + '▀'.repeat(100), ' ● HELLO905']
  expect(parseCopilotScreen([...history, top, '┃ Reply with just the word AGAIN575.', bottom, footer])).toMatchObject({ inputVisible: true, draft: 'Reply with just the word AGAIN575.', model: 'auto', mode: 'default' })
  const empty = parseCopilotScreen([...history, top, '┃', bottom, footer])
  expect(empty.inputVisible).toBe(true)
  expect(empty.draft).toBeUndefined()
  expect(parseCopilotScreen([top, '┃ line one', '┃ line two', bottom, footer]).draft).toBe('line one\nline two')
})
test('Copilot parses ANSI input and folder trust as a waiting prompt', () => {
  expect(parseCopilotScreen(['\x1b[2m' + rule, '\x1b[0m❯ hello', '\x1b[2m' + rule, '\x1b[0m Interactive · Manual Approval              Auto']).draft).toBe('hello')
  const trust = parseCopilotScreen(['│ Confirm folder trust │', '│ ❯ 1. Yes │', '│   2. Yes, and remember this folder │', '│   3. No (Esc) │', '│ ↑/↓ to navigate · enter to select · esc to cancel │'])
  expect(trust.prompt?.options).toHaveLength(3)
  expect(trust.prompt?.options[0]).toMatchObject({ n: 1, selected: true })
  expect(trust.inputVisible).toBeUndefined()
})
test('Copilot direct shell input creates a receipt and matching tool output', () => {
  const meta = newMeta()
  const items = normalizeCopilot(event('tool.user_requested', { toolName: 'local_shell', toolCallId: 'shell1', arguments: { command: 'printf hello' } }), meta)
  expect(items[0]).toMatchObject({ kind: 'user', text: '!printf hello' })
  expect(items[1]).toMatchObject({ kind: 'assistant', block: { name: 'Bash' } })
  expect(normalizeCopilot(event('tool.execution_complete', { toolCallId: 'shell1', success: true, result: { content: 'hello' } }), meta)[0]).toMatchObject({ kind: 'tool_result', text: 'hello', meta: { stdout: 'hello' } })
  normalizeCopilot(event('session.permissions_changed', { allowAllPermissions: false, allowAllPermissionMode: 'off' }), meta)
  expect(meta.mode).toBe('default')
})


test('Copilot session ownership follows an npm launcher but prefers closest locks', () => {
  const lock = (id: string, pid: number) => `/home/u/.copilot/session-state/${id}/inuse.${pid}.lock`
  const tree = [{pid: 11, ppid: 10}, {pid: 12, ppid: 11}, {pid: 21, ppid: 20}]
  expect(pickCopilotSession([lock('mine', 12), lock('other', 21)], tree, {pid: 10})).toBe('/home/u/.copilot/session-state/mine/events.jsonl')
  expect(pickCopilotSession([lock('near', 11), lock('far', 12)], tree, {pid: 10})).toBe('/home/u/.copilot/session-state/near/events.jsonl')
  expect(pickCopilotSession([lock('a', 12), lock('b', 12)], tree, {pid: 10})).toBeUndefined()
  expect(pickCopilotSession([lock('a', 12), lock('b', 12)], tree, {pid: 10, resume: 'b'})).toBe('/home/u/.copilot/session-state/b/events.jsonl')
})
test('Copilot descendant search is bounded and never follows unrelated processes', () => {
  const tree = Array.from({length: 5}, (_, i) => ({pid: i + 2, ppid: i + 1}))
  expect(pickCopilotSession(['/h/session/four/inuse.5.lock'], tree, {pid: 1})).toBe('/h/session/four/events.jsonl')
  expect(pickCopilotSession(['/h/session/five/inuse.6.lock'], tree, {pid: 1})).toBeUndefined()
  expect(pickCopilotSession(['/h/session/other/inuse.99.lock'], tree, {pid: 1})).toBeUndefined()
})
