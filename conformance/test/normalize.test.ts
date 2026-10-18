import { describe, expect, test } from 'bun:test'
import { Normalizer, RULES } from '../lib/normalize.ts'

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0)
const norm = () => new Normalizer(NOW)
const tested = new Set<string>()
const rule = (name: string, fn: () => void) => {
  tested.add(name)
  test(name, fn)
}

describe('rules', () => {
  rule('learned', () => {
    const n = norm()
    n.learn('tok_abcdef', 'token')
    n.learn('tok_abcdef_long', 'long-token')
    // longest first, so the shorter value inside the longer one doesn't split it
    expect(n.value({ a: 'Bearer tok_abcdef_long', b: 'x tok_abcdef y' })).toEqual({ a: 'Bearer <long-token>', b: 'x <token> y' })
    // too short to replace safely
    n.learn('abc', 'short')
    expect(n.string('abc')).toBe('abc')
    // numbered: one label per value
    n.learn('cookie-one', 'cookie', true)
    n.learn('cookie-two', 'cookie', true)
    expect(n.string('cookie-two cookie-one')).toBe('<cookie:2> <cookie:1>')
    // exact: only a whole string
    n.learnExact('box', 'hostname')
    expect(n.value({ name: 'box', text: 'a box of things' })).toEqual({ name: '<hostname>', text: 'a box of things' })
  })

  rule('uuid', () => {
    const n = norm()
    const a = '0C0FFEE0-1111-4222-8333-444455556666'
    const b = '11111111-2222-4333-8444-555555555555'
    expect(n.value([a, b, a.toLowerCase(), `inyon-${b}`])).toEqual(['<uuid:1>', '<uuid:2>', '<uuid:1>', 'inyon-<uuid:2>'])
  })

  rule('sha256', () => {
    const n = norm()
    const h = 'b481b581b3ecc9b55af5405cd8edf07ea1d6cd33c7be4b8b73db41b56594e2cb'
    expect(n.value({ sum: `${h}  inyon-linux-x64`, again: h })).toEqual({ sum: '<sha256:1>  inyon-linux-x64', again: '<sha256:1>' })
    // the harness's own hash of a long body is the content: kept
    expect(n.value({ contentSha256: h })).toEqual({ contentSha256: h })
  })

  rule('view-name', () => {
    expect(norm().string("new-session -s 'inyon-view-k3x9q1'")).toBe("new-session -s 'inyon-view-<random>'")
  })

  rule('codex-item-id', () => {
    const n = norm()
    const a = '2026-01-15T09:00:40.000Z:message:hpry8'
    const b = '2026-01-15T09:00:40.000Z:task_complete:0syju'
    expect(n.value({ uuid: a, msgId: a, next: b })).toEqual({ uuid: '2026-01-15T09:00:40.000Z:message:<rand:1>', msgId: '2026-01-15T09:00:40.000Z:message:<rand:1>', next: '2026-01-15T09:00:40.000Z:task_complete:<rand:2>' })
  })

  rule('mode-while-asked', () => {
    const n = norm()
    expect(n.value({ agent: { kind: 'claude', state: 'waiting', mode: 'manual' } })).toEqual({ agent: { kind: 'claude', state: 'waiting' } })
    // shown whenever the agent isn't asking
    expect(n.value({ agent: { kind: 'claude', state: 'idle', mode: 'manual' } })).toEqual({ agent: { kind: 'claude', state: 'idle', mode: 'manual' } })
  })

  rule('iso-time', () => {
    const n = norm()
    expect(n.string(`at ${new Date(NOW + 5000).toISOString()}`)).toBe('at <time>')
    // a fixture's date stays
    expect(n.string('2026-01-15T09:00:20.000Z')).toBe('2026-01-15T09:00:20.000Z')
  })

  rule('epoch', () => {
    const n = norm()
    expect(n.value({ updatedAt: NOW + 1234, exp: Math.floor(NOW / 1000) + 30 * 86400, old: Date.UTC(2026, 0, 15), small: 42 })).toEqual({ updatedAt: '<time>', exp: '<time:s>', old: Date.UTC(2026, 0, 15), small: 42 })
    // a cookie's expiry, 30 days ahead, is inside the window; a fixture timestamp is not
    expect(n.number(NOW + 30 * 86_400_000)).toBe('<time>')
    expect(n.number(1768467606000)).toBe(1768467606000)
  })

  rule('latency', () => {
    expect(norm().value({ latencyMs: 12, width: 12 })).toEqual({ latencyMs: '<ms>', width: 12 })
  })
})

test('every rule has a test', () => {
  expect([...tested].sort()).toEqual(RULES.map((r) => r.name).sort())
})

test('object keys are normalized too', () => {
  const n = norm()
  expect(n.value({ '0c0ffee0-1111-4222-8333-444455556666': 1 })).toEqual({ '<uuid:1>': 1 })
})

test('comparisons keep their own numbering', () => {
  const n = norm()
  const a = '0c0ffee0-1111-4222-8333-444455556666'
  const b = '11111111-2222-4333-8444-555555555555'
  // what key() sees first doesn't decide the transcript's numbers
  expect(n.key({ id: b })).toBe('{"id":"<uuid:1>"}')
  expect(n.value([a, b])).toEqual(['<uuid:1>', '<uuid:2>'])
  expect(n.key({ id: b })).toBe('{"id":"<uuid:1>"}')
})

test('values no rule matches are kept exactly', () => {
  const v = { error: 'That question is no longer on screen', status: 409, ok: true, none: null, list: ['a', 1] }
  expect(norm().value(v)).toEqual(v)
})
