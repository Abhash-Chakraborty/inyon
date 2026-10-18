import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { x25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { identityFromSeed, sign, verify } from './identity.ts'
import { Initiator, Responder } from './noise.ts'
import { parsePairLink } from './pair.ts'
import { decodePublished } from './pkarr.ts'
import { parseShortCode } from './code.ts'
import { buildVectors, FIXTURES, serialize } from './vectors.ts'

// The Rust port is tested against these files, so the TS code must still produce every byte of
// them. If a change here is on purpose, it breaks the wire with phones and machines that haven't
// updated: regenerate with `bun packages/link/src/vectors.ts` only once that is settled.

const read = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'))
const built = await buildVectors()

for (const name of Object.keys(built)) {
  test(`fixtures/link/${name}.json is what the TS code produces`, () => {
    expect(read(name)).toEqual(JSON.parse(serialize(built[name])))
  })
}

// The same files read the other way: each side takes the other's bytes.

const pair = (hex: string) => {
  const secretKey = hexToBytes(hex)
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

test('each side of a recorded handshake reads the other side', () => {
  for (const c of read('noise').cases) {
    const r = new Responder(pair(c.responder_static), hexToBytes(c.prologue), pair(c.responder_ephemeral))
    expect(bytesToHex(r.readMessage1(hexToBytes(c.message1)))).toBe(c.payload1)
    expect(bytesToHex(r.remoteStatic!)).toBe(c.initiator_static_public)
    const i = new Initiator(pair(c.initiator_static), hexToBytes(c.responder_static_public), hexToBytes(c.prologue), pair(c.initiator_ephemeral))
    i.writeMessage1(hexToBytes(c.payload1))
    const { payload, transport } = i.readMessage2(hexToBytes(c.message2))
    expect(bytesToHex(payload)).toBe(c.payload2)
    expect(bytesToHex(transport.hash)).toBe(c.handshake_hash)
  }
})

test('recorded signatures, pkarr bodies, links and codes read the same', () => {
  const id = read('identity')
  for (const v of id.identities) {
    const me = identityFromSeed(hexToBytes(v.seed))
    for (const s of v.signatures) {
      expect(bytesToHex(sign(me, hexToBytes(s.message)))).toBe(s.signature)
      expect(verify(v.id, hexToBytes(s.message), hexToBytes(s.signature))).toBe(true)
    }
  }
  for (const v of id.verifications) expect(verify(v.id, hexToBytes(v.message), hexToBytes(v.signature))).toBe(v.valid)
  for (const d of read('pkarr').decode) {
    const p = decodePublished(d.id, hexToBytes(d.body))
    expect(p ? { ...p, machine: p.machine ?? null, name: p.name ?? null } : null).toEqual(d.result)
  }
  for (const p of read('pair').parse) expect(parsePairLink(p.text) ?? null).toEqual(p.result)
  for (const p of read('code').parse) expect(parseShortCode(p.text) ?? null).toEqual(p.result)
})
