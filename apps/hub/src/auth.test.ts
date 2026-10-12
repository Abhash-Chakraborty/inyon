import { expect, test } from 'bun:test'
import { clientAddress, closeSockets, holdSocket, isAuthed, issueCookie, refreshCookie, revokeSession, tryLogin } from './auth.ts'
import { setPassword } from './password.ts'

setPassword('correct horse battery')

const errors = async (ip: string, n: number, password = 'wrong guess') =>
  (await Promise.all(Array.from({ length: n }, () => tryLogin(ip, password)))).map((r) => r.error)

test('guesses sent all at once are each counted', async () => {
  const out = await errors('203.0.113.1', 20)
  expect(out.filter((e) => e === 'Wrong password')).toHaveLength(8)
  expect(out.filter((e) => e?.startsWith('Too many'))).toHaveLength(12)
  // the right password doesn't get through either until the minute is up
  expect((await tryLogin('203.0.113.1', 'correct horse battery')).ok).toBe(false)
})

test('guesses spread over many addresses hit a shared cap', async () => {
  // 8 failures so far; 22 more are allowed across all addresses this minute
  const out = (await Promise.all(Array.from({ length: 10 }, (_, i) => errors(`198.51.100.${i}`, 4)))).flat()
  expect(out.filter((e) => e === 'Wrong password')).toHaveLength(22)
  expect((await tryLogin('192.0.2.7', 'correct horse battery')).ok).toBe(false)
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
