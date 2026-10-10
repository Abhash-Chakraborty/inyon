import { x25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { concatBytes } from '@noble/hashes/utils.js'

/**
 * Noise_IK_25519_ChaChaPoly_SHA256 (noiseprotocol.org, revision 34). The phone already knows the
 * machine's static key from pairing, so one round trip both authenticates the two sides and
 * agrees on transport keys. Messages travel over an ordered transport (a WebSocket, directly or
 * through a relay), so nonces are implicit counters.
 *
 *   <- s
 *   ...
 *   -> e, es, s, ss
 *   <- e, ee, se
 */

const NAME = new TextEncoder().encode('Noise_IK_25519_ChaChaPoly_SHA256')
const DH = 32
const TAG = 16
const MAX_NONCE = 2n ** 64n - 1n

export interface KeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export const generateKeyPair = (): KeyPair => {
  const { secretKey, publicKey } = x25519.keygen()
  return { secretKey, publicKey }
}

const dh = (kp: KeyPair, pub: Uint8Array) => x25519.getSharedSecret(kp.secretKey, pub)

/** Noise's HKDF: two or three 32-byte outputs from the chaining key. */
function hkdf(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(sha256, ck, ikm)
  const o1 = hmac(sha256, temp, Uint8Array.of(1))
  const o2 = hmac(sha256, temp, concatBytes(o1, Uint8Array.of(2)))
  return [o1, o2]
}

function nonce(n: bigint) {
  // 32 zero bits, then the counter as 64-bit little-endian
  const b = new Uint8Array(12)
  new DataView(b.buffer).setBigUint64(4, n, true)
  return b
}

/** One direction of a transport: a key and its message counter. */
export class CipherState {
  private n = 0n
  constructor(private k?: Uint8Array) {}

  get hasKey() {
    return !!this.k
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.k) return plaintext
    if (this.n >= MAX_NONCE) throw new Error('Noise: nonce exhausted')
    return chacha20poly1305(this.k, nonce(this.n++), ad).encrypt(plaintext)
  }

  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.k) return ciphertext
    if (this.n >= MAX_NONCE) throw new Error('Noise: nonce exhausted')
    // a failed decrypt throws before the counter moves, as the spec requires
    const out = chacha20poly1305(this.k, nonce(this.n), ad).decrypt(ciphertext)
    this.n++
    return out
  }
}

class SymmetricState {
  h: Uint8Array
  ck: Uint8Array
  cs = new CipherState()

  constructor() {
    // the protocol name is exactly 32 bytes, so it is h as is
    this.h = NAME.slice()
    this.ck = NAME.slice()
  }

  mixHash(data: Uint8Array) {
    this.h = sha256(concatBytes(this.h, data))
  }

  mixKey(ikm: Uint8Array) {
    const [ck, k] = hkdf(this.ck, ikm)
    this.ck = ck
    this.cs = new CipherState(k)
  }

  encryptAndHash(plaintext: Uint8Array) {
    const c = this.cs.encrypt(this.h, plaintext)
    this.mixHash(c)
    return c
  }

  decryptAndHash(ciphertext: Uint8Array) {
    const p = this.cs.decrypt(this.h, ciphertext)
    this.mixHash(ciphertext)
    return p
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, new Uint8Array(0))
    return [new CipherState(k1), new CipherState(k2)]
  }
}

export interface Transport {
  send: CipherState
  recv: CipherState
  /** the handshake hash, the same on both sides (channel binding) */
  hash: Uint8Array
}

/** The phone's side: it knows the machine's static key before it connects. */
export class Initiator {
  private ss = new SymmetricState()

  /** `e` is only passed by the test vectors */
  constructor(private s: KeyPair, private rs: Uint8Array, prologue = new Uint8Array(0), private e = generateKeyPair()) {
    this.ss.mixHash(prologue)
    this.ss.mixHash(rs)
  }

  /** -> e, es, s, ss, payload */
  writeMessage1(payload: Uint8Array): Uint8Array {
    const { ss, e, s, rs } = this
    ss.mixHash(e.publicKey)
    ss.mixKey(dh(e, rs))
    const encS = ss.encryptAndHash(s.publicKey)
    ss.mixKey(dh(s, rs))
    const encP = ss.encryptAndHash(payload)
    return concatBytes(e.publicKey, encS, encP)
  }

  /** <- e, ee, se, payload */
  readMessage2(msg: Uint8Array): { payload: Uint8Array; transport: Transport } {
    const { ss, e, s } = this
    if (msg.length < DH + TAG) throw new Error('Noise: message 2 too short')
    const re = msg.subarray(0, DH)
    ss.mixHash(re)
    ss.mixKey(dh(e, re))
    ss.mixKey(dh(s, re))
    const payload = ss.decryptAndHash(msg.subarray(DH))
    const [send, recv] = ss.split()
    return { payload, transport: { send, recv, hash: ss.h } }
  }
}

/** The machine's side: it learns who is calling from message 1. */
export class Responder {
  private ss = new SymmetricState()
  private re?: Uint8Array
  /** the caller's static key, known after message 1 */
  remoteStatic?: Uint8Array

  /** `e` is only passed by the test vectors */
  constructor(private s: KeyPair, prologue = new Uint8Array(0), private e = generateKeyPair()) {
    this.ss.mixHash(prologue)
    this.ss.mixHash(s.publicKey)
  }

  /** -> e, es, s, ss, payload */
  readMessage1(msg: Uint8Array): Uint8Array {
    const { ss, s } = this
    if (msg.length < DH + DH + TAG + TAG) throw new Error('Noise: message 1 too short')
    const re = (this.re = msg.subarray(0, DH).slice())
    ss.mixHash(re)
    ss.mixKey(dh(s, re))
    const rs = ss.decryptAndHash(msg.subarray(DH, DH + DH + TAG))
    this.remoteStatic = rs
    ss.mixKey(dh(s, rs))
    return ss.decryptAndHash(msg.subarray(DH + DH + TAG))
  }

  /** <- e, ee, se, payload */
  writeMessage2(payload: Uint8Array): { message: Uint8Array; transport: Transport } {
    const { ss, e } = this
    if (!this.re || !this.remoteStatic) throw new Error('Noise: read message 1 first')
    ss.mixHash(e.publicKey)
    ss.mixKey(dh(e, this.re))
    ss.mixKey(dh(e, this.remoteStatic))
    const encP = ss.encryptAndHash(payload)
    const [recv, send] = ss.split()
    return { message: concatBytes(e.publicKey, encP), transport: { send, recv, hash: ss.h } }
  }
}
