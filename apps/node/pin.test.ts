import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pinnedSha256, tunnel } from './pin.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inyon-pin-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

test.skipIf(process.platform === 'win32')('a pinned connection takes its own port, and no second connection gets through it', async () => {
  const key = path.join(dir, 'key.pem')
  const cert = path.join(dir, 'cert.pem')
  const made = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=Inyon hub', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'keyUsage=digitalSignature'], { stderr: 'pipe' })
  expect(made.exitCode).toBe(0)
  const hub = Bun.serve({ port: 0, hostname: '127.0.0.1', tls: { cert: fs.readFileSync(cert, 'utf8'), key: fs.readFileSync(key, 'utf8') }, fetch: () => new Response('hub') })
  try {
    const t = await tunnel('127.0.0.1', hub.port!, pinnedSha256(cert)!)
    const r = await fetch(`http://127.0.0.1:${t.port}/`, { headers: { host: `127.0.0.1:${hub.port}` }, keepalive: false })
    expect(await r.text()).toBe('hub')
    // the port closed with the first connection: another user's, or this one's, is turned away
    const second = await new Promise<string>((done) => {
      const s = net.connect(t.port, '127.0.0.1')
      s.once('connect', () => (s.destroy(), done('connected')))
      s.once('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'error'))
    })
    expect(second).toBe('ECONNREFUSED')
    // a certificate other than the pinned one: cut before a byte goes through
    const wrong = await tunnel('127.0.0.1', hub.port!, '00'.repeat(32))
    expect(await fetch(`http://127.0.0.1:${wrong.port}/`, { headers: { host: `127.0.0.1:${hub.port}` } }).then((x) => x.status, () => 'cut')).toBe('cut')
  } finally {
    hub.stop(true)
  }
}, 20_000)
