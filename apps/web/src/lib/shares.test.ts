import { describe, expect, test } from 'bun:test'
import { addressOf, audience, checkLines, dnsRecord, expiresIn, fieldOf, mainDomainOf, nameAdvice, nameOf, proxyConfig, shareMeta, shareUrl, validName } from './shares.ts'

const NOW = Date.UTC(2026, 10, 5, 12)
const MIN = 60_000

describe('shared links in words', () => {
  test('when a link ends', () => {
    expect(expiresIn(NOW + 12 * MIN, NOW)).toBe('in 12 min')
    expect(expiresIn(NOW + 5 * 60 * MIN, NOW)).toBe('in 5 h')
    expect(expiresIn(NOW + 47 * 60 * MIN, NOW)).toBe('in 47 h')
    expect(expiresIn(NOW + 7 * 24 * 60 * MIN, NOW)).toBe('in 7 days')
    expect(expiresIn(NOW + 7 * 24 * 60 * MIN - 5 * MIN, NOW)).toBe('in 7 days')
    expect(expiresIn(NOW - MIN, NOW)).toBe('now')
  })

  test('who it is for, and its line: end, opens and when it was made', () => {
    const s = { id: 'a1', host: 'local', slug: 'plan', public: false, created: NOW - 24 * 60 * MIN, expires: NOW + 6 * 24 * 60 * MIN, opens: 1 }
    expect(audience(s)).toBe('Your network')
    expect(audience({ public: true })).toBe('Anyone with the link')
    expect(shareMeta(s, NOW)).toMatch(/^ends in 6 days · 1 open · made /)
    expect(shareMeta({ ...s, opens: 3 }, NOW)).toContain('3 opens')
  })

  test('a network link goes after the address the app reached the hub at; a link for anyone is kept as the hub gave it', () => {
    expect(shareUrl('local', '/share/abc/')).toBe(`${location.origin}/share/abc/`)
    expect(shareUrl('local', 'https://share.example.com/share/abc/')).toBe('https://share.example.com/share/abc/')
  })
})

describe('setting up the public address', () => {
  test('a typed name becomes an address, and back', () => {
    expect(addressOf(' share.example.com/ ')).toBe('https://share.example.com')
    expect(addressOf('http://10.0.0.5:8080')).toBe('http://10.0.0.5:8080')
    expect(addressOf('')).toBe('')
    expect(nameOf('https://Share.Example.com:8443')).toBe('share.example.com')
    expect(nameOf('share.example.com')).toBe('share.example.com')
    expect(nameOf('share.example.com.')).toBe('share.example.com')
  })

  test('the sheet starts with the saved address, keeping a scheme or port the bare name would lose', () => {
    expect(fieldOf('https://share.example.com')).toBe('share.example.com')
    expect(fieldOf('http://share.example.com')).toBe('http://share.example.com')
    expect(fieldOf('https://share.example.com:8443')).toBe('https://share.example.com:8443')
    expect(addressOf(fieldOf('http://share.example.com'))).toBe('http://share.example.com')
  })

  test('only a name a certificate can be made out to is saved', () => {
    expect(validName('share.example.com')).toBe(true)
    expect(validName('xn--bcher-kva.example')).toBe(true)
    for (const bad of ['share..example.com', 'share{.example.com', '-share.example.com', 'share-.example.com', 'share', 'a_b.example.com']) expect(validName(bad)).toBe(false)
    expect(nameAdvice('share..example.com', 'hub.example.com')).toMatch(/letters, digits and hyphens/)
    expect(nameAdvice('share{.example.com', 'hub.example.com')).toMatch(/letters, digits and hyphens/)
  })

  test('a subdomain is recommended over a main domain, an IP or the app\'s own address', () => {
    expect(mainDomainOf('share.example.com')).toBe('example.com')
    expect(mainDomainOf('share.example.co.uk')).toBe('example.co.uk')
    expect(nameAdvice('share.example.com', 'hub.example.com')).toBe('')
    expect(nameAdvice('example.com', 'hub.example.com')).toMatch(/main domain.*share\.example\.com/)
    expect(nameAdvice('example.co.uk', 'hub.example.com')).toMatch(/main domain/)
    expect(nameAdvice('hub.example.com', 'hub.example.com')).toMatch(/address you open Inyon at/)
    expect(nameAdvice('203.0.113.4', 'hub.example.com')).toMatch(/not an IP/)
    expect(nameAdvice('share', 'hub.example.com')).toMatch(/full name/)
  })

  test('the DNS record is the label under the main domain', () => {
    expect(dnsRecord('share.example.com')).toEqual({ type: 'A', name: 'share', zone: 'example.com' })
    expect(dnsRecord('plans.team.example.co.uk')).toEqual({ type: 'A', name: 'plans.team', zone: 'example.co.uk' })
  })

  test('every proxy example forwards only /share/ to the hub, and nginx keeps the Host header', () => {
    for (const k of ['caddy', 'traefik', 'nginx'] as const) {
      const c = proxyConfig(k, 'share.example.com', '127.0.0.1:4777')
      expect(c).toContain('share.example.com')
      expect(c).toContain('127.0.0.1:4777')
      expect(c).toContain('/share/')
    }
    expect(proxyConfig('caddy', 'share.example.com')).toContain('respond 404')
    expect(proxyConfig('traefik', 'share.example.com')).toContain('Host(`share.example.com`) && PathPrefix(`/share/`)')
    expect(proxyConfig('nginx', 'share.example.com')).toContain('proxy_set_header Host $host;')
    expect(proxyConfig('nginx', 'share.example.com')).toContain('return 404;')
  })

  test('a check reads as lines, stopping at the first thing that failed', () => {
    const base = { address: 'https://share.example.com', dns: { ok: true, addresses: ['203.0.113.4'] }, reach: { ok: true }, wall: { ok: true, open: [] } }
    expect(checkLines(base).map((l) => l.ok)).toEqual([true, true, true])
    expect(checkLines(base)[0]!.title).toBe('share.example.com points at 203.0.113.4')
    const noDns = checkLines({ ...base, dns: { ok: false, addresses: [] }, reach: { ok: false, fault: 'dns' } })
    expect(noDns).toHaveLength(1)
    expect(noDns[0]!.title).toMatch(/doesn't point anywhere/)
    expect(checkLines({ ...base, reach: { ok: false, fault: 'tls' } })[1]!.body).toMatch(/DNS only/)
    expect(checkLines({ ...base, reach: { ok: false, fault: 'not-hub', status: 421 } })[1]!.title).toBe('share.example.com answered 421, but not from this hub')
    expect(checkLines({ ...base, reach: { ok: false, fault: 'refused' } })[1]!.title).toMatch(/Nothing answers/)
    const open = checkLines({ ...base, wall: { ok: false, open: [{ path: '/', status: 200 }] } })
    expect(open[2]).toMatchObject({ ok: false, title: '/ answers there too' })
    // a path that didn't answer at all proves nothing
    const unsure = checkLines({ ...base, wall: { ok: false, open: [], unsure: ['/api/session'] } })
    expect(unsure[2]).toMatchObject({ ok: false, title: "Couldn't tell whether /api/session stays closed" })
  })
})
