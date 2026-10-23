import { kv } from './platform/store.ts'

/**
 * The shared part of the guess limits (password, current password, setup code, companion codes).
 * Each has a cap per address and one for all addresses together, so guesses spread over many
 * addresses can't go faster. The shared cap used to be a hard stop, which let anyone who reaches
 * the hub lock the owner out with 30 wrong guesses a minute. Now, past it:
 * - an address that signed in with the password in the last 30 days (and this machine) carries on
 *   under its own per-address limit, and
 * - any other address gets one try every few seconds, shared by all of them, so a new address is
 *   slowed down rather than shut out, and spreading guesses still gains next to nothing.
 */

const KNOWN_FOR_MS = 30 * 24 * 60 * 60 * 1000
const KNOWN_MAX = 64
/** past the shared cap, one try from an unknown address per this long */
export const SLOW_LANE_MS = 4000

const known = new Map<string, number>(Object.entries(kv.get<Record<string, number>>('signin-addresses') ?? {}))
const slowLane = new Map<string, number>()
const warned = new Map<string, number>()

const loopback = (ip: string) => /^(127\.|::1$|::ffff:127\.)/.test(ip)

/** This machine, or an address the password was typed from in the last 30 days. */
export function knownAddress(ip: string, now = Date.now()) {
  return loopback(ip) || (known.get(ip) ?? 0) > now - KNOWN_FOR_MS
}

/** Remembers an address the right password came from. */
export function rememberAddress(ip: string, now = Date.now()) {
  if (!ip || ip === '?' || loopback(ip)) return
  known.delete(ip)
  known.set(ip, now)
  for (const [k, at] of known) if (at <= now - KNOWN_FOR_MS || known.size > KNOWN_MAX) known.delete(k)
  kv.set('signin-addresses', Object.fromEntries(known))
}

/**
 * Whether a try from `ip` may go ahead while `failures` (the shared count for `what`) stands at
 * `n` against `cap`. Below the cap, always; past it, see the top of this file.
 */
export function sharedCapAllows(what: string, ip: string, n: number, cap: number, now = Date.now()) {
  if (n < cap || knownAddress(ip, now)) return true
  // the owner should see an attack in the log: once a minute at most
  if ((warned.get(what) ?? 0) <= now - 60_000) {
    warned.set(what, now)
    console.warn(`${cap} wrong ${what} tries in a minute from several addresses: addresses that signed in before carry on, others get one try every ${SLOW_LANE_MS / 1000} s until it calms down`)
  }
  if (now - (slowLane.get(what) ?? 0) < SLOW_LANE_MS) return false
  slowLane.set(what, now)
  return true
}

/** For tests: forget the slow lanes and warnings (not the known addresses). */
export function resetSharedCaps() {
  slowLane.clear()
  warned.clear()
}
