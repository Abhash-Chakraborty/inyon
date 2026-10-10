import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, checkPassword, sessionSecret } from './config.ts'

export const COOKIE = 'tether_session'
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
const REVOKED_FILE = path.join(DATA_DIR, 'revoked.json')
const revoked = new Map<string, number>(Object.entries(readRevoked()))
function readRevoked(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(REVOKED_FILE, 'utf8'))
  } catch {
    return {}
  }
}
function saveRevoked() {
  const now = Date.now()
  for (const [n, exp] of revoked) if (exp < now) revoked.delete(n)
  const tmp = `${REVOKED_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(revoked)), { mode: 0o600 })
  fs.renameSync(tmp, REVOKED_FILE)
}

function cookieFor(session: Session, secure: boolean) {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url')
  return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`
}

export function issueCookie(secure: boolean) {
  return cookieFor({ exp: Date.now() + MAX_AGE * 1000, n: crypto.randomUUID(), iat: Date.now() }, secure)
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`

function session(req: Request): Session | undefined {
  const raw = req.headers.get('cookie') ?? ''
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))
  if (!m) return
  const [payload, sig] = m[1].split('.')
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

/** A fresh expiry for a session in use, at most once a day (same nonce, so sign-out still ends it). */
export function refreshCookie(req: Request, secure: boolean) {
  const s = session(req)
  if (!s || Date.now() - (s.iat ?? 0) < REFRESH_AFTER_MS) return
  return cookieFor({ ...s, exp: Date.now() + MAX_AGE * 1000, iat: Date.now() }, secure)
}

/** Signing out ends the session everywhere it was copied, not just in this browser. */
export function revokeSession(req: Request) {
  const s = session(req)
  if (!s) return
  revoked.set(s.n, s.exp)
  saveRevoked()
}

// Slow down password guessing: a few attempts per minute per address.
const attempts = new Map<string, { n: number; reset: number }>()

export async function tryLogin(ip: string, password: string) {
  const now = Date.now()
  for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k)
  const a = attempts.get(ip)
  if (a && a.n >= 8) return { ok: false, error: 'Too many attempts. Try again in a minute.' }
  if (password.length <= 1024 && (await checkPassword(password))) {
    attempts.delete(ip)
    return { ok: true }
  }
  await Bun.sleep(400)
  if (!a) attempts.set(ip, { n: 1, reset: now + 60_000 })
  else a.n++
  return { ok: false, error: 'Wrong password' }
}
