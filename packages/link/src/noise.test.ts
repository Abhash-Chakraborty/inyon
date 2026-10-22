import { expect, test } from 'bun:test'
import { x25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { Initiator, Responder, generateKeyPair, type KeyPair } from './noise.ts'

// Noise_IK_25519_ChaChaPoly_SHA256 from the cacophony test vectors
// (github.com/haskell-cryptography/cacophony, vectors/cacophony.txt)
const V = {
  "init_prologue": "4a6f686e2047616c74",
  "init_static": "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
  "init_ephemeral": "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  "init_remote_static": "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62",
  "resp_static": "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
  "resp_ephemeral": "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
  "handshake_hash": "0b0f68fb0c27e03ce9b97565995ed4838cc0581b762ef72b062f6a546419fad7",
  "messages": [
    {
      "payload": "4c756477696720766f6e204d69736573",
      "ciphertext": "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944718da798efbcd91528520204f904b9bd6c7413dccdc214d951e15253e39987f18146e8cd0873654207148333479d4d16c289f0294b29960a72f48e0b7bba2e89083169825e59642148d492020664ccf7"
    },
    {
      "payload": "4d757272617920526f746862617264",
      "ciphertext": "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088435361e70b2ed446e6c9ec387d1d6b3b840f194e373979d241b203c4acafccf5"
    },
    {
      "payload": "462e20412e20486179656b",
      "ciphertext": "050e9f3c8fac16b68dbce8f8c4bfbf6617c897f9ada4aa29aa19c8"
    },
    {
      "payload": "4361726c204d656e676572",
      "ciphertext": "344233a6cabb7141d80f3da2fedc311d9646bbb0f505afe403a667"
    },
    {
      "payload": "4a65616e2d426170746973746520536179",
      "ciphertext": "62cdeeb172ad7ade7aa7d9e069da5790f12331bfa00177787a1d0810c67dc3b2b4"
    },
    {
      "payload": "457567656e2042f6686d20766f6e2042617765726b",
      "ciphertext": "029bead1b40992327044d409d9a1f3ad8f36c3c452775d557e18bbeb2e8dfcead32d514024"
    }
  ]
}

const pair = (hex: string): KeyPair => {
  const secretKey = hexToBytes(hex)
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

test('matches the published IK test vector', () => {
  const prologue = hexToBytes(V.init_prologue)
  const i = new Initiator(pair(V.init_static), hexToBytes(V.init_remote_static), prologue, pair(V.init_ephemeral))
  const r = new Responder(pair(V.resp_static), prologue, pair(V.resp_ephemeral))
  const [m1, m2, ...rest] = V.messages

  const c1 = i.writeMessage1(hexToBytes(m1.payload))
  expect(bytesToHex(c1)).toBe(m1.ciphertext)
  expect(bytesToHex(r.readMessage1(c1))).toBe(m1.payload)
  expect(bytesToHex(r.remoteStatic!)).toBe(bytesToHex(pair(V.init_static).publicKey))

  const { message: c2, transport: rt } = r.writeMessage2(hexToBytes(m2.payload))
  expect(bytesToHex(c2)).toBe(m2.ciphertext)
  const { payload, transport: it } = i.readMessage2(c2)
  expect(bytesToHex(payload)).toBe(m2.payload)
  expect(bytesToHex(it.hash)).toBe(V.handshake_hash)
  expect(bytesToHex(rt.hash)).toBe(V.handshake_hash)

  // transport messages alternate, starting with the initiator
  rest.forEach((m, n) => {
    const [from, to] = n % 2 === 0 ? [it, rt] : [rt, it]
    const c = from.send.encrypt(new Uint8Array(0), hexToBytes(m.payload))
    expect(bytesToHex(c)).toBe(m.ciphertext)
    expect(bytesToHex(to.recv.decrypt(new Uint8Array(0), c))).toBe(m.payload)
  })
})

test('a caller with the wrong idea of the machine key fails', () => {
  const machine = generateKeyPair()
  const i = new Initiator(generateKeyPair(), generateKeyPair().publicKey)
  const r = new Responder(machine)
  expect(() => r.readMessage1(i.writeMessage1(new Uint8Array(3)))).toThrow()
})

test('a tampered message is rejected', () => {
  const machine = generateKeyPair()
  const i = new Initiator(generateKeyPair(), machine.publicKey)
  const r = new Responder(machine)
  r.readMessage1(i.writeMessage1(new Uint8Array(0)))
  const { message } = r.writeMessage2(new Uint8Array(0))
  message[40] ^= 1
  expect(() => i.readMessage2(message)).toThrow()
})

test('a low-order key never gives a DH result, as the Rust responder refuses it too', () => {
  const machine = generateKeyPair()
  for (const low of ['00'.repeat(32), 'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800']) {
    // noble throws on an all-zero shared secret, so a message 1 carrying such a key can't be read
    expect(() => x25519.getSharedSecret(machine.secretKey, hexToBytes(low))).toThrow()
    const msg = new Uint8Array(32 + 32 + 16 + 16)
    msg.set(hexToBytes(low))
    expect(() => new Responder(machine).readMessage1(msg)).toThrow()
  }
})
