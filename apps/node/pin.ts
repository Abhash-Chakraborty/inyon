import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { nodeDir } from './paths.ts'

/**
 * The certificate of a hub that made it itself (setup's LAN choice), pinned, as the built-in
 * engine does (crates/inyon-engine/src/hub_tls.rs). `inyon join` keeps the copy whose sha256 the
 * hub's Add a machine command named in ~/.inyon/node/hub.crt, and the connection to that hub, and
 * to nothing else, accepts exactly that certificate. It's never an authority: nothing it could sign
 * is trusted. A certificate the hub gets later from an authority still counts the usual way.
 *
 * Bun's WebSocket and fetch can't be given a check of their own, so each hub connection goes
 * through a port on 127.0.0.1 that takes that one connection and carries it on over TLS once the
 * hub has shown its certificate.
 */

export const hubCertFile = () => path.join(nodeDir(), 'hub.crt')

/** The sha256 (hex) of the first certificate in `file`, or null. */
export function pinnedSha256(file: string): string | null {
  try {
    const m = readFileSync(file, 'utf8').match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/)
    if (!m) return null
    return createHash('sha256').update(Buffer.from(m[1].replace(/\s+/g, ''), 'base64')).digest('hex')
  } catch {
    return null
  }
}

/** `host` as a certificate's name is compared: lowercased, no brackets or trailing dot. */
const hostKey = (u: URL) => u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
const portOf = (u: URL) => u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80')

/** The pinned sha256 for a connection to `url`: only when it's the saved hub `hub`, over https, and its certificate was kept. */
export function pinFor(url: URL, hub: string | undefined, file = hubCertFile()): string | null {
  if (!hub || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') return null
  if (url.protocol !== 'https:' && url.protocol !== 'wss:') return null
  let saved: URL
  try {
    saved = new URL(hub)
  } catch {
    return null
  }
  if (hostKey(saved) !== hostKey(url) || portOf(saved) !== portOf(url)) return null
  return pinnedSha256(file)
}

/** Whether the certificate `sock` was shown is the pinned one, or one the usual authorities vouch for under `name`. */
function accepted(sock: tls.TLSSocket, name: string, want: string): boolean {
  const cert = sock.getPeerCertificate()
  if (!cert?.raw) return false
  if (createHash('sha256').update(cert.raw).digest('hex') === want) return true
  return sock.authorized && tls.checkServerIdentity(name, cert) === undefined
}

export interface Tunnel {
  /** The port on 127.0.0.1 to send the hub connection to, as plain ws:// or http://. */
  port: number
}

/** How long a tunnel's port waits for the connection it was opened for. */
const TAKE_WAIT = 10_000

/**
 * A port on 127.0.0.1 for one connection, carried on to `host`:`port` over TLS once the hub has
 * shown the certificate with sha256 `want` (or one an authority vouches for under its name).
 * Anything else is cut before a byte goes either way. The port takes the first connection and
 * closes at once, so no other user on this machine can go through it; one that got there first
 * only makes this connection fail, and it's tried again.
 */
export function tunnel(host: string, port: number, want: string): Promise<Tunnel> {
  const name = host.replace(/^\[|\]$/g, '')
  const server = net.createServer({ pauseOnConnect: true }, (local) => {
    server.close()
    clearTimeout(unused)
    const remote = tls.connect({ host: name, port, servername: net.isIP(name) ? undefined : name, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
    const cut = () => {
      local.destroy()
      remote.destroy()
    }
    remote.once('secureConnect', () => {
      if (!accepted(remote, name, want)) {
        console.error(`${host} showed a certificate that isn't the one this machine was added with. Not connecting.`)
        return cut()
      }
      local.pipe(remote)
      remote.pipe(local)
      local.resume()
    })
    remote.on('error', cut)
    local.on('error', cut)
    remote.on('close', () => local.destroy())
    local.on('close', () => remote.destroy())
  })
  server.maxConnections = 1
  const unused = setTimeout(() => server.close(), TAKE_WAIT)
  unused.unref?.()
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      clearTimeout(unused)
      reject(err)
    })
    server.listen(0, '127.0.0.1', () => {
      const a = server.address()
      resolve({ port: typeof a === 'object' && a ? a.port : 0 })
    })
  })
}
