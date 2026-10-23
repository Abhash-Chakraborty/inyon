import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ENGINE } from './engine-under-test.ts'

// `inyon connect` against a stand-in hub; a stand-in `inyon` command records what it was asked
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inyon-connect-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

async function run(fetch: (req: Request, srv: any) => Response | undefined, ms: number) {
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch, websocket: { open: (ws) => void ws.close(4001, 'removed from Inyon'), message() {} } })
  const home = fs.mkdtempSync(path.join(dir, 'home-'))
  const cli = path.join(home, 'inyon')
  fs.writeFileSync(cli, `#!/bin/sh\necho "$*" >> '${home}/cli.log'\n`, { mode: 0o755 })
  const p = Bun.spawn([...ENGINE, 'connect'], {
    env: { ...process.env, HOME: home, INYON_HUB: `http://127.0.0.1:${srv.port}`, INYON_TOKEN: 'tok', INYON_CLI: cli },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await Promise.race([p.exited, Bun.sleep(ms).then(() => 'still running')])
  p.kill()
  srv.stop(true)
  const log = path.join(home, 'cli.log')
  return { code, cli: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '' }
}

const shellFakes = process.platform === 'win32'

test.skipIf(shellFakes)('a machine the hub removes takes its own service down and stops', async () => {
  const r = await run((req, srv) => (srv.upgrade(req) ? undefined : new Response('Upgrade failed', { status: 400 })), 10_000)
  expect(r).toEqual({ code: 0, cli: 'disconnect' })
}, 15_000)

test.skipIf(shellFakes)('a machine removed while it was off learns it when it calls again', async () => {
  const r = await run(() => new Response('This machine was removed from the hub', { status: 410 }), 10_000)
  expect(r).toEqual({ code: 0, cli: 'disconnect' })
}, 15_000)

test.skipIf(shellFakes)('a token the hub doesn\'t know (a hub that lost its data) keeps it trying', async () => {
  const r = await run(() => new Response('Unknown token', { status: 403 }), 4_000)
  expect(r).toEqual({ code: 'still running', cli: '' })
}, 10_000)

/** An address of this machine on its LAN (not loopback, not a VPN's 100.64/10), to stand in for a LAN hub. */
const lanIp = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address))?.address

