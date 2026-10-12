import { afterEach, expect, test } from 'bun:test'
import { installKeepAlive, keepAliveWanted } from './keepalive.ts'
import { useStore } from './store.ts'
import { host } from '../test/fixtures.ts'

type Listener = (e: any) => void

function phone(device: Record<string, any> = {}) {
  const listeners: Record<string, Listener> = {}
  ;(window as any).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: {
      InyonDevice: {
        startKeepAlive: async () => ({ ok: true }),
        addListener: (event: string, fn: Listener) => ((listeners[event] = fn), Promise.resolve({ remove() {} })),
        ...device,
      },
    },
  }
  return listeners
}

afterEach(() => {
  delete (window as any).Capacitor
  localStorage.removeItem('inyon.keepAlive')
  localStorage.removeItem('inyon.batteryAsked')
  useStore.setState({ toasts: [], hosts: [] })
})

const settle = () => new Promise((r) => setTimeout(r, 0))

test('stays connected unless turned off, asking for the notification permission first', async () => {
  const calls: string[] = []
  const device = { requestNotificationPermission: async () => void calls.push('permission'), startKeepAlive: async () => void calls.push('start') }
  phone(device)
  expect(keepAliveWanted()).toBe(true)
  installKeepAlive()
  await settle()
  expect(calls).toEqual(['permission', 'start'])

  localStorage.setItem('inyon.keepAlive', '0')
  calls.length = 0
  phone(device)
  installKeepAlive()
  await settle()
  expect(calls).toEqual([])
})

test("asks Android once, when there's a machine, not to put Inyon to sleep", async () => {
  let asked = 0
  let ignoring = false
  phone({ isIgnoringBatteryOptimizations: async () => ({ ignoring }), requestBatteryExemption: async () => (asked++, { ignoring: (ignoring = true) }) })
  installKeepAlive()
  await settle()
  expect(asked).toBe(0)
  useStore.setState({ hosts: [host('box')] })
  await settle()
  expect(asked).toBe(1)
  // never again, even when it's restricted again later
  ignoring = false
  installKeepAlive()
  useStore.setState({ hosts: [host('box'), host('b2')] })
  await settle()
  expect(asked).toBe(1)
})

test("doesn't ask when it's already allowed or Stay connected is off", async () => {
  let asked = 0
  phone({ isIgnoringBatteryOptimizations: async () => ({ ignoring: true }), requestBatteryExemption: async () => (asked++, { ignoring: true }) })
  installKeepAlive()
  useStore.setState({ hosts: [host('box')] })
  await settle()
  localStorage.setItem('inyon.keepAlive', '0')
  phone({ isIgnoringBatteryOptimizations: async () => ({ ignoring: false }), requestBatteryExemption: async () => (asked++, { ignoring: true }) })
  useStore.setState({ hosts: [] })
  installKeepAlive()
  useStore.setState({ hosts: [host('box')] })
  await settle()
  expect(asked).toBe(0)
})

test('Stop on the notification turns the setting off', () => {
  localStorage.setItem('inyon.keepAlive', '1')
  const listeners = phone()
  installKeepAlive()
  listeners.keepAliveStopped({ reason: 'stopped' })
  expect(keepAliveWanted()).toBe(false)
  expect(useStore.getState().toasts.map((t) => t.title)).toEqual(['Background connection off'])
})

test('Android stopping it leaves the setting on, to start again later', () => {
  localStorage.setItem('inyon.keepAlive', '1')
  const listeners = phone()
  installKeepAlive()
  listeners.keepAliveStopped({ reason: 'timeout' })
  expect(keepAliveWanted()).toBe(true)
  expect(useStore.getState().toasts.map((t) => t.title)).toEqual(['Background connection paused'])
})
