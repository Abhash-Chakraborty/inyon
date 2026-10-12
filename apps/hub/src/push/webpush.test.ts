import { expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { encrypt, sendPush, vapidAuth, vapidPublicKey, type EcJwk } from './webpush.ts'

const u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

// RFC 8291, Appendix A
const rfc = {
  plaintext: 'When I grow up, I want to be a watermelon',
  senderKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

test('encrypts the RFC 8291 example byte for byte', () => {
  const out = encrypt({ endpoint: 'https://push.example.net/x', keys: { p256dh: rfc.uaPublic, auth: rfc.auth } }, new TextEncoder().encode(rfc.plaintext), { salt: u(rfc.salt), senderKey: u(rfc.senderKey) })
  expect(Buffer.from(out).toString('base64url')).toBe(rfc.body)
})

test('every message gets a fresh key and salt', () => {
  const sub = { endpoint: 'https://push.example.net/x', keys: { p256dh: rfc.uaPublic, auth: rfc.auth } }
  const a = encrypt(sub, new Uint8Array([1]))
  const b = encrypt(sub, new Uint8Array([1]))
  expect(Buffer.from(a.slice(0, 16)).equals(Buffer.from(b.slice(0, 16)))).toBe(false)
  expect(Buffer.from(a.slice(21, 86)).equals(Buffer.from(b.slice(21, 86)))).toBe(false)
})

test('a VAPID token for the push service, signed with the key it names', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' }) as EcJwk
  const auth = vapidAuth('https://fcm.googleapis.com/fcm/send/abc', { privateJwk: jwk, subject: 'https://example.com/' }, 1_700_000_000_000)
  const [, t, k] = auth.match(/^vapid t=([^,]+), k=(.+)$/)!
  expect(k).toBe(vapidPublicKey(jwk))
  const [h, c, sig] = t!.split('.')
  expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 12 * 3600, sub: 'https://example.com/' })
  expect(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'))).toBe(true)
})

test('a gone subscription says so', async () => {
  const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }) as EcJwk
  const sub = { endpoint: 'https://push.example.net/x', keys: { p256dh: rfc.uaPublic, auth: rfc.auth } }
  let headers: Headers | undefined
  const fake = (async (_u: string, init: RequestInit) => ((headers = new Headers(init.headers)), new Response('', { status: 410 }))) as unknown as typeof fetch
  const r = await sendPush(sub, { title: 'x' }, { privateJwk: jwk, subject: 'mailto:me@example.com' }, { fetch: fake })
  expect(r).toEqual({ ok: false, status: 410, gone: true })
  expect(headers!.get('content-encoding')).toBe('aes128gcm')
  expect(headers!.get('urgency')).toBe('high')
})
