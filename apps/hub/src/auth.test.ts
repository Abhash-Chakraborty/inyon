import { expect, setSystemTime, test } from 'bun:test'
import crypto from 'node:crypto'
import { clearCookie, clientAddress, closeSockets, holdSocket, isAuthed, issueCookie, recentSignIn, refreshCookie, revokeSession, tryLogin } from './auth.ts'
import { SLOW_LANE_MS } from './limits.ts'
import { sessionSecret, setPassword } from './password.ts'

setPassword('correct horse battery')
// signed in from here before the guessing starts: the shared cap mustn't lock it out
const home = await tryLogin('192.0.2.50', 'correct horse battery')

const errors = async (ip: string, n: number, password = 'wrong guess') =>
  (await Promise.all(Array.from({ length: n }, () => tryLogin(ip, password)))).map((r) => r.error)

test('guesses sent all at once are each counted', async () => {
  const out = await errors('203.0.113.1', 20)
  expect(out.filter((e) => e === 'Wrong password')).toHaveLength(8)
  expect(out.filter((e) => e?.startsWith('Too many'))).toHaveLength(12)
  // the right password doesn't get through either until the minute is up
  expect((await tryLogin('203.0.113.1', 'correct horse battery')).ok).toBe(false)
})

test('guesses spread over many addresses hit a shared cap, past which new addresses are slowed, not shut out', async () => {
  // 8 failures so far; 22 more are allowed across all addresses this minute, then one every few seconds
  const out = (await Promise.all(Array.from({ length: 10 }, (_, i) => errors(`198.51.100.${i}`, 4)))).flat()
  expect(out.filter((e) => e === 'Wrong password')).toHaveLength(23)
  const r = await tryLogin('192.0.2.7', 'correct horse battery')
  expect([r.ok, r.limited]).toEqual([false, true])
  // a few seconds on, a new address with the right password gets in; a wrong one is refused
  setSystemTime(new Date(Date.now() + SLOW_LANE_MS))
  try {
    expect((await tryLogin('192.0.2.7', 'correct horse battery')).ok).toBe(true)
    setSystemTime(new Date(Date.now() + SLOW_LANE_MS))
    expect((await tryLogin('192.0.2.8', 'not it')).error).toBe('Wrong password')
    expect((await tryLogin('192.0.2.9', 'correct horse battery')).limited).toBe(true)
  } finally {
    setSystemTime()
  }
})

test('past the shared cap, an address that signed in before and this machine carry on', async () => {
  expect(home.ok).toBe(true)
  expect((await tryLogin('192.0.2.11', 'correct horse battery')).limited).toBe(true)
  expect((await tryLogin('192.0.2.50', 'correct horse battery')).ok).toBe(true)
  expect((await tryLogin('127.0.0.1', 'correct horse battery')).ok).toBe(true)
  // its own limit still holds
  const out = await errors('192.0.2.50', 10)
  expect(out.filter((e) => e === 'Wrong password')).toHaveLength(8)
})

test('a cookie with no `at` never counts as a fresh sign-in, however recently it was refreshed', () => {
  const signed = (session: object) => {
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url')
    return new Request('http://hub/api/phones/pair', { headers: { cookie: `inyon_session=${payload}.${crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url')}` } })
  }
  const legacy = signed({ exp: Date.now() + 86_400_000, n: 'legacy', iat: Date.now() })
  expect(isAuthed(legacy)).toBe(true)
  expect(recentSignIn(legacy, 10 * 60_000)).toBe(false)
  expect(recentSignIn(signed({ exp: Date.now() + 86_400_000, n: 'fresh', iat: Date.now(), at: Date.now() }), 10 * 60_000)).toBe(true)
})

test('only the hop the local proxy added counts as the client', () => {
  expect(clientAddress('127.0.0.1', '1.2.3.4, 100.64.0.9')).toBe('100.64.0.9')
  expect(clientAddress('::1', ' 100.64.0.9 ')).toBe('100.64.0.9')
  expect(clientAddress('127.0.0.1', null)).toBe('127.0.0.1')
  // a client that isn't the proxy can't pick its own address
  expect(clientAddress('100.64.0.5', '127.0.0.1')).toBe('100.64.0.5')
})

test('signing out closes the connections that session already had open, and only those', () => {
  const signedIn = () => new Request('http://hub/ws', { headers: { cookie: issueCookie(false).split(';')[0] } })
  const [a, b] = [signedIn(), signedIn()]
  const closed: string[] = []
  const socket = (name: string) => ({ close: (code?: number) => void closed.push(`${name} ${code}`) })
  holdSocket(a, socket('phone'))
  holdSocket(a, socket('laptop'))
  const release = holdSocket(b, socket('other'))
  holdSocket(b, socket('another'))

  revokeSession(a)
  expect(closed).toEqual(['phone 4401', 'laptop 4401'])
  // a connection that already closed isn't closed again; a new password ends all the rest
  release()
  closeSockets()
  expect(closed).toEqual(['phone 4401', 'laptop 4401', 'another 4401'])
})

test('a cookie from before the rename to Inyon still signs you in, and comes back under the new name', () => {
  const value = issueCookie(false).split(';')[0]!.split('=')[1]!
  const old = new Request('http://hub/api/session', { headers: { cookie: `tether_session=${value}` } })
  expect(isAuthed(old)).toBe(true)
  expect(refreshCookie(old, false)).toStartWith('inyon_session=')
  // the new one, fresh, isn't sent again
  expect(refreshCookie(new Request('http://hub/api/session', { headers: { cookie: `inyon_session=${value}` } }), false)).toBeUndefined()
})

test('over HTTPS the cookie is __Host- prefixed and read before a plain one', () => {
  const secure = issueCookie(true)
  expect(secure).toStartWith('__Host-inyon_session=')
  expect(secure).toContain('; Path=/;')
  expect(secure).not.toContain('Domain')
  expect(clearCookie(true)).toBe('__Host-inyon_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure')
  expect(clearCookie()).toBe('inyon_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
  const value = secure.split(';')[0]!.split('=')[1]!
  // a junk inyon_session set by a neighbour doesn't hide the real one
  const both = new Request('https://hub/api/session', { headers: { cookie: `inyon_session=junk.value; __Host-inyon_session=${value}` } })
  expect(isAuthed(both)).toBe(true)
  expect(refreshCookie(both, true)).toBeUndefined()
  // a browser signed in before keeps its session, and gets it back under the new name over HTTPS
  const plain = new Request('https://hub/api/session', { headers: { cookie: `inyon_session=${value}` } })
  expect(isAuthed(plain)).toBe(true)
  expect(refreshCookie(plain, true)).toStartWith('__Host-inyon_session=')
  expect(refreshCookie(plain, false)).toBeUndefined()
})
