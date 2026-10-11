import { expect, test } from 'bun:test'
import { offlineAlertDue } from './registry.ts'

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
