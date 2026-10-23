import { afterEach, expect, test } from 'bun:test'
import { api } from './api.ts'
import { enablePush, rotatePush } from './push.ts'

// A browser with push: its service worker's push manager, which keeps one subscription tied to
// the key it was made with.
function browserWithPush() {
  let sub: { options: { applicationServerKey: ArrayBuffer }; endpoint: string; unsubscribe: () => Promise<boolean>; toJSON: () => unknown } | null = null
  const ended: string[] = []
  let n = 0
  const pushManager = {
    getSubscription: async () => sub,
    subscribe: async (o: { applicationServerKey: Uint8Array }) => {
      const endpoint = `https://push.example.net/${++n}`
      sub = {
        options: { applicationServerKey: o.applicationServerKey.slice().buffer },
        endpoint,
        unsubscribe: async () => (ended.push(endpoint), (sub = null), true),
        toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
      }
      return sub
    },
  }
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve({ pushManager }) }, configurable: true })
  ;(window as any).PushManager = class {}
  ;(window as any).Notification = { permission: 'granted' }
  return { ended, key: () => new Uint8Array(sub!.options.applicationServerKey) }
}

afterEach(() => {
  delete (navigator as any).serviceWorker
  delete (window as any).PushManager
  delete (window as any).Notification
})

test('once a computer is removed, the page signs with a new key and hands the computers left a new subscription', async () => {
  const b = browserWithPush()
  const first = await enablePush(true)
  expect(first.endpoint).toBe('https://push.example.net/1')
  const before = b.key()
  const handed = (api.push as any).mock.calls.at(-1)[0]
  // the same key the next time the page starts
  expect((await enablePush(true)).endpoint).toBe(first.endpoint)

  const after = await rotatePush(true)
  expect(after.endpoint).toBe('https://push.example.net/2')
  expect(b.ended).toEqual(['https://push.example.net/1'])
  expect(b.key()).not.toEqual(before)
  const now = (api.push as any).mock.calls.at(-1)[0]
  expect(now.vapid.privateJwk.d).not.toBe(handed.vapid.privateJwk.d)
  expect(now.subscription.endpoint).toBe('https://push.example.net/2')
})
