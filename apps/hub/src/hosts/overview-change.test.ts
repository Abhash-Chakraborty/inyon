import { expect, test } from 'bun:test'
import type { HostState } from '@inyon/protocol'
import { overviewChanged } from './registry.ts'

const state = (over: Partial<HostState> = {}): HostState => ({
  config: { id: 'box', name: 'Box', kind: 'node' },
  status: 'online',
  integration: 'installed',
  tmux: 'ok',
  agents: ['claude'],
  sessions: [{ id: '$1', name: 'work', attached: 0, windows: [] }],
  updatedAt: 1_000,
  lastSeen: 1_000,
  latencyMs: 40,
  ...over,
})

test('a poll that only moves the clock sends no overview', () => {
  // every 4 s poll stamps a new lastSeen; the app only shows it once the machine is offline,
  // and the overview sent when it goes offline carries the latest one
  expect(overviewChanged(state(), state({ updatedAt: 5_000, lastSeen: 5_000, latencyMs: 55 }))).toBe(false)
})

test('anything the app shows still goes out', () => {
  expect(overviewChanged(state(), state({ status: 'connecting', lastSeen: 5_000 }))).toBe(true)
  expect(overviewChanged(state(), state({ sessions: [] }))).toBe(true)
  expect(overviewChanged(state(), state({ agents: ['claude', 'codex'] }))).toBe(true)
  // the first time a machine answers, "Offline" becomes possible at all
  expect(overviewChanged(state({ lastSeen: undefined }), state())).toBe(true)
})
