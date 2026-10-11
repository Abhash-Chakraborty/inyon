import { afterEach, expect, test } from 'bun:test'
import { installKeepAlive, keepAliveWanted } from './keepalive.ts'
import { useStore } from './store.ts'

type Listener = (e: any) => void

function phone() {
  const listeners: Record<string, Listener> = {}
  ;(window as any).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: {
      TetherDevice: {
        startKeepAlive: async () => ({ ok: true }),
        addListener: (event: string, fn: Listener) => ((listeners[event] = fn), Promise.resolve({ remove() {} })),
      },
    },
  }
  return listeners
}

afterEach(() => {
  delete (window as any).Capacitor
  localStorage.removeItem('tether.keepAlive')
  useStore.setState({ toasts: [] })
})

test('Stop on the notification turns the setting off', () => {
  localStorage.setItem('tether.keepAlive', '1')
  const listeners = phone()
  installKeepAlive()
  listeners.keepAliveStopped({ reason: 'stopped' })
  expect(keepAliveWanted()).toBe(false)
  expect(useStore.getState().toasts.map((t) => t.title)).toEqual(['Background connection off'])
})

test('Android stopping it leaves the setting on, to start again later', () => {
  localStorage.setItem('tether.keepAlive', '1')
  const listeners = phone()
  installKeepAlive()
  listeners.keepAliveStopped({ reason: 'timeout' })
  expect(keepAliveWanted()).toBe(true)
  expect(useStore.getState().toasts.map((t) => t.title)).toEqual(['Background connection paused'])
})
