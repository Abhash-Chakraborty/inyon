import { expect, test } from 'bun:test'
import { offlineAlertDue, registry } from './registry.ts'

const base = { since: 1_000, notified: false, now: 1_000 + 61_000, held: false, heldUntil: 0, online: true }

test('a machine gone for a minute is reported once', () => {
  expect(offlineAlertDue(base)).toBe(true)
  expect(offlineAlertDue({ ...base, notified: true })).toBe(false)
  expect(offlineAlertDue({ ...base, now: 1_000 + 30_000 })).toBe(false)
})

test('no alert while the phone app is in the background or the phone has no network', () => {
  expect(offlineAlertDue({ ...base, held: true })).toBe(false)
  expect(offlineAlertDue({ ...base, online: false })).toBe(false)
})

test('coming back to the app starts the minute over', () => {
  // the outage began while the app was hidden; the app came back 10 s ago
  expect(offlineAlertDue({ ...base, now: 500_000, heldUntil: 490_000 })).toBe(false)
  expect(offlineAlertDue({ ...base, now: 551_000, heldUntil: 490_000 })).toBe(true)
})

test('back from an outage, a turn that finished meanwhile is reported and a waiting question is not repeated', () => {
  const state = (agent: string) => ({ config: { id: 'reconnect-test', name: 'Box', kind: 'ssh' }, status: 'online', sessions: [{ name: 'main', windows: [{ index: 0, panes: [{ id: '%1', title: 'Fix login', agent: { kind: 'claude', state: agent } }] }] }] })
  const rt: any = { host: { id: 'reconnect-test', config: { id: 'reconnect-test', name: 'Box', kind: 'ssh' } }, state: state('working') }
  const got: string[] = []
  const off = registry.on((e) => void (e.type === 'notify' && e.host === 'reconnect-test' && got.push(e.kind)))
  const outage = (after: string) => {
    ;(registry as any).markDown(rt, 'error', 'gone')
    // while away nothing is known to be running
    expect(rt.state.sessions[0].windows[0].panes[0].agent.state).toBe('unknown')
    const away = rt.state
    rt.state = state(after)
    ;(registry as any).diffNotify(rt, away)
  }
  outage('idle')
  expect(got).toEqual(['done'])
  rt.state = state('waiting')
  outage('waiting')
  expect(got).toEqual(['done'])
  // a question that came up while away is still news
  rt.state = state('working')
  outage('waiting')
  expect(got).toEqual(['done', 'waiting'])
  off()
})