/** Runs `connect` for `ms` with no terminal, as a service runs it; what it wrote to node.json and stderr. */
async function runFor(env: Record<string, string>, home: string, ms: number) {
  const p = Bun.spawn([...ENGINE, 'connect'], { env: { ...process.env, INYON_HUB: '', INYON_TOKEN: '', INYON_ALLOW_INSECURE: '', HOME: home, USERPROFILE: home, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const code = await Promise.race([p.exited, Bun.sleep(ms).then(() => 'still running')])
  p.kill()
  const stderr = await new Response(p.stderr).text()
  const file = path.join(home, '.inyon', 'node', 'node.json')
  return { code, stderr, status: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {} }
}

const saveEnv = (home: string, lines: string[]) => {
  fs.mkdirSync(path.join(home, '.inyon', 'node'), { recursive: true })
  fs.writeFileSync(path.join(home, '.inyon', 'node', process.platform === 'win32' ? '.env' : 'env'), `${lines.join('\n')}\n`)
}

test('a hub plain http mustn\'t go to keeps the service waiting and says why, and the token goes nowhere', async () => {
  // a LAN can be listened to, and anyone on it can answer as the hub
  for (const [hub, host] of [['ws://8.8.8.8', '8.8.8.8'], ['http://192.168.1.5:4777', '192.168.1.5']]) {
    const home = fs.mkdtempSync(path.join(dir, 'home-'))
    const r = await runFor({ INYON_HUB: hub!, INYON_TOKEN: 'tok' }, home, 2500)
    // exiting would only have the service started again every few seconds, with nobody seeing why
    expect(r.code).toBe('still running')
    expect(r.stderr).toContain(`Refusing to send the token over plain http to ${host}`)
    expect(r.status.problem).toContain(`Refusing to send the token over plain http to ${host}`)
    expect(r.status.problem).toContain('INYON_ALLOW_INSECURE=1')
  }
}, 15_000)

test.skipIf(process.platform !== 'linux')('run in a terminal, a refused hub ends at once with the reason', () => {
  const home = fs.mkdtempSync(path.join(dir, 'home-'))
  const p = Bun.spawnSync(['script', '-qec', `${ENGINE.map((a) => `'${a}'`).join(' ')} connect`, '/dev/null'], {
    env: { ...process.env, HOME: home, INYON_HUB: 'http://8.8.8.8', INYON_TOKEN: 'tok', INYON_ALLOW_INSECURE: '' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  })
  expect(p.stdout.toString() + p.stderr.toString()).toContain('Refusing to send the token over plain http to 8.8.8.8')
  expect(p.exitCode).toBe(2)
})

test.skipIf(!lanIp || process.platform === 'win32')('a machine joined to a LAN hub before 0.20 still connects, and says how to move to https', async () => {
  let hello: any
  let asked = 0
  const srv = Bun.serve({
    port: 0,
    hostname: lanIp,
    fetch: (req, s) => {
      asked++
      return s.upgrade(req) ? undefined : new Response('no', { status: 400 })
    },
    websocket: { message: (_ws, m) => void (hello ??= JSON.parse(String(m))), open() {} },
  })
  try {
    const hub = `http://${lanIp}:${srv.port}`
    const home = fs.mkdtempSync(path.join(dir, 'home-'))
    saveEnv(home, [`INYON_HUB=${hub}`, 'INYON_TOKEN=tok'])
    const r = await runFor({}, home, 3000)
    expect(r.code).toBe('still running')
    expect(hello?.type).toBe('hello')
    // in the log, in node.json for `inyon status` and `inyon doctor`, and on the hub's machine page
    for (const said of [r.stderr, r.status.warning, hello.warning]) {
      expect(said).toContain(`Sending the token over plain http to ${lanIp}:${srv.port}`)
      expect(said).toContain('inyon setup')
    }
    expect(r.status.problem).toBeUndefined()

    // joined by this version, the same address is refused: join checked it, so something changed it
    const now = fs.mkdtempSync(path.join(dir, 'home-'))
    saveEnv(now, [`INYON_HUB=${hub}`, 'INYON_TOKEN=tok', 'INYON_JOINED=0.20.0'])
    asked = 0
    const refused = await runFor({}, now, 2500)
    expect(refused.code).toBe('still running')
    expect(asked).toBe(0)
    expect(refused.status.problem).toContain(`Refusing to send the token over plain http to ${lanIp}`)
    // unless the join was told to send it anyway, which it notes
    const allowed = fs.mkdtempSync(path.join(dir, 'home-'))
    saveEnv(allowed, [`INYON_HUB=${hub}`, 'INYON_TOKEN=tok', 'INYON_JOINED=0.20.0', 'INYON_ALLOW_INSECURE=1'])
    hello = undefined
    const sent = await runFor({}, allowed, 2500)
    expect(hello?.type).toBe('hello')
    expect(sent.status.problem).toBeUndefined()

    // a public address, which 0.19 refused too, stays refused however old the file
    const pub = fs.mkdtempSync(path.join(dir, 'home-'))
    saveEnv(pub, ['INYON_HUB=http://203.0.113.7:4777', 'INYON_TOKEN=tok'])
    const public_ = await runFor({}, pub, 2500)
    expect(public_.code).toBe('still running')
    expect(public_.status.problem).toContain('Refusing to send the token over plain http to 203.0.113.7')
    expect(public_.status.warning).toBeUndefined()
  } finally {
    srv.stop(true)
  }
}, 20_000)

test.skipIf(process.platform === 'win32')('a hub name is looked up once, and the connection goes to the address that passed, under its name', async () => {
  let host = ''
  let hello: any
  const srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req, s) => {
      host = req.headers.get('host') ?? ''
      return s.upgrade(req) ? undefined : new Response('no', { status: 400 })
    },
    websocket: { message: (_ws, m) => void (hello ??= JSON.parse(String(m))), open() {} },
  })
  try {
    // "localhost." is a name like any other: it's looked up, and passes since it's this machine
    const home = fs.mkdtempSync(path.join(dir, 'home-'))
    const r = await runFor({ INYON_HUB: `http://localhost.:${srv.port}`, INYON_TOKEN: 'tok' }, home, 3000)
    expect(r.code).toBe('still running')
    expect(hello?.type).toBe('hello')
    expect(host).toBe(`localhost.:${srv.port}`)
    expect(hello.warning).toBeUndefined()
  } finally {
    srv.stop(true)
  }
}, 10_000)

/** Makes, in `at`, a certificate as `inyon setup` makes a hub's (no authority, for 127.0.0.1), or with `signer` one that key signed. */
function cert(at: string, signer?: string) {
  fs.mkdirSync(at, { recursive: true })
  const key = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(at, 'key.pem')]
  const ext = path.join(at, 'ext')
  fs.writeFileSync(ext, 'subjectAltName=DNS:localhost,IP:127.0.0.1\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n')
  const sh = (args: string[]) => expect(Bun.spawnSync(['openssl', ...args], { stderr: 'pipe' }).exitCode).toBe(0)
  if (!signer) return sh(['req', '-x509', ...key, '-out', path.join(at, 'cert.pem'), '-days', '2', '-subj', '/CN=Inyon hub', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'keyUsage=digitalSignature', '-addext', 'extendedKeyUsage=serverAuth'])
  sh(['req', ...key, '-out', path.join(at, 'csr.pem'), '-subj', '/CN=localhost'])
  sh(['x509', '-req', '-in', path.join(at, 'csr.pem'), '-CA', path.join(signer, 'cert.pem'), '-CAkey', path.join(signer, 'key.pem'), '-CAcreateserial', '-out', path.join(at, 'cert.pem'), '-days', '2', '-extfile', ext])
}

