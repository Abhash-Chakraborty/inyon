import crypto from 'node:crypto'
import { checkPassword, sessionSecret } from './config.ts'

export const COOKIE = 'tether_session'
const MAX_AGE = 60 * 60 * 24 * 180 // 180 days: stay signed in on your own devices

const sign = (payload: string) => crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url')

export function issueCookie(secure: boolean) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + MAX_AGE * 1000, n: crypto.randomUUID() })).toString('base64url')
  const token = `${payload}.${sign(payload)}`
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`

export function isAuthed(req: Request) {
  const raw = req.headers.get('cookie') ?? ''
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))
  if (!m) return false
  const [payload, sig] = m[1].split('.')
  if (!payload || !sig) return false
  const expected = sign(payload)
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now()
  } catch {
    return false
  }
}

// Slow down password guessing: a few attempts per minute per address.
const attempts = new Map<string, { n: number; reset: number }>()

export async function tryLogin(ip: string, password: string) {
  const now = Date.now()
  const a = attempts.get(ip)
  if (a && a.reset > now && a.n >= 8) return { ok: false, error: 'Too many attempts. Try again in a minute.' }
  if (checkPassword(password)) {
    attempts.delete(ip)
    return { ok: true }
  }
  await Bun.sleep(400)
  if (!a || a.reset < now) attempts.set(ip, { n: 1, reset: now + 60_000 })
  else a.n++
  return { ok: false, error: 'Wrong password' }
}
