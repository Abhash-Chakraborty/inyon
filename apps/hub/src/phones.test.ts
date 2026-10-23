import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { servedFingerprint } from './tls.ts'
import { VERSION } from '@inyon/protocol'
import { HttpError } from './hosts/registry.ts'
import { claimPhone, CODE_TTL, holdPhoneSocket, hubId, issueTicket, listPhones, newPairCode, phoneFor, redeemTicket, revokePhone, TICKET_TTL } from './phones.ts'

// Pairing against a fixed clock; the hub's HTTP side is covered in index.test.ts.
const T0 = 1_700_000_000_000
const HUB = 'http://localhost:4777'
const asPhone = (token: string) => new Request('http://hub/api/phones', { headers: { authorization: `Bearer ${token}` } })
const refused = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    return err as HttpError
  }
  throw new Error('went through')
}
const pair = (ip: string, name = 'Phone', now = T0) => {
  const c = newPairCode(HUB, now)
  return { c, r: claimPhone(ip, { code: `${c.id}:${c.code}`, name }, now) }
}

test('a code names the hub, and only an http(s) origin makes one', () => {
  const c = newPairCode('https://hub.example:4777/', T0)
  expect(c.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
  expect(c.code).toMatch(/^\d{6}$/)
  expect(c.expiresAt).toBe(T0 + CODE_TTL)
  const link = new URL(c.link)
  expect(link.protocol).toBe('inyon:')
  expect(link.searchParams.get('u')).toBe('https://hub.example:4777')
  expect(link.searchParams.get('c')).toBe(`${c.id}:${c.code}`)
  expect(link.searchParams.get('n')).not.toBe('')
  // the phone shows the hub's id before it pairs; plain http has no certificate to show
  expect(link.searchParams.get('h')).toBe(hubId())
  expect(link.searchParams.has('f')).toBe(false)
  for (const bad of ['ftp://hub.example', 'javascript:alert(1)', 'https://hub.example/app', 'hub.example', '', undefined]) expect(refused(() => newPairCode(bad)).status).toBe(400)
})

test('a claim works once, with the id in any case, and the token signs that phone in', () => {
  const c = newPairCode(HUB, T0)
  const r = claimPhone('10.0.0.1', { code: `${c.id.toLowerCase()}:${c.code}`, name: '  Pixel  ' }, T0 + 1000)
  expect(r.token).toHaveLength(43)
  expect(r.hub).toEqual({ id: hubId(), name: expect.any(String), version: VERSION })
  expect(hubId()).toMatch(/^[0-9a-f]{16}$/)
  const phone = phoneFor(asPhone(r.token), T0 + 1000)!
  expect(phone.name).toBe('Pixel')
  expect(phoneFor(asPhone(r.token.slice(1)))).toBeUndefined()
  expect(phoneFor(new Request('http://hub/api/phones', { headers: { authorization: `Basic ${r.token}` } }))).toBeUndefined()
  // the code is spent
  const again = refused(() => claimPhone('10.0.0.1', { code: `${c.id}:${c.code}`, name: 'Again' }, T0 + 2000))
  expect(again.status).toBe(404)
  expect(again.message).toBe('That code has expired. Show a new one on the hub.')
  // listed for everyone, marked for the phone asking
  expect(listPhones(asPhone(r.token), T0 + 1000).find((p) => p.id === phone.id)).toEqual({ id: phone.id, name: 'Pixel', pairedAt: T0 + 1000, lastSeen: T0 + 1000, thisPhone: true })
  expect(listPhones(new Request('http://hub/api/phones')).some((p) => p.thisPhone)).toBe(false)
})

test('lastSeen moves on at most once a minute', () => {
  const { r } = pair('10.0.0.2')
  expect(phoneFor(asPhone(r.token), T0 + 30_000)!.lastSeen).toBe(T0)
  expect(phoneFor(asPhone(r.token), T0 + 60_000)!.lastSeen).toBe(T0 + 60_000)
  expect(phoneFor(asPhone(r.token), T0 + 90_000)!.lastSeen).toBe(T0 + 60_000)
})

test('five wrong digits cancel the code; unknown, expired and garbled codes read alike', () => {
  const c = newPairCode(HUB, T0)
  const wrong = String((Number(c.code) + 1) % 1_000_000).padStart(6, '0')
  for (let i = 0; i < 5; i++) {
    const e = refused(() => claimPhone('10.0.0.3', { code: `${c.id}:${wrong}`, name: 'x' }, T0))
    expect(e.status).toBe(401)
  }
  expect(refused(() => claimPhone('10.0.0.3', { code: `${c.id}:${c.code}`, name: 'x' }, T0)).status).toBe(404)
  const d = newPairCode(HUB, T0)
  expect(refused(() => claimPhone('10.0.0.4', { code: `${d.id}:${d.code}`, name: 'x' }, T0 + CODE_TTL)).status).toBe(404)
  expect(refused(() => claimPhone('10.0.0.4', { code: 'not a code' }, T0)).status).toBe(404)
  expect(refused(() => claimPhone('10.0.0.4', {}, T0)).status).toBe(404)
})

test('an address gets eight failed claims a minute', () => {
  const c = newPairCode(HUB, T0)
  for (let i = 0; i < 8; i++) expect(refused(() => claimPhone('10.0.0.5', { code: 'ZZZZZZZZ:000000', name: 'x' }, T0 + i)).status).toBe(404)
  expect(refused(() => claimPhone('10.0.0.5', { code: `${c.id}:${c.code}`, name: 'x' }, T0 + 10)).status).toBe(429)
  // another address is not held up, and after the minute the code (still good) goes through
  expect(refused(() => claimPhone('10.0.0.6', { code: 'ZZZZZZZZ:000000', name: 'x' }, T0 + 10)).status).toBe(404)
  expect(claimPhone('10.0.0.5', { code: `${c.id}:${c.code}`, name: 'x' }, T0 + 60_001).token).toBeString()
})

test('a ticket opens one connection, within thirty seconds', () => {
  const { r } = pair('10.0.0.7')
  const phone = phoneFor(asPhone(r.token))!
  const t = issueTicket(phone.id, T0)
  expect(redeemTicket(t, T0 + 1000)?.id).toBe(phone.id)
  expect(redeemTicket(t, T0 + 1000)).toBeUndefined()
  expect(redeemTicket(issueTicket(phone.id, T0), T0 + TICKET_TTL)).toBeUndefined()
  expect(redeemTicket('made-up')).toBeUndefined()
})

test('removing a phone ends its token, its tickets and its connections', () => {
  const { r } = pair('10.0.0.8', 'Doomed')
  const phone = phoneFor(asPhone(r.token))!
  const closed: string[] = []
  const socket = (name: string) => ({ close: (code?: number, reason?: string) => void closed.push(`${name} ${code} ${reason}`) })
  holdPhoneSocket(phone.id, socket('tab'))
  const release = holdPhoneSocket(phone.id, socket('gone already'))
  release()
  const { r: other } = pair('10.0.0.9', 'Other')
  holdPhoneSocket(phoneFor(asPhone(other.token))!.id, socket('other phone'))
  const ticket = issueTicket(phone.id, T0)

  expect(revokePhone(phone.id)).toBe(true)
  expect(closed).toEqual(['tab 4001 Phone removed'])
  expect(phoneFor(asPhone(r.token))).toBeUndefined()
  expect(redeemTicket(ticket, T0)).toBeUndefined()
  expect(listPhones(asPhone(other.token)).map((p) => p.name)).not.toContain('Doomed')
  expect(revokePhone(phone.id)).toBe(false)
})

test("a hub serving HTTPS itself puts its certificate's SHA-256 in the link", () => {
  const dir = mkdtempSync(join(tmpdir(), 'inyon-tls-'))
  const made = Bun.spawnSync(['sh', '-c', 'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout k.pem -out c.pem -days 2 -subj /CN=hub'], { cwd: dir, stderr: 'pipe' })
  expect(made.exitCode).toBe(0)
  const der = Buffer.from(readFileSync(join(dir, 'c.pem'), 'utf8').replace(/-----[^-]+-----|\s/g, ''), 'base64')
  const sha = createHash('sha256').update(der).digest('hex')
  Object.assign(process.env, { TLS_CERT: join(dir, 'c.pem'), TLS_KEY: join(dir, 'k.pem') })
  try {
    expect(servedFingerprint()).toBe(sha)
    expect(new URL(newPairCode('https://hub.example', T0).link).searchParams.get('f')).toBe(sha)
    // a new file under a running hub isn't what it serves, so links keep the one it loaded
    expect(Bun.spawnSync(['sh', '-c', 'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout k.pem -out c.pem -days 2 -subj /CN=other'], { cwd: dir }).exitCode).toBe(0)
    expect(servedFingerprint()).toBe(sha)
  } finally {
    delete process.env.TLS_CERT
    delete process.env.TLS_KEY
    rmSync(dir, { recursive: true, force: true })
  }
  expect(servedFingerprint()).toBeUndefined()
})
