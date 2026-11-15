import { afterEach, describe, expect, test } from 'bun:test'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AutoRules, DelayedSend, HostState, Organize, SessionMark } from '@inyon/protocol'
import { AutoSwitches } from './AutoSwitches.tsx'
import { ScheduledBubble } from '../chat/ScheduledBubble.tsx'
import { useStore } from '../../lib/store.ts'
import { api, emit } from '../../test/fakes.ts'
import { agentPane, host } from '../../test/fixtures.ts'
import { renderSettled as render } from '../../test/render.tsx'

const box = (): HostState => host('box', { panes: [agentPane('%1', 'claude'), agentPane('%2', 'codex')] })
const mark = (pane: string, more: Partial<SessionMark> = {}): SessionMark => ({ id: `s-${pane}`, host: 'box', pane, live: true, seen: 0, ...more })
const org = (v: number, sessions: SessionMark[] = [], auto?: AutoRules, sends?: DelayedSend[]): Organize => ({ v, sessions, projects: [], groups: [], spaces: [], ...(auto && { auto }), ...(sends && { sends }) })
const hear = (o: Organize) => act(async () => emit({ t: 'overview', hosts: [box()], organize: o }))
const switches = (pane = '%1', agent: 'claude' | 'codex' = 'claude') => render(<AutoSwitches host={box()} pane={pane} agent={agent} compact />)
const toggle = (name: string) => screen.getByRole('switch', { name })

afterEach(() => act(() => emit({ t: 'overview', hosts: [] })))

describe('carrying on and compacting by itself', () => {
  test('a hub before version 3 shows no switches', async () => {
    await hear(org(2))
    await switches()
    expect(screen.queryByText('Carry on after a limit')).toBeNull()
    expect(screen.queryByText('Compact before it fills')).toBeNull()
  })

  test('each switch follows the hub rule until the session has its own', async () => {
    await hear(org(3, [], { carryOn: true, compactAt: 75 }))
    await switches()
    expect(toggle('Carry on after a limit').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Sends “continue” a minute after the plan limit resets')).toBeTruthy()
    expect(toggle('Compact before it fills').getAttribute('aria-checked')).toBe('false')

    await hear(org(3, [mark('%1', { carryOn: false, autoCompact: true })], { carryOn: true, compactAt: 75 }))
    expect(toggle('Carry on after a limit').getAttribute('aria-checked')).toBe('false')
    expect(toggle('Compact before it fills').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('At 75% of the context, once the agent is idle')).toBeTruthy()
  })

  test('a switch goes to the hub for this session', async () => {
    await hear(org(3))
    const user = userEvent.setup()
    await switches()
    await user.click(toggle('Carry on after a limit'))
    expect(api.organize).toHaveBeenLastCalledWith('box', '%1', { carryOn: true })
    await user.click(toggle('Compact before it fills'))
    expect(api.organize).toHaveBeenLastCalledWith('box', '%1', { autoCompact: true })
  })

  test('only Claude Code carries on; Codex can still compact', async () => {
    await hear(org(3))
    await switches('%2', 'codex')
    expect(screen.queryByText('Carry on after a limit')).toBeNull()
    expect(screen.getByText('Compact before it fills')).toBeTruthy()
  })

  test('a carry-on waiting to go says so, and once cancelled it has no Undo', async () => {
    const s: DelayedSend = { id: 'd-1', host: 'box', pane: '%1', text: 'continue', at: Date.now() + 3600_000, auto: 'carry-on' }
    const user = userEvent.setup()
    await render(<ScheduledBubble host="box" pane="%1" s={s} />)
    expect(screen.getByText(/^Carries on at /)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.cancelSend).toHaveBeenCalledWith('box', 'd-1')
    const t = useStore.getState().toasts.at(-1)!
    expect(t.title).toBe('Won’t carry on')
    expect(t.action).toBeUndefined()
  })
})
