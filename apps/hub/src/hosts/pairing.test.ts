import { expect, test } from 'bun:test'
import { PAIR_TOKEN_MS, tokenExpired } from './registry.ts'

test('an unused pairing token stops working after a day; a used one keeps working', () => {
  const now = Date.now()
  const node = { id: 'n', name: 'N', kind: 'node' as const, tokenHash: 'h', tokenIssuedAt: now - PAIR_TOKEN_MS - 1 }
  expect(tokenExpired(node, now)).toBe(true)
  expect(tokenExpired({ ...node, tokenIssuedAt: now - PAIR_TOKEN_MS + 60_000 }, now)).toBe(false)
  expect(tokenExpired({ ...node, pairedAt: now - 2 * PAIR_TOKEN_MS }, now)).toBe(false)
  expect(tokenExpired({ ...node, kind: 'ssh' as const }, now)).toBe(false)
})
