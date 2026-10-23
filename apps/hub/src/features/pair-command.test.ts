import { afterAll, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unixPairCommand } from './pair-command.ts'

// A hub serving the real install.sh and a stand-in inyon program: a script that writes down how it
// was run. Nothing real gets installed or started.
const installSh = readFileSync(resolve(import.meta.dir, '../../../node/install.sh'))
const os = process.platform === 'darwin' ? 'darwin' : 'linux'
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
let program = '#!/bin/sh\nprintf "%s\\n" "$*" "$INYON_TOKEN" > "$HOME/ran"\n'
const ENGINE = '#!/bin/sh\necho engine\n'
/** a hub from 0.13 on lists the engine as a file of its own */
let split = false
const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const sums = () => `${sha(program)}  inyon-${os}-${arch}\n${sha('another build')}  inyon-other-x64\n${split ? `${sha(ENGINE)}  inyon-engine-${os}-${arch}\n` : ''}`
/** a list the hub serves as it is, whatever the program has become */
let fixedList: string | undefined
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (req) => {
    const u = new URL(req.url)
    const mine = u.searchParams.get('os') === os && u.searchParams.get('arch') === arch
    if (u.pathname === '/node/install.sh') return new Response(installSh)
    if (u.pathname === '/node/SHA256SUMS') return new Response(fixedList ?? sums())
    if (u.pathname === '/node/inyon' && mine) return new Response(program)
    if (u.pathname === '/node/inyon-engine' && mine && split) return new Response(ENGINE)
    return new Response('not found', { status: 404 })
  },
})
const hub = `http://127.0.0.1:${server.port}`
const root = mkdtempSync(join(tmpdir(), 'inyon-pair-'))
afterAll(() => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

async function run(cmd: string, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(root, 'home-'))
  const p = Bun.spawn(['sh', '-c', cmd], { env: { HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin', ...env }, stdout: 'ignore', stderr: 'pipe' })
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
  const ran = existsSync(join(home, 'ran')) ? readFileSync(join(home, 'ran'), 'utf8') : undefined
  return { code, err, ran, bin: join(home, '.inyon', 'bin') }
}

test('the one-liner installs what the hub vouched for and has it join, with the token kept out of argv', async () => {
  const cmd = unixPairCommand(hub, 'tok_123-abc', sha(installSh), sha(sums()))
  expect(cmd.split(" sh -c '")[1]).not.toContain('tok_123-abc')
  const r = await run(cmd)
  expect(r.err).not.toContain('checksum')
  expect(r.code).toBe(0)
  expect(readFileSync(join(r.bin, 'inyon'), 'utf8')).toBe(program)
  expect(r.ran).toBe(`join ${hub}\ntok_123-abc\n`)
  expect(existsSync(join(r.bin, 'inyon.download'))).toBe(false)
})

test('a swapped install.sh, checksum list or program is refused, and nothing runs', async () => {
  const swappedInstaller = await run(unixPairCommand(hub, 'tok', sha('something else'), sha(sums())))
  expect(swappedInstaller.code).not.toBe(0)
  expect(swappedInstaller.err).toContain('install.sh did not match')
  expect(swappedInstaller.ran).toBeUndefined()

  const swappedSums = await run(unixPairCommand(hub, 'tok', sha(installSh), sha('a different list')))
  expect(swappedSums.code).not.toBe(0)
  expect(swappedSums.err).toContain("The hub's checksums did not match")
  expect(swappedSums.ran).toBeUndefined()

  // the list as vouched for, but the program swapped on the way
  fixedList = sums()
  program = '#!/bin/sh\necho "not what the hub built" > "$HOME/ran"\n'
  const swappedProgram = await run(unixPairCommand(hub, 'tok', sha(installSh), sha(fixedList)))
  expect(swappedProgram.code).not.toBe(0)
  expect(swappedProgram.err).toContain('inyon did not match its checksum')
  expect(swappedProgram.ran).toBeUndefined()
  expect(existsSync(join(swappedProgram.bin, 'inyon'))).toBe(false)
})

test('from 0.19 a machine joins with the command alone, though the hub lists the engine', async () => {
  split = true
  fixedList = undefined
  program = '#!/bin/sh\nprintf "%s\\n" "$*" "$INYON_TOKEN" > "$HOME/ran"\n'
  try {
    const r = await run(unixPairCommand(hub, 'tok_789', sha(installSh), sha(sums())))
    expect(r.code).toBe(0)
    expect(readFileSync(join(r.bin, 'inyon'), 'utf8')).toBe(program)
    expect(existsSync(join(r.bin, 'inyon-engine'))).toBe(false)
    expect(r.ran).toBe(`join ${hub}\ntok_789\n`)
  } finally {
    split = false
  }
})

test('with INYON_LEGACY_ENGINE=1 the engine comes from the hub too, checked the same way, and the command joins', async () => {
  split = true
  fixedList = undefined
  program = '#!/bin/sh\nprintf "%s\\n" "$*" "$INYON_TOKEN" > "$HOME/ran"\n'
  const legacy = { INYON_LEGACY_ENGINE: '1' }
  try {
    const r = await run(unixPairCommand(hub, 'tok_456', sha(installSh), sha(sums())), legacy)
    expect(r.err).not.toContain('checksum')
    expect(r.code).toBe(0)
    expect(readFileSync(join(r.bin, 'inyon'), 'utf8')).toBe(program)
    expect(readFileSync(join(r.bin, 'inyon-engine'), 'utf8')).toBe(ENGINE)
    expect(r.ran).toBe(`join ${hub}\ntok_456\n`)
    expect(existsSync(join(r.bin, 'inyon.download'))).toBe(false)

    // an engine swapped on the way is refused before anything joins
    fixedList = sums().replace(sha(ENGINE), sha('other engine'))
    const swapped = await run(unixPairCommand(hub, 'tok', sha(installSh), sha(fixedList)), legacy)
    expect(swapped.code).not.toBe(0)
    expect(swapped.err).toContain('engine did not match its checksum')
    expect(swapped.ran).toBeUndefined()
  } finally {
    split = false
    fixedList = undefined
  }
})

test('a hub on a certificate it made itself: the downloads get past it, still checked, and join gets its sha256', async () => {
  // the hub as setup's LAN choice leaves it: HTTPS on a self-signed certificate
  const dir = mkdtempSync(join(root, 'tls-'))
  const made = Bun.spawnSync(['sh', '-c', 'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout k.pem -out c.pem -days 2 -subj /CN=hub -addext subjectAltName=IP:127.0.0.1'], { cwd: dir, stderr: 'pipe' })
  expect(made.exitCode).toBe(0)
  const { selfSignedCert } = await import('./node-dist.ts')
  const cert = selfSignedCert(join(dir, 'c.pem'))!
  const der = Buffer.from(readFileSync(join(dir, 'c.pem'), 'utf8').replace(/-----[^-]+-----|\s/g, ''), 'base64')
  expect(cert.sha256).toBe(sha(der))
  const saved = { program, fixedList, split }
  program = '#!/bin/sh\nprintf "%s\\n" "$*" "$INYON_HUB_CERT" > "$HOME/ran"\n'
  fixedList = undefined
  split = false
  const tls = Bun.serve({ port: 0, hostname: '127.0.0.1', tls: { cert: Bun.file(join(dir, 'c.pem')), key: Bun.file(join(dir, 'k.pem')) }, fetch: (req) => server.fetch(req) as Response | Promise<Response> })
  try {
    const https = `https://127.0.0.1:${tls.port}`
    // without the sha256, curl stops at the certificate, as it should
    expect((await run(unixPairCommand(https, 'tok', sha(installSh), sha(sums())))).code).not.toBe(0)
    const r = await run(unixPairCommand(https, 'tok', sha(installSh), sha(sums()), cert.sha256))
    expect(r.err).not.toContain('checksum')
    expect(r.code).toBe(0)
    expect(r.ran).toBe(`join ${https}\n${cert.sha256}\n`)
    // and a program swapped on the way is still refused
    fixedList = sums()
    program = '#!/bin/sh\necho "not what the hub built" > "$HOME/ran"\n'
    const swapped = await run(unixPairCommand(https, 'tok', sha(installSh), sha(fixedList), cert.sha256))
    expect(swapped.err).toContain('inyon did not match its checksum')
    expect(swapped.ran).toBeUndefined()
  } finally {
    tls.stop(true)
    ;({ program, fixedList, split } = saved)
  }
  // a certificate from an authority gets no sha256 in the command
  expect(selfSignedCert(join(dir, 'nothing.pem'))).toBeUndefined()
})

test('the command names the certificate only when there is one, in the form both hubs write', () => {
  expect(unixPairCommand('https://192.168.1.5:4777', 'tok', 'aaa', 'bbb', 'cc')).toBe(
    `INYON_TOKEN=tok INYON_SUMS_SHA256=bbb INYON_HUB_CERT=cc sh -c 'f=$(mktemp) && curl -fsSLk "$1/node/install.sh" -o "$f" && if [ "$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -c1-64)" = "$2" ]; then sh "$f" "$1"; else echo "install.sh did not match its checksum; get a new command from the hub" >&2; false; fi; s=$?; rm -f "$f"; exit $s' inyon https://192.168.1.5:4777 aaa`,
  )
  expect(unixPairCommand('http://hub:4777', 'tok', 'aaa', 'bbb')).not.toContain('INYON_HUB_CERT')
})
