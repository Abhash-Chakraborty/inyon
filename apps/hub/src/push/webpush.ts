import crypto from 'node:crypto'

/**
 * Web Push without a push server of ours: a browser that allows notifications subscribes with
 * its own push service (Google's for Chrome, Apple's for Safari, Mozilla's for Firefox) and gets
 * an endpoint plus two keys. Anyone holding those can send it a message, encrypted to the browser
 * (RFC 8291), so the push service only ever carries ciphertext. A VAPID key (RFC 8292) signs each
 * request; the browser makes it and hands it out with the subscription, since a subscription is
 * tied to one key and every paired computer has to sign with that same key.
 *
 * This runs in Bun (on each computer, and on a hub), never in the page.
 */

export interface PushSubscriptionJSON {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** A P-256 private key as JWK, as the browser exports it. */
export interface EcJwk {
  kty: 'EC'
  crv: 'P-256'
  d: string
  x: string
  y: string
}

/** The browser's VAPID key pair. */
export interface Vapid {
  privateJwk: EcJwk
  /** who to contact about these pushes: a mailto: or https: address (Apple requires one) */
  subject: string
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

/** The 65-byte public key (0x04 ‖ x ‖ y) of a P-256 JWK, as the browser's applicationServerKey. */
export const vapidPublicKey = (jwk: { x: string; y: string }) => b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]))

/** A signed VAPID token for one push service (the endpoint's origin), good for 12 hours. */
export function vapidAuth(endpoint: string, v: Vapid, now = Date.now()) {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: v.subject })))
  const key = crypto.createPrivateKey({ key: { ...v.privateJwk }, format: 'jwk' })
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapidPublicKey(v.privateJwk)}`
}

/** Encrypts a message to the browser's keys (RFC 8291, aes128gcm, one record). */
export function encrypt(sub: PushSubscriptionJSON, plaintext: Uint8Array, fixed?: { salt: Uint8Array; senderKey: Uint8Array }) {
  const uaPublic = unb64u(sub.keys.p256dh)
  const auth = unb64u(sub.keys.auth)
  if (uaPublic.length !== 65 || auth.length < 16) throw new Error('Bad push subscription keys')
  // a new key and salt for every message; fixed ones only for the RFC's test vector
  const ecdh = crypto.createECDH('prime256v1')
  if (fixed) ecdh.setPrivateKey(fixed.senderKey)
  else ecdh.generateKeys()
  const salt = fixed?.salt ?? crypto.randomBytes(16)
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  const hkdf = (ikm: Uint8Array, s: Uint8Array, info: Uint8Array, len: number) => new Uint8Array(crypto.hkdfSync('sha256', ikm, s, info, len))
  const ikm = hkdf(shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32)
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02 marks the last (and only) record
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(4096)
  return new Uint8Array(Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]))
}

export interface Sent {
  ok: boolean
  status: number
  /** the subscription is gone (unsubscribed, expired): stop sending to it */
  gone: boolean
}

/** Sends one message. `urgency: high` lets it through a phone's battery saver. */
export async function sendPush(sub: PushSubscriptionJSON, payload: unknown, v: Vapid, o: { ttl?: number; fetch?: typeof fetch } = {}): Promise<Sent> {
  const url = new URL(sub.endpoint)
  if (url.protocol !== 'https:') throw new Error('Push endpoints are https')
  const res = await (o.fetch ?? fetch)(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuth(sub.endpoint, v),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(o.ttl ?? 4 * 3600),
      Urgency: 'high',
    },
    body: encrypt(sub, new TextEncoder().encode(JSON.stringify(payload))),
  })
  await res.arrayBuffer().catch(() => {})
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 }
}
