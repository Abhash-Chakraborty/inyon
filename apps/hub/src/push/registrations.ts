import { HttpError } from '../hosts/registry.ts'
import { kv, sha256Hex } from '../platform/store.ts'
import type { PushSubscriptionJSON, Vapid } from './webpush.ts'

/**
 * The browsers that asked for notifications while they're closed. A hub sends to them itself; the
 * web app, which has no server, hands its own to every paired computer, and each computer sends
 * when its agents need you (see node-push.ts and apps/node/push.ts).
 */
export interface Registration {
  subscription: PushSubscriptionJSON
  vapid: Vapid
  /** notices when an agent finishes too, not only when it needs you */
  done: boolean
  at: number
}

const key = (endpoint: string) => `push/${sha256Hex(endpoint).slice(0, 32)}`

export function registrations(): Registration[] {
  return kv.keys('push/').map((k) => kv.get<Registration>(k)).filter((r): r is Registration => !!r?.subscription?.endpoint)
}

/** Checks what a browser sent: an https endpoint, its two keys, and a P-256 private key. */
export function validRegistration(b: any): Registration {
  const s = b?.subscription
  const jwk = b?.vapid?.privateJwk
  const bad = (what: string) => {
    throw new HttpError(400, `Bad push registration: ${what}`)
  }
  if (typeof s?.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 2048) bad('endpoint')
  if (typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') bad('keys')
  if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') bad('VAPID key')
  const subject = String(b.vapid.subject ?? '')
  if (!/^(mailto:|https:\/\/)/.test(subject)) bad('VAPID subject')
  return {
    subscription: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
    vapid: { privateJwk: { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y }, subject },
    done: b.done !== false,
    at: Date.now(),
  }
}

export function addRegistration(r: Registration) {
  kv.set(key(r.subscription.endpoint), r)
  changed()
}

export function removeRegistration(endpoint: string) {
  kv.del(key(endpoint))
  changed()
}

const listeners = new Set<() => void>()
export const onRegistrations = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn))
const changed = () => listeners.forEach((l) => l())

/** What a notification needs: the text, the tag that replaces an earlier one, where a tap opens. */
export interface PushPayload {
  title: string
  body: string
  tag: string
  href: string
  kind: 'waiting' | 'done' | 'offline' | 'online' | 'test'
}

/** The same tag and link the open app uses (apps/web/src/lib/store.ts), so one replaces the other. */
export function payloadFor(e: { host: string; pane: string; kind: PushPayload['kind']; title: string; body: string }): PushPayload {
  const machine = !e.pane
  return {
    title: e.title,
    body: e.body,
    kind: e.kind,
    tag: machine ? `machine:${e.host}` : `${e.host}:${e.pane}`,
    href: machine ? `/machines/${encodeURIComponent(e.host)}` : `/m/${encodeURIComponent(e.host)}/p/${e.pane.replace(/^%/, '')}`,
  }
}
