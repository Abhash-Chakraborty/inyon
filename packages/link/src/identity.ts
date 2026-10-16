import { ed25519 } from '@noble/curves/ed25519.js'
import type { KeyPair } from './noise.ts'

/**
 * A machine's or phone's identity: one ed25519 seed. Its public key, in z-base-32, is the
 * machine's id (the same form pkarr uses, so the id is also where its addresses are published),
 * and the matching X25519 key is its Noise static key.
 */
export interface Identity {
  seed: Uint8Array
  publicKey: Uint8Array
  id: string
  noise: KeyPair
}

export function identityFromSeed(seed: Uint8Array): Identity {
  const publicKey = ed25519.getPublicKey(seed)
  return {
    seed,
    publicKey,
    id: z32encode(publicKey),
    noise: { secretKey: ed25519.utils.toMontgomerySecret(seed), publicKey: ed25519.utils.toMontgomery(publicKey) },
  }
}

export const newIdentity = () => identityFromSeed(ed25519.utils.randomSecretKey())

/** The Noise static key that belongs to a machine id. */
export const noiseKeyOf = (id: string) => ed25519.utils.toMontgomery(z32decode(id))

export const sign = (identity: Identity, msg: Uint8Array) => ed25519.sign(msg, identity.seed)
export const verify = (id: string | Uint8Array, msg: Uint8Array, sig: Uint8Array) => {
  try {
    return ed25519.verify(sig, msg, typeof id === 'string' ? z32decode(id) : id)
  } catch {
    return false
  }
}

// z-base-32 (philzimmermann.com/docs/human-oriented-base-32-encoding.txt)
const ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769'

export function z32encode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function z32decode(text: string): Uint8Array {
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of text.toLowerCase()) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) throw new Error('Not an Inyon machine id')
    value = (value << 5) | v
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/**
 * A 32-byte public key's id is 52 lowercase characters, spelt the way the key encodes: the last
 * character carries four padding bits, so 16 spellings decode to the same key and only the one
 * with them zero counts. Otherwise the same machine could be saved twice under different ids.
 */
export const isMachineId = (s: string) => /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/.test(s) && z32encode(z32decode(s)) === s
