import crypto from 'node:crypto'
import fs from 'node:fs'

/**
 * The SHA-256 of the certificate the hub serves itself (the first in TLS_CERT, as DER), in
 * lowercase hex, as a browser shows it without the colons. Undefined on plain http, and behind a
 * proxy, which serves its own. Read once per file, when the hub starts serving it (index.ts), so a
 * file replaced while the hub runs can't put a certificate it doesn't serve in a link.
 */
export function servedFingerprint(cert = process.env.TLS_CERT && process.env.TLS_KEY ? process.env.TLS_CERT : undefined): string | undefined {
  if (!cert) return undefined
  if (!read.has(cert)) read.set(cert, fingerprintOf(cert))
  return read.get(cert)
}
const read = new Map<string, string | undefined>()

function fingerprintOf(cert: string) {
  try {
    return new crypto.X509Certificate(fs.readFileSync(cert)).fingerprint256.replace(/:/g, '').toLowerCase()
  } catch {
    return undefined
  }
}