test.skipIf(process.platform === 'win32')('a hub joined by its certificate is reached on that certificate alone, never on one its key signed', async () => {
  const certs = fs.mkdtempSync(path.join(dir, 'certs-'))
  cert(path.join(certs, 'hub'))
  cert(path.join(certs, 'forged'), path.join(certs, 'hub'))
  const serve = (name: string) => {
    let hello: any
    const srv = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      tls: { cert: fs.readFileSync(path.join(certs, name, 'cert.pem'), 'utf8'), key: fs.readFileSync(path.join(certs, name, 'key.pem'), 'utf8') },
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response('no', { status: 400 })),
      websocket: { message: (_ws, m) => void (hello ??= JSON.parse(String(m))), open() {} },
    })
    return { srv, hello: () => hello }
  }
  const hub = serve('hub')
  const forged = serve('forged')
  try {
    const joined = (port: number | undefined, at: string) => {
      const home = fs.mkdtempSync(path.join(dir, 'home-'))
      saveEnv(home, [`INYON_HUB=https://${at}:${port}`, 'INYON_TOKEN=tok', 'INYON_JOINED=0.20.0'])
      // what `inyon join` keeps once its sha256 matched the command's
      fs.copyFileSync(path.join(certs, 'hub', 'cert.pem'), path.join(home, '.inyon', 'node', 'hub.crt'))
      return home
    }
    // the hub's own certificate: connects
    await runFor({ NODE_EXTRA_CA_CERTS: '' }, joined(hub.srv.port, '127.0.0.1'), 3000)
    expect(hub.hello()?.type).toBe('hello')
    // a certificate signed with the hub's key, for this very address: the token never goes
    await runFor({ NODE_EXTRA_CA_CERTS: '' }, joined(forged.srv.port, '127.0.0.1'), 3000)
    await runFor({ NODE_EXTRA_CA_CERTS: '' }, joined(forged.srv.port, 'localhost'), 3000)
    expect(forged.hello()).toBeUndefined()
  } finally {
    hub.srv.stop(true)
    forged.srv.stop(true)
  }
}, 20_000)

test('NODE_TLS_REJECT_UNAUTHORIZED=0 is said at the start, with the hub it concerns', async () => {
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('no', { status: 503 }) })
  try {
    const home = fs.mkdtempSync(path.join(dir, 'home-'))
    const r = await runFor({ INYON_HUB: `http://127.0.0.1:${srv.port}`, INYON_TOKEN: 'tok', NODE_TLS_REJECT_UNAUTHORIZED: '0' }, home, 1500)
    expect(r.stderr).toContain('Warning: NODE_TLS_REJECT_UNAUTHORIZED=0 is set')
    expect(r.stderr).toContain(`127.0.0.1:${srv.port}`)
    const quiet = await runFor({ INYON_HUB: `http://127.0.0.1:${srv.port}`, INYON_TOKEN: 'tok', NODE_TLS_REJECT_UNAUTHORIZED: '' }, fs.mkdtempSync(path.join(dir, 'home-')), 1500)
    expect(quiet.stderr).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED')
  } finally {
    srv.stop(true)
  }
}, 15_000)
