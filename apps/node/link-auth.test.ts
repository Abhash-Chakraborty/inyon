import { expect, test } from 'bun:test'
import { authMessage, authMessageV2 } from '@inyon/link'
import { relayAuth } from './link.ts'

// The relay is the untrusted side: what it sends is checked as JSON gives it, not as the types say.
const nonce = 'b9f7c1d2e3a4f5061728394a5b6c7d8e'

test('a relay challenge is answered only with a long string nonce, bound to the relay for v2', () => {
  expect(relayAuth('https://relay.example', nonce, undefined)).toEqual(authMessage(nonce))
  expect(relayAuth('https://relay.example/base/', nonce, 2)).toEqual(authMessageV2('https://relay.example', nonce))
  expect(relayAuth('https://relay.example', 'abc123', 2)).toBeUndefined()
  expect(relayAuth('https://relay.example', 1234567890123456789, undefined)).toBeUndefined()
  expect(relayAuth('https://relay.example', undefined, undefined)).toBeUndefined()
  // "2" is not a version: v1, as the Rust engine reads it
  expect(relayAuth('https://relay.example', nonce, '2')).toEqual(authMessage(nonce))
  expect(relayAuth('relay.example', nonce, 2)).toBeUndefined()
})
