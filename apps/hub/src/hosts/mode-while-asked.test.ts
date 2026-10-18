import { afterAll, expect, test } from 'bun:test'
import type { PaneInfo, SessionInfo } from '@inyon/protocol'
import { registry } from './registry.ts'
import type { ProbeResult } from '../tmux/tmux.ts'
import { screenFixture } from '../fixtures.ts'

const ID = 'mode-test'
const R = '─'.repeat(100)
const idle = (footer: string) => `● Done.\n${R}\n❯ \n${R}\n  ${footer}`
const asking = screenFixture('claude', 'permission-prompt').join('\n')

/** One Claude pane on a machine whose screen is whatever the test last drew. */
let screen = ''
const host = {
  id: ID,
  config: { id: ID, name: 'Box', kind: 'ssh' },
  exec: async (cmd: string) => ({ code: 0, stdout: cmd.includes('@@CAP') ? `@@CAP %9\n${screen}\n` : '', stderr: '' }),
}
const sessions = (): SessionInfo[] => [{ id: '$1', name: 'work', attached: 0, windows: [{ id: '@1', index: 0, name: 'claude', active: true, activity: 0, panes: [{ id: '%9', index: 0, active: true, command: 'claude', cwd: '/w', title: 'claude', width: 100, height: 30, dead: false } as PaneInfo] }] }]
const now = Date.now() / 1000
const probe = (): ProbeResult => ({
  hostname: 'box', home: '', os: 'Linux', now, latencyMs: 1, tmux: 'ok', integration: 'missing', sessions: sessions(),
  agentProcs: new Map([['%9', { kind: 'claude', pid: 7, startedAt: now - 100, cwd: '/w', args: 'claude', panePid: 7 }]]),
  hookPanes: new Map(), statusPanes: new Map(), compactPanes: new Map(), installed: [], signedIn: [],
  agyConversations: new Map(), agyStatus: new Map(), agyTitles: new Map(),
})
const rt: any = {
  host, state: { config: host.config, status: 'online', integration: 'missing', tmux: 'ok', agents: [], sessions: sessions(), updatedAt: 0 },
  cwdMap: new Map(), statusCache: new Map(), screens: new Map(), dirty: new Set(), polling: false, stopped: false,
}
;(registry as any).hosts.set(ID, rt)
afterAll(() => (registry as any).hosts.delete(ID))

const mode = () => registry.findPane(ID, '%9')?.pane.agent?.mode
/** The 4 s poll: a fresh read of every agent pane. */
async function poll() {
  const pr = probe()
  rt.probe = pr
  await (registry as any).annotateAgents(rt, pr)
  rt.state = { ...rt.state, sessions: pr.sessions }
  return mode()
}
/** The quick re-read after the pane printed something. */
async function refresh() {
  rt.dirty.add('%9')
  await (registry as any).flushDirty(rt)
  return mode()
}

test('while Claude asks, the poll and a refresh both keep the mode its footer showed last', async () => {
  screen = idle('⏵⏵ accept edits on (shift+tab to cycle)')
  expect(await poll()).toBe('accept edits')
  screen = asking
  expect(await poll()).toBe('accept edits')
  expect(await refresh()).toBe('accept edits')
  expect(await poll()).toBe('accept edits')
})

test('once the footer shows again without a mode, both say there is none', async () => {
  screen = idle('⏵⏵ accept edits on (shift+tab to cycle)')
  expect(await poll()).toBe('accept edits')
  screen = idle('? for shortcuts')
  expect(await refresh()).toBeUndefined()
  expect(await poll()).toBeUndefined()
})

test('a footer naming another mode wins over the one kept', async () => {
  screen = idle('⏵⏵ accept edits on (shift+tab to cycle)')
  await poll()
  screen = asking
  await refresh()
  screen = idle('⏸ plan mode on (shift+tab to cycle)')
  expect(await refresh()).toBe('plan')
  expect(await poll()).toBe('plan')
})
