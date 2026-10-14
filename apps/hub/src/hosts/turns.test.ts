import { expect, test } from 'bun:test'
import { Turns } from './turns.ts'

const hook = (name: string, ts: number, extra: Record<string, string> = {}) => ({ pane: '%1', ts, data: { hook_event_name: name, ...extra } })
const T0 = 1_791_000_000_000

test('an answered prompt shows working while the screen reads idle, until Stop', () => {
  const t = new Turns()
  t.start('p', T0)
  // the screen changes each second while the approved command runs (spinner, elapsed time)
  expect(t.state('p', 'idle', 'Running 1s', undefined, T0 + 1000)).toBe('working')
  expect(t.state('p', 'idle', 'Running 5s', hook('PermissionRequest', T0 / 1000 - 3), T0 + 5000)).toBe('working')
  expect(t.state('p', 'idle', 'Running 9s', hook('Stop', T0 / 1000 + 9), T0 + 9500)).toBe('idle')
  // and the Stop doesn't start anything again
  expect(t.state('p', 'idle', 'done', hook('Stop', T0 / 1000 + 9), T0 + 12_000)).toBe('idle')
})

test('a screen that stops changing ends the turn when no Stop comes', () => {
  const t = new Turns()
  t.start('p', T0)
  expect(t.state('p', 'idle', 'same', undefined, T0 + 500)).toBe('working')
  expect(t.state('p', 'idle', 'same', undefined, T0 + 4500)).toBe('working')
  expect(t.state('p', 'idle', 'same', undefined, T0 + 8600)).toBe('idle')
})

test('a screen that shows Claude working is believed when it goes idle', () => {
  const t = new Turns()
  t.start('p', T0)
  expect(t.state('p', 'working', 'spinner', undefined, T0 + 1000)).toBe('working')
  expect(t.state('p', 'idle', 'input box', undefined, T0 + 2000)).toBe('idle')
})

test('a question in the middle keeps the turn going after it is answered elsewhere', () => {
  const t = new Turns()
  t.start('p', T0)
  expect(t.state('p', 'waiting', 'Do you want to proceed?', undefined, T0 + 1000)).toBe('waiting')
  expect(t.state('p', 'idle', 'Running', undefined, T0 + 2000)).toBe('working')
})

test('hook events start a turn the screen misses, and an idle notification ends it', () => {
  const t = new Turns()
  const now = T0 + 2000
  expect(t.state('p', 'idle', 'a', hook('UserPromptSubmit', T0 / 1000), now)).toBe('working')
  expect(t.state('p', 'idle', 'b', hook('Notification', T0 / 1000 + 70, { notification_type: 'idle_prompt' }), now + 70_000)).toBe('idle')
  // the same old event doesn't bring it back
  expect(t.state('p', 'idle', 'c', hook('UserPromptSubmit', T0 / 1000), now + 71_000)).toBe('idle')
  // an event from long ago starts nothing
  expect(new Turns().state('q', 'idle', 'a', hook('UserPromptSubmit', T0 / 1000), T0 + 20 * 60_000)).toBe('idle')
})

test('Esc from Inyon ends it at once', () => {
  const t = new Turns()
  t.start('p', T0)
  t.end('p', T0 + 100)
  expect(t.state('p', 'idle', 'x', hook('PermissionRequest', T0 / 1000 - 1), T0 + 200)).toBe('idle')
})
