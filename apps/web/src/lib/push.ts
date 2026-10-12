import { WEB_URL } from '@inyon/protocol'
import { api } from './api.ts'
import { appHref } from './base.ts'
import { isNative } from './native.ts'
import { useStore } from './store.ts'

/**
 * Notifications while Inyon is closed, in a browser or as an installed web app (the Android app
 * has its own). Once notifications are allowed, the page subscribes with the browser's push
 * service and hands the subscription to whoever sends: a hub sends itself, and in the web app each
 * paired computer does. No server of Inyon's is involved, and the push service sees only
 * ciphertext.
 *
 * A subscription is tied to one signing (VAPID) key, and every computer has to sign with the same
 * one, so this page makes the key and hands it out with the subscription.
 */

/** Safari only has push for an app added to the Home Screen; elsewhere it needs HTTPS and a worker. */
export const pushSupported = () =>
  !isNative() && typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

const KEY = 'inyon.push-vapid'
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

/** This browser's VAPID key, made once. The public half is 0x04 ‖ x ‖ y. */
async function vapidKey(): Promise<{ jwk: JsonWebKey; raw: Uint8Array<ArrayBuffer> }> {
  let jwk: JsonWebKey | undefined
  try {
    jwk = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? undefined
  } catch {}
  if (!jwk?.d) {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair
    jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    try {
      localStorage.setItem(KEY, JSON.stringify(jwk))
    } catch {}
  }
  const raw = new Uint8Array(65)
  raw[0] = 4
  raw.set(unb64u(jwk.x!), 1)
  raw.set(unb64u(jwk.y!), 33)
  return { jwk: { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y }, raw }
}

const same = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((v, i) => v === b[i])

async function worker() {
  return Promise.race([navigator.serviceWorker.ready, new Promise<undefined>((r) => setTimeout(r, 10_000, undefined))])
}

/** Subscribes (or reuses the subscription) and hands it over; the endpoint, or why not. */
export async function enablePush(done = useStore.getState().settings.notifyDone): Promise<{ endpoint?: string; error?: string }> {
  if (!pushSupported()) return { error: 'unsupported' }
  if (Notification.permission !== 'granted') return { error: 'not allowed' }
  try {
    const reg = await worker()
    if (!reg) return { error: 'no service worker' }
    const key = await vapidKey()
    let sub = await reg.pushManager.getSubscription()
    // one made with another key can't be signed for: start over
    if (sub && !same(sub.options.applicationServerKey, key.raw)) {
      await sub.unsubscribe().catch(() => {})
      sub = null
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key.raw })
    const json = sub.toJSON() as PushSubscriptionJSON
    await api.push({ subscription: json, vapid: { privateJwk: key.jwk, subject: WEB_URL }, done })
    return { endpoint: sub.endpoint }
  } catch (err) {
    return { error: (err as Error).message || 'failed' }
  }
}

/** A test through the push service: how many senders delivered it (0 if push isn't on). */
export async function testPush() {
  const r = await enablePush()
  if (!r.endpoint) return 0
  return (await api.pushTest(r.endpoint).catch(() => ({ sent: 0 }))).sent
}

/** Hands the subscription over at start (subscriptions can change) and when the setting changes. */
export function watchPush() {
  if (!pushSupported()) return
  // a tapped notification, with the app already open: go to its session
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.t !== 'open' || typeof e.data.href !== 'string' || !e.data.href.startsWith('/')) return
    window.history.pushState({}, '', appHref(e.data.href))
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  let done = useStore.getState().settings.notifyDone
  void enablePush(done)
  useStore.subscribe((s) => {
    if (s.settings.notifyDone === done) return
    done = s.settings.notifyDone
    void enablePush(done)
  })
}

