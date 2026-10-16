import { scryptAsync } from '@noble/hashes/scrypt.js'
import { identityFromSeed, isMachineId } from './identity.ts'
import type { PairInfo } from './pair.ts'
import { PKARR_RELAYS, publish, resolve } from './pkarr.ts'

/**
 * Pairing by typing instead of scanning (a server whose SSH session is on the same phone, or a
 * camera that won't focus): a one-time ID and a 6-digit code, like "K7Q4-MX2T" and "493812".
 *
 * The ID and the code together find the machine. Run through scrypt, they give a throwaway key, and
 * the machine publishes a record under that key naming its real id and addresses, through the same
 * pkarr relays it uses for its own address. Someone who only has the ID can't publish a record of
 * their own in its place, and can't tell which record is the machine's without trying codes: each
 * try costs a slow derivation and a relay lookup, out of a million. The code is also the pairing
 * secret: it travels inside the Noise channel to the machine the record named, and the machine
 * drops it after a few wrong tries or ten minutes.
 */
export interface ShortCode {
  /** 8 characters of Crockford base32, without the dash */
  id: string
  /** 6 digits */
  code: string
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

function digits(n: number) {
  let out = ''
  while (out.length < n) {
    // 250 = 25 * 10: rejecting the rest keeps every digit equally likely
    for (const b of random(n)) if (b < 250 && out.length < n) out += String(b % 10)
  }
  return out
}

export function newShortCode(): ShortCode {
  return { id: [...random(8)].map((b) => CROCKFORD[b & 31]).join(''), code: digits(6) }
}

export const formatShortId = (id: string) => `${id.slice(0, 4)}-${id.slice(4)}`

/** The secret the phone sends: the ID and code together, so a code only works with its own ID. */
export const shortSecret = (c: ShortCode) => `${c.id}:${c.code}`

/** People mix up 0/O and 1/I/L when copying an ID off a terminal. */
const cleanId = (s: string) => s.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V')

/** Reads "K7Q4-MX2T 493812" (in any spacing or case); undefined if it isn't an ID and code. */
export function parseShortCode(text: string): ShortCode | undefined {
  const m = /^\s*([0-9A-Za-z]{4})[\s-]*([0-9A-Za-z]{4})[\s:,-]*(\d{3})[\s-]*(\d{3})\s*$/.exec(text)
  if (!m) return
  const id = cleanId(m[1]! + m[2]!)
  if (![...id].every((ch) => CROCKFORD.includes(ch))) return
  return { id, code: m[3]! + m[4]! }
}

/**
 * The throwaway key an ID and code stand for. scrypt at these settings takes 16 MiB and tens of
 * milliseconds a try, so going through the million codes behind an ID is real work on top of the
 * relay lookups. Records from before this scheme are under other keys and are ignored.
 */
export const shortCodeIdentity = async (c: ShortCode) =>
  identityFromSeed(await scryptAsync(shortSecret(c), 'inyon-pair-id:v2', { N: 2 ** 14, r: 8, p: 1, dkLen: 32 }))

/** Machine side: tells the relays which machine this ID stands for, and where it is. */
export async function publishShortCode(c: ShortCode, rec: { machine: string; name: string; urls: string[]; relays: string[] }, relays = PKARR_RELAYS, fetcher: typeof fetch = fetch) {
  await publish(await shortCodeIdentity(c), rec, relays, fetcher)
}

/** Phone side: what pairing needs, from the ID and code alone; undefined if no machine publishes under them. */
export async function resolveShortCode(c: ShortCode, relays = PKARR_RELAYS, fetcher: typeof fetch = fetch): Promise<PairInfo | undefined> {
  const rec = await resolve((await shortCodeIdentity(c)).id, relays, fetcher)
  if (!rec?.machine || !isMachineId(rec.machine)) return
  return { id: rec.machine, secret: shortSecret(c), name: rec.name || 'Computer', urls: rec.urls, relays: rec.relays }
}
