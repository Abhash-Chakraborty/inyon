import crypto from 'node:crypto'
import { checkPassword, sessionSecret } from './password.ts'
import { kv } from './platform/store.ts'

export const COOKIE = 'inyon_session'
/** the cookie's name before the rename to Inyon: still signs you in, and is swapped for the new one */
const OLD_COOKIE = 'tether_session'
/** a session ends after 30 days without use; using it pushes the end back (see refreshCookie) */
const MAX_AGE = 60 * 60 * 24 * 30
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

const sign = (payload: string) => crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url')

interface Session {
  exp: number
  n: string
  /** when this cookie was issued */
  iat?: number
}

// signed-out sessions, by nonce, until they would have expired anyway
const revoked = new Map<string, number>(Object.entries(kv.get<Record<string, number>>('revoked') ?? {}))
function saveRevoked() {
  const now = Date.now()
  for (const [n, exp] of revoked) if (exp < now) revoked.delete(n)
  kv.set('revoked', Object.fromEntries(revoked))
}

function cookieFor(session: Session, secure: boolean) {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url')
  return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`
}

export function issueCookie(secure: boolean) {
  return cookieFor({ exp: Date.now() + MAX_AGE * 1000, n: crypto.randomUUID(), iat: Date.now() }, secure)
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`

const cookieValue = (raw: string, name: string) => raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1]
const credential = (req: Request) => cookieValue(req.headers.get('cookie') ?? '', COOKIE) ?? cookieValue(req.headers.get('cookie') ?? '', OLD_COOKIE)
const oldCookieOnly = (req: Request) => !cookieValue(req.headers.get('cookie') ?? '', COOKIE)

function session(req: Request): Session | undefined {
  const value = credential(req)
  if (!value) return
  const [payload, sig] = value.split('.')
  if (!payload || !sig) return
  const expected = sign(payload)
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Session
    return s.exp > Date.now() && !revoked.has(s.n) ? s : undefined
  } catch {
    return
  }
}

export const isAuthed = (req: Request) => !!session(req)

// open connections, by the session they signed in with: a cookie is only checked when a
// connection opens, so ending a session has to close the ones it already has
const sockets = new Map<{ close(code?: number, reason?: string): void }, string>()

/** Keeps `socket` until it closes, so signing out (or a new password) can end it. */
export function holdSocket(req: Request, socket: { close(code?: number, reason?: string): void }) {
  const s = session(req)
  if (s) sockets.set(socket, s.n)
  return () => void sockets.delete(socket)
}

/** Closes the connections of one session, or of every session when `nonce` is left out. */
export function closeSockets(nonce?: string) {
  for (const [socket, n] of sockets) {
    if (nonce !== undefined && n !== nonce) continue
    sockets.delete(socket)
    try {
      socket.close(4401, 'Signed out')
    } catch {}
  }
}

/** A fresh expiry for a session in use, at most once a day (same nonce, so sign-out still ends it). */
export function refreshCookie(req: Request, secure: boolean) {
  const s = session(req)
  if (!s || (Date.now() - (s.iat ?? 0) < REFRESH_AFTER_MS && !oldCookieOnly(req))) return
  return cookieFor({ ...s, exp: Date.now() + MAX_AGE * 1000, iat: Date.now() }, secure)
}

/** Signing out ends the session everywhere it was copied, not just in this browser. */
export function revokeSession(req: Request) {
  const s = session(req)
  if (!s) return
  revoked.set(s.n, s.exp)
  saveRevoked()
  closeSockets(s.n)
}

// Slow down password guessing: a few attempts per minute per address, and a cap on failures from
// all addresses together, so guesses spread over many addresses can't go faster either.
const PER_CLIENT = 8
const ALL_CLIENTS = 30
const attempts = new Map<string, { n: number; reset: number }>()
const failures = { n: 0, reset: 0 }

export async function tryLogin(ip: string, password: string) {
  const now = Date.now()
  for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k)
  if (failures.reset < now) Object.assign(failures, { n: 0, reset: now + 60_000 })
  let a = attempts.get(ip)
  if (!a) attempts.set(ip, (a = { n: 0, reset: now + 60_000 }))
  if (a.n >= PER_CLIENT || failures.n >= ALL_CLIENTS) return { ok: false, error: 'Too many attempts. Try again in a minute.' }
  // counted before the slow hash, so guesses sent all at once are each counted
  a.n++
  failures.n++
  if (password.length <= 1024 && (await checkPassword(password))) {
    attempts.delete(ip)
    failures.n = Math.max(0, failures.n - 1)
    return { ok: true }
  }
  await Bun.sleep(400)
  return { ok: false, error: 'Wrong password' }
}

/**
 * The address to count sign-in attempts against. Behind a local proxy every request comes from
 * loopback and X-Forwarded-For names the client. Only its last entry, the one the proxy added,
 * can be trusted: a client can send any entries before it.
 */
export function clientAddress(peer: string, forwardedFor: string | null) {
  if (!/^(127\.|::1$|::ffff:127\.)/.test(peer)) return peer
  return forwardedFor?.split(',').at(-1)?.trim() || peer
}
