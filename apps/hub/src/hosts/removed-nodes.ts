import crypto from 'node:crypto'
import { kv } from '../platform/store.ts'

/**
 * Token hashes of machines removed from this hub. A machine that was off when it was removed
 * learns it's gone the next time it calls, and takes its own service down, while one whose token
 * the hub simply doesn't know (a hub that lost its data) keeps trying.
 */
const KEY = 'removed-nodes'
const KEEP = 500

const list = () => kv.get<string[]>(KEY) ?? []

export function rememberRemoved(tokenHash: string | undefined) {
  if (!tokenHash) return
  kv.set(KEY, [...list().filter((h) => h !== tokenHash), tokenHash].slice(-KEEP))
}

export const wasRemoved = (tokenHash: string) =>
  !!tokenHash && list().some((h) => h.length === tokenHash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(tokenHash)))
