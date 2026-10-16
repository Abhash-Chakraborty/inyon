import crypto from 'node:crypto'
import { kv } from './platform/store.ts'

// The hub's sign-in password and the secret that signs its sessions (the phone app has neither).
interface HubRecord {
  secret: string
  passwordHash?: string
  salt?: string
}

let hub = kv.get<HubRecord>('hub') ?? { secret: '' }
if (!hub.secret) {
  hub.secret = crypto.randomBytes(32).toString('hex')
  kv.set('hub', hub)
}

export const sessionSecret = () => hub.secret

export function hashPassword(password: string, salt: string) {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}

export function setPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex')
  // rotating the secret signs everyone out
  hub = { secret: crypto.randomBytes(32).toString('hex'), salt, passwordHash: hashPassword(password, salt) }
  kv.set('hub', hub)
}

export function hasPassword() {
  return !!hub.passwordHash
}

/** Async so a burst of guesses doesn't block the hub while scrypt runs. */
export async function checkPassword(password: string) {
  // one record throughout: setPassword may swap `hub` while scrypt runs
  const { salt, passwordHash } = hub
  if (!passwordHash || !salt) return false
  const hash = await new Promise<Buffer>((ok, fail) => crypto.scrypt(password, salt, 64, (e, k) => (e ? fail(e) : ok(k))))
  const b = Buffer.from(passwordHash, 'hex')
  return hash.length === b.length && crypto.timingSafeEqual(hash, b)
}

/** A password you can type on a phone, and long enough not to guess. */
export const passwordProblem = (pw: string) =>
  pw.length < 8 ? 'Use at least 8 characters.' : pw.length > 1024 ? 'That password is too long.' : undefined
