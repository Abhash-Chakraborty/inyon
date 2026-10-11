import { afterEach, describe, expect, mock, test } from 'bun:test'
import { askNativeNotifications, installNative, nativeNotificationsOn, nativeNotify, readClipboard } from './native.ts'

const flush = () => new Promise((r) => setTimeout(r, 0))
type Listener = (e: any) => void

/** A fake shell: plugins as plain objects of promise-returning methods, plus their listeners. */
function app(plugins: Record<string, Record<string, (...a: any[]) => any>>) {
  const listeners: Record<string, Listener[]> = {}
  for (const [name, p] of Object.entries(plugins)) {
    p.addListener = (event: string, fn: Listener) => {
      ;(listeners[`${name}.${event}`] ||= []).push(fn)
      return Promise.resolve({ remove() {} })
    }
  }
  ;(window as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: plugins }
  return (key: string, e: unknown) => listeners[key]?.forEach((f) => f(e))
}

const realClipboard = navigator.clipboard

afterEach(() => {
  delete (window as any).Capacitor
  Object.defineProperty(navigator, 'clipboard', { value: realClipboard, configurable: true })
  window.history.replaceState({}, '', '/')
})

describe('notifications', () => {
  test('posted through the Android app, with its kind for the buttons', async () => {
    const postNotification = mock(async (_o: unknown) => ({ ok: true, posted: true }))
    app({ TetherDevice: { postNotification } })
    expect(await nativeNotify('claude is waiting', 'approve?', '/m/box/p/3', 'box:%3', 'waiting')).toBe(true)
    expect(postNotification).toHaveBeenCalledWith({ title: 'claude is waiting', body: 'approve?', href: '/m/box/p/3', tag: 'box:%3', kind: 'waiting' })
  })

  test('false when notifications are off or the app is too old to post them', async () => {
    app({ TetherDevice: { postNotification: async () => ({ posted: false }) } })
    expect(await nativeNotify('t', 'b', '/')).toBe(false)
    app({ TetherDevice: {} })
    expect(await nativeNotify('t', 'b', '/')).toBe(false)
    delete (window as any).Capacitor
    expect(await nativeNotify('t', 'b', '/')).toBe(false)
  })

  test('permission is asked and checked through the Android app', async () => {
    app({ TetherDevice: { requestNotificationPermission: async () => ({ granted: true }), notificationsEnabled: async () => ({ enabled: false }) } })
    expect(await askNativeNotifications()).toBe(true)
    expect(await nativeNotificationsOn()).toBe(false)
    delete (window as any).Capacitor
    expect(await askNativeNotifications()).toBeUndefined()
    expect(await nativeNotificationsOn()).toBeUndefined()
  })
})

describe('installNative', () => {
  test('a tapped notification opens its link, while running and from a cold start', async () => {
    const emit = app({ TetherDevice: { takeLaunchHref: async () => ({ href: '/m/box/p/1' }) }, App: { getLaunchUrl: async () => undefined } })
    installNative()
    await flush()
    expect(location.pathname).toBe('/m/box/p/1')
    emit('TetherDevice.pushOpened', { href: '/m/box/p/2' })
    expect(location.pathname).toBe('/m/box/p/2')
  })

  test('a pairing link that started the app opens the pairing sheet', async () => {
    app({ TetherDevice: { takeLaunchHref: async () => ({ href: null }) }, App: { getLaunchUrl: async () => ({ url: 'tether://pair?c=abc' }) } })
    installNative()
    await flush()
    expect(location.pathname + location.search).toBe(`/machines?pair=${encodeURIComponent('tether://pair?c=abc')}`)
  })

  test('back closes an open sheet before leaving the screen', async () => {
    const exitApp = mock(() => {})
    const back = mock(() => {})
    const realBack = window.history.back
    window.history.back = back
    const emit = app({ App: { exitApp, getLaunchUrl: async () => undefined } })
    installNative()
    const close = (e: Event) => e.preventDefault()
    window.addEventListener('tether:back', close)
    emit('App.backButton', { canGoBack: true })
    expect(back).not.toHaveBeenCalled()
    window.removeEventListener('tether:back', close)
    emit('App.backButton', { canGoBack: false })
    expect(exitApp).toHaveBeenCalledTimes(1)
    window.history.back = realBack
  })
})

describe('readClipboard', () => {
  test('reads natively in the Android app', async () => {
    const readText = mock(async () => 'browser')
    Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true })
    app({ TetherDevice: { readClipboardText: async () => ({ text: 'from android' }) } })
    expect(await readClipboard()).toBe('from android')
    expect(readText).not.toHaveBeenCalled()
  })

  test('uses the browser clipboard elsewhere, or when the native read fails', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => 'browser' }, configurable: true })
    expect(await readClipboard()).toBe('browser')
    app({ TetherDevice: { readClipboardText: async () => Promise.reject(new Error('focus')) } })
    expect(await readClipboard()).toBe('browser')
  })
})
