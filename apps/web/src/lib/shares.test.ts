import { describe, expect, test } from 'bun:test'
import { audience, expiresIn, shareMeta, shareUrl } from './shares.ts'

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
