import { ed25519 } from '@noble/curves/ed25519.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { INSTALL_URL, RELEASE_KEY, RELEASES_REPO } from '@inyon/protocol'

/**
 * Checks a minisign signature (a .minisig file) over `data` with `key` (the base64 line of a .pub
 * file), as `minisign -V` and the inyon command do. Only the hashed kind ("ED": Ed25519 over the
 * BLAKE2b-512 of the data), which today's minisign and the release workflow make, is accepted, and
 * the trusted comment must carry its own signature too.
 */
export function verifyMinisign(data: Uint8Array | string, sig: string, key: string): boolean {
  try {
    const k = Buffer.from(key.trim(), 'base64')
    if (k.length !== 42 || k.subarray(0, 2).toString('latin1') !== 'Ed') return false
    const lines = sig.split(/\r?\n/).map((l) => l.trim())
    if (!lines[0]?.startsWith('untrusted comment:') || !lines[2]?.startsWith('trusted comment: ')) return false
    const s = Buffer.from(lines[1]!, 'base64')
    if (s.length !== 74 || s.subarray(0, 2).toString('latin1') !== 'ED' || !s.subarray(2, 10).equals(k.subarray(2, 10))) return false
    const pk = k.subarray(10)
    const signature = s.subarray(10)
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    if (!ed25519.verify(signature, blake2b(bytes), pk)) return false
    const global = Buffer.from(lines[3] ?? '', 'base64')
    const trusted = Buffer.from(lines[2]!.slice('trusted comment: '.length), 'utf8')
    return global.length === 64 && ed25519.verify(global, Buffer.concat([signature, trusted]), pk)
  } catch {
    return false
  }
}

/** Whether `base` is where real releases come from: the website, or the releases on GitHub. */
// the website's earlier address, which redirects every path to INSTALL_URL, still counts as the website
const OLD_SITE_HOST = 'inyon.abhashchakraborty.tech'

function official(base: string) {
  try {
    const u = new URL(base.trim().toLowerCase())
    return u.hostname === new URL(INSTALL_URL).hostname || u.hostname === OLD_SITE_HOST || (['github.com', 'www.github.com'].includes(u.hostname) && u.pathname.startsWith(`/${RELEASES_REPO.toLowerCase()}/releases/`))
  } catch {
    return false
  }
}

/**
 * The key the release at `base` must be signed with. Only somewhere other than the real releases
 * (a mock release in tests and the container runs) may INYON_SIGNING_KEY name another, as for
 * `inyon update`, so an environment variable alone can't change the key for the real thing.
 */
export function signingKey(base: string) {
  if (!official(base)) {
    const line = process.env.INYON_SIGNING_KEY?.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('untrusted comment:')).pop()
    if (line) return line
  }
  return RELEASE_KEY
}
