import { isMachineId } from './identity.ts'

/**
 * What the phone needs to pair with a machine, carried by the QR code (or a link you paste):
 * the machine's id (its public key), a one-time secret that proves you were at the machine, and
 * the addresses it can be reached at right now.
 */
export interface PairInfo {
  id: string
  secret: string
  name: string
  /** wss:// or ws:// addresses of the machine's own listener (tunnel, LAN) */
  urls: string[]
  /** relays the machine keeps a connection to */
  relays: string[]
}

export function pairLink(p: PairInfo) {
  const q = new URLSearchParams({ m: p.id, s: p.secret, n: p.name })
  for (const u of p.urls) q.append('u', u)
  for (const r of p.relays) q.append('r', r)
  return `inyon://pair?${q}`
}

/** Reads a pairing link; undefined if it isn't one. */
export function parsePairLink(text: string): PairInfo | undefined {
  try {
    const url = new URL(text.trim())
    // tether:// is how codes looked before the rename to Inyon
    if (url.protocol !== 'inyon:' && url.protocol !== 'tether:' && url.protocol !== 'https:') return
    const q = url.searchParams
    const id = q.get('m') ?? ''
    const secret = q.get('s') ?? ''
    if (!isMachineId(id) || secret.length < 16) return
    const ok = (u: string) => /^wss?:\/\/[^\s/]+/.test(u) || /^https:\/\/[^\s/]+/.test(u)
    return {
      id,
      secret,
      name: (q.get('n') ?? '').slice(0, 64) || 'Machine',
      urls: q.getAll('u').filter(ok),
      relays: q.getAll('r').filter(ok),
    }
  } catch {
    return
  }
}
