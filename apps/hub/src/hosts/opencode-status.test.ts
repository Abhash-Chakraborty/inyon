import { describe, expect, test } from 'bun:test'
import type { AgentPaneInfo } from '@inyon/protocol'
import { applyOpenCodeScreen } from './registry.ts'

// no catalogue is known for this host, so names come straight off the footer
const host = { id: 'status-test-' + Math.random(), exec: async () => ({ code: 0, stdout: '', stderr: '' }) }
const pane = (more: Partial<AgentPaneInfo> = {}): AgentPaneInfo => ({ kind: 'opencode', pid: 7, state: 'idle', transcriptPath: 'opencode://127.0.0.1:1/ses_a', ...more })

describe("OpenCode's footer is the truth, and stands while it is hidden", () => {
  test('a visible footer sets model, variant and agent; no variant means the default', () => {
    const info = pane()
    applyOpenCodeScreen(info, { working: false, width: 120, model: 'Space Bunny Free OpenCode', effort: 'high', mode: 'plan' }, host)
    expect(info.status).toMatchObject({ model: 'Space Bunny Free', effort: 'high' })
    expect(info.mode).toBe('plan')
    applyOpenCodeScreen(info, { working: false, width: 120, model: 'Big Pickle OpenCode', mode: 'build' }, host)
    expect(info.status).toMatchObject({ model: 'Big Pickle', effort: undefined })
    expect(info.mode).toBe('build')
  })

  test('a menu or question hiding the footer keeps the last values for the same process, not for a new one', () => {
    const was = pane({ mode: 'plan', status: { model: 'Space Bunny Free', modelId: 'opencode/space-bunny-free', effort: 'high', contextSize: 1048576, updatedAt: 1 } })
    const next = pane()
    applyOpenCodeScreen(next, { working: false, width: 120, prompt: { body: ['Permission required'], options: [], multi: false } }, host, was)
    expect(next.status).toMatchObject({ model: 'Space Bunny Free', modelId: 'opencode/space-bunny-free', effort: 'high', contextSize: 1048576 })
    expect(next.mode).toBe('plan')
    const restarted = pane({ pid: 8 })
    applyOpenCodeScreen(restarted, { working: false, width: 120 }, host, was)
    expect(restarted.status?.model).toBeUndefined()
    expect(restarted.mode).toBeUndefined()
  })

  test("the sidebar's context and cost ride along, and a later footer keeps them", () => {
    const info = pane()
    applyOpenCodeScreen(info, { working: false, width: 160, model: 'Big Pickle OpenCode', mode: 'build', contextUsed: 36898, contextPct: 18, costUsd: 0 }, host)
    expect(info.status).toMatchObject({ contextUsed: 36898, contextPct: 18, costUsd: 0 })
    applyOpenCodeScreen(info, { working: true, width: 160, model: 'Big Pickle OpenCode', mode: 'build' }, host)
    expect(info.status).toMatchObject({ contextUsed: 36898, contextPct: 18, model: 'Big Pickle' })
  })
})
