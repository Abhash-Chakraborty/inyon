import { afterAll, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { VERSION } from '@inyon/protocol'
import { cliTargetOf, mayPrepare, nodeRoutes, pruneOld, releaseFile, sourceCommand, tag, targetOf, updateScript } from './node-dist.ts'

const url = (q: string) => new URL(`http://hub/node/inyon?${q}`)
const get = (route: keyof typeof nodeRoutes) => nodeRoutes[route](new Request(`http://hub${route}`))

test('a download names its system; Windows on ARM gets its own command but the x64 engine', () => {
  expect(targetOf(url('os=linux&arch=arm64'))).toBe('linux-arm64')
  expect(targetOf(url('os=darwin&arch=x64'))).toBe('darwin-x64')
  expect(targetOf(url('os=windows&arch=arm64'))).toBe('windows-x64')
  expect(cliTargetOf(url('os=windows&arch=arm64'))).toBe('windows-arm64')
  expect(cliTargetOf(url('os=linux&arch=x64'))).toBe('linux-x64')
  // what tether-node's Windows installer asked with: no os at all
  expect(targetOf(url('arch=x64'))).toBe('windows-x64')
  expect(cliTargetOf(url('arch=x64'))).toBe('windows-x64')
  expect(() => targetOf(url('os=plan9&arch=x64'))).toThrow('os must be')
  expect(() => cliTargetOf(url('os=plan9&arch=x64'))).toThrow('os must be')
  expect(() => targetOf(url('os=linux&arch=x86'))).toThrow('arch must be')
})

test('the hub hands out the command and the engine under their own routes', () => {
  for (const r of ['/node/inyon', '/node/inyon.gz', '/node/inyon.sha256', '/node/inyon-engine', '/node/inyon-engine.gz', '/node/inyon-engine.sha256']) {
    expect(Object.keys(nodeRoutes)).toContain(r)
  }
})

test('the pinned busybox-w32 checksum is served per architecture, without a download', async () => {
  const sum = async (q: string) => nodeRoutes['/node/busybox.exe.sha256'](new Request(`http://hub/node/busybox.exe.sha256?${q}`))
  const x64 = await (await sum('os=windows&arch=x64')).text()
  const arm64 = await (await sum('arch=arm64')).text()
  expect(x64).toMatch(/^[0-9a-f]{64}$/)
  expect(arm64).toMatch(/^[0-9a-f]{64}$/)
  expect(x64).not.toBe(arm64)
  expect(await (await sum('')).text()).toBe(x64)
  expect((await sum('arch=x86')).status).toBe(400)
})

test("nobody signed in can make the hub build or download Inyon for a system no machine needs", async () => {
  const ask = (route: keyof typeof nodeRoutes, q: string) => nodeRoutes[route](new Request(`http://hub${route}?${q}`))
  for (const [route, q] of [['/node/inyon-engine', 'os=linux&arch=arm64'], ['/node/inyon.gz', 'os=darwin&arch=x64'], ['/node/inyon-engine.sha256', 'os=windows&arch=x64'], ['/node/busybox.exe', 'arch=arm64'], ['/node/tether-node.exe', ''], ['/node/SHA256SUMS', '']] as const) {
    const t0 = Date.now()
    const res = await ask(route, q)
    expect([route, res.status]).toEqual([route, 503])
    expect(await res.text()).toContain('Open "Add a machine" on the hub')
    // refused at once, not after a build or a download
    expect(Date.now() - t0).toBeLessThan(1000)
  }
})

test('a new system is prepared while an "Add a machine" command waits, or for a paired machine of that system', () => {
  const now = 1_800_000_000_000
  const node = (id: string, extra: object) => ({ id, name: id, kind: 'node', ...extra }) as any
  const os = (map: Record<string, string>) => (id: string) => map[id]
  // nothing paired, nothing waiting: no
  expect(mayPrepare('linux', [{ id: 'local', name: 'hub', kind: 'local' } as any], os({}), now)).toBe(false)
  // an unused token from the last day: any system
  expect(mayPrepare('windows', [node('new', { tokenIssuedAt: now - 3600_000 })], os({}), now)).toBe(true)
  expect(mayPrepare('windows', [node('old', { tokenIssuedAt: now - 2 * 86_400_000 })], os({}), now)).toBe(false)
  // a paired Linux machine updates; it doesn't open Windows
  const paired = [node('box', { pairedAt: now - 1000 })]
  expect(mayPrepare('linux', paired, os({ box: 'Linux' }), now)).toBe(true)
  expect(mayPrepare('windows', paired, os({ box: 'Linux' }), now)).toBe(false)
  expect(mayPrepare('darwin', paired, os({ box: 'Darwin' }), now)).toBe(true)
  expect(mayPrepare('windows', paired, os({ box: 'Windows' }), now)).toBe(true)
  // one that hasn't said what it runs yet could be anything
  expect(mayPrepare('windows', paired, os({}), now)).toBe(true)
})

test('tether-node as a Bun script is told to run "Add a machine" again', async () => {
  const res = await get('/node/tether-node.ts')
  expect(res.status).toBe(410)
  expect(await res.text()).toContain('Copy the "Add a machine" command from the hub again')
  await expect(updateScript('linux', 'x64')).rejects.toThrow('Add a machine')
})

test('a hub running from a checkout has no signed list to hand machines, and says why', async () => {
  for (const r of ['/node/release/SHA256SUMS', '/node/release/SHA256SUMS.minisig', '/node/release/version'] as const) {
    const res = await get(r)
    expect(res.status).toBe(404)
    expect(await res.text()).toContain("isn't signed by Inyon's release key")
  }
  // and no certificate of its own without TLS_CERT
  expect((await get('/node/hub.crt')).status).toBe(404)
})

test('the signed list keeps its signature, for machines to check themselves', async () => {
  const { signedList } = await import('./node-dist.ts')
  const get = (async (url: string) => new Response(url.endsWith('.minisig') ? SIGNED_SIG : SIGNED)) as unknown as typeof fetch
  expect(await signedList('http://r', TEST_KEY, get, '0.14.0')).toEqual({ sums: SIGNED, sig: SIGNED_SIG })
})

test('the installers are served as they are in the repository', async () => {
  expect(await (await get('/node/install.sh')).text()).toStartWith('#!/bin/sh\n')
  expect(await (await get('/node/install.ps1')).text()).toContain("$TaskName = 'Inyon node'")
})

test('the Windows installer saves the hub through inyon join, so a new machine is held to its check', async () => {
  const ps1 = await (await get('/node/install.ps1')).text()
  // join writes INYON_JOINED and refuses plain http anyone could answer; the script never writes
  // the token itself, which would let it in as a machine added before 0.20
  expect(ps1).toContain('& $exe join $Hub --no-autostart')
  expect(ps1).toContain('if ($joined -ne 0)')
  expect(ps1).not.toMatch(/"INYON_TOKEN=\$Token"/)
  expect(ps1).not.toMatch(/Set-Content -Path \$envFile/)
  expect(ps1.indexOf('& $exe join')).toBeLessThan(ps1.indexOf('Register-ScheduledTask'))
})

test('earlier builds go, with their .gz and .sha256; this build, this release and busybox stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inyon-node-dist-'))
  const stale = [
    'v0.12.0-inyon-engine-linux-x64',
    'v0.12.0-inyon-engine-linux-x64.gz',
    'v0.12.0-inyon-engine-linux-x64.sha256',
    'v0.12.0-inyon-windows-x64.exe',
    '0123456789abcdef-inyon-engine-darwin-arm64',
    // how hubs before 0.13 named their builds
    'inyon-0123456789abcdef-inyon-engine-linux-x64',
    'tether-node-0123456789abcdef.js',
  ]
  const kept = [
    `${tag()}-inyon-engine-linux-x64`,
    `${tag()}-inyon-engine-linux-x64.gz`,
    `${tag()}-inyon-engine-linux-x64.sha256`,
    `${tag()}-inyon-engine-windows-x64.exe.tmp`,
    `v${VERSION}-inyon-linux-x64`,
    `v${VERSION}-inyon-windows-arm64.exe`,
    'busybox-w64u-FRP-6075-g169694ebd.exe',
    'notes.txt',
  ]
  for (const f of [...stale, ...kept]) fs.writeFileSync(path.join(dir, f), f)
  try {
    pruneOld(dir)
    expect(fs.readdirSync(dir).sort()).toEqual([...kept].sort())
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// A stand-in for the GitHub release the hub takes the program from.
const sha = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const BUILD = 'the linux build'
const GZ = zlib.gzipSync(BUILD)
let requests: string[] = []
const release = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const name = new URL(req.url).pathname.slice(1)
    requests.push(name)
    if (name === 'inyon-linux-x64') return new Response(BUILD)
    if (name === 'inyon-linux-x64.gz') return new Response(GZ)
    return new Response('no', { status: 404 })
  },
})
afterAll(() => release.stop(true))
const base = () => `http://127.0.0.1:${release.port}`

test('the hub takes the gzipped release file when SHA256SUMS lists one, and keeps the plain bytes', async () => {
  const sums = `${sha(BUILD)}  inyon-linux-x64\n${sha(GZ)}  inyon-linux-x64.gz\n`
  expect((await releaseFile('inyon-linux-x64', sums, base())).toString()).toBe(BUILD)
  expect(requests).toEqual(['inyon-linux-x64.gz'])

  // a release from before 0.11: the plain file
  requests = []
  expect((await releaseFile('inyon-linux-x64', `${sha(BUILD)}  inyon-linux-x64\n`, base())).toString()).toBe(BUILD)
  expect(requests).toEqual(['inyon-linux-x64'])
})

test('both the .gz and what it unpacks to are checked, and a file not listed is refused', async () => {
  await expect(releaseFile('inyon-linux-x64', `${sha(BUILD)}  inyon-linux-x64\n${sha('other')}  inyon-linux-x64.gz\n`, base())).rejects.toThrow('inyon-linux-x64.gz did not match')
  await expect(releaseFile('inyon-linux-x64', `${sha('other')}  inyon-linux-x64\n${sha(GZ)}  inyon-linux-x64.gz\n`, base())).rejects.toThrow('inyon-linux-x64 did not match')
  await expect(releaseFile('inyon-darwin-x64', `${sha(BUILD)}  inyon-linux-x64\n`, base())).rejects.toThrow('has no inyon-darwin-x64')
  await expect(releaseFile('inyon-linux-x64', `${sha(BUILD)}  inyon-linux-x64\n${sha(GZ)}  inyon-linux-x64.gz\n`, `${base()}/gone`)).rejects.toThrow('Could not download inyon-linux-x64.gz (404)')
})

test('a checkout without a built command hands Windows the release command, and the engine only when that fails', async () => {
  const calls: string[] = []
  const from = (release: () => Promise<string>, built?: string) => ({
    built: () => built,
    release: async (t: string) => (calls.push(`release ${t}`), release()),
    engine: async (t: string) => (calls.push(`engine ${t}`), `/out/engine-${t}`),
  })
  const ok = from(async () => '/out/v0.17.0-inyon-windows-x64.exe')
  expect(await sourceCommand('windows-x64', ok)).toBe('/out/v0.17.0-inyon-windows-x64.exe')
  expect(await sourceCommand('windows-x64', from(async () => '', '/dist/inyon.exe'))).toBe('/dist/inyon.exe')
  // Linux and macOS keep the engine standing in for both (install.sh reads that from SHA256SUMS)
  expect(await sourceCommand('linux-x64', ok)).toBe('/out/engine-linux-x64')
  expect(calls).toEqual(['release windows-x64', 'engine linux-x64'])

  const offline = from(async () => {
    throw new Error('Could not get the checksums of Inyon 0.17.0 (404)')
  })
  const warn = console.warn
  const warned: string[] = []
  console.warn = (m: string) => void warned.push(m)
  try {
    expect(await sourceCommand('windows-x64', offline)).toBe('/out/engine-windows-x64')
    expect(warned[0]).toContain('handing out the engine instead')
    await expect(sourceCommand('windows-arm64', offline)).rejects.toThrow('has no inyon command for windows-arm64')
  } finally {
    console.warn = warn
  }
})

// made with the minisign binary and apps/cli/tests/keys, as in apps/cli/src/signing.rs
const TEST_KEY = 'RWQqNVK9mQOKMvLzyK5hNRZhdkrEQAMzJCRgzTyujgXyvmvHB0y3/zRm'
const SIGNED = 'abc  file-a\nabc  inyon-0.14.0.apk\n'
const SIGNED_SIG = `untrusted comment: signature from minisign secret key
RUQqNVK9mQOKMkab6flmvsRkTJgrMwvlSr3HLaTaxl1/BKaIsjpexn6/YRrw9Nco1CyBNYXpD14RN4tyV+x91G0EBDlaQWFoVgg=
trusted comment: timestamp:1791906365\tfile:SUMS\thashed
hHmf6FdFURutVLVvePMp+3/HYEQlat81SrV37cY/HJXIVYmOh/WB1gOW4L2bQb9BQzY4ZopTYpjFX9UXykjRBw==
`

test('the release checksums count only with a good signature from the release key', async () => {
  const { signedSums } = await import('./node-dist.ts')
  const { RELEASE_KEY } = await import('@inyon/protocol')
  const release = (sums: string, sig?: string) => {
    const asked: string[] = []
    const get = (async (url: string) => {
      const name = url.split('/').pop()!
      asked.push(name)
      if (name === 'SHA256SUMS') return new Response(sums)
      if (name === 'SHA256SUMS.minisig' && sig) return new Response(sig)
      return new Response('no', { status: 404 })
    }) as unknown as typeof fetch
    return { asked, get }
  }
  const good = release(SIGNED, SIGNED_SIG)
  expect(await signedSums('http://r', TEST_KEY, good.get, '0.14.0')).toBe(SIGNED)
  // a good list of another release, an old copy on a mirror, isn't this hub's
  await expect(signedSums('http://r', TEST_KEY, release(SIGNED, SIGNED_SIG).get, '0.15.0')).rejects.toMatchObject({
    status: 502,
    message: expect.stringContaining("aren't the ones for Inyon 0.15.0 (they don't list inyon-0.15.0.apk)"),
  })
  // a list changed by one byte, no signature, another key, and a changed trusted comment: each refused before any file
  for (const [sums, sig, key] of [
    ['abd  file-a\nabc  inyon-0.14.0.apk\n', SIGNED_SIG, TEST_KEY],
    [SIGNED, undefined, TEST_KEY],
    [SIGNED, SIGNED_SIG, RELEASE_KEY],
    [SIGNED, SIGNED_SIG.replace('timestamp:1791906365', 'timestamp:1791906366'), TEST_KEY],
  ] as const) {
    const r = release(sums, sig)
    await expect(signedSums('http://r', key, r.get, '0.14.0')).rejects.toMatchObject({ status: 502 })
    expect(r.asked.every((n) => n.startsWith('SHA256SUMS'))).toBe(true)
  }
})

test('only a mock release may name another signing key', async () => {
  const { signingKey } = await import('./minisign.ts')
  const { RELEASE_KEY, RELEASES_REPO, VERSION } = await import('@inyon/protocol')
  const old = process.env.INYON_SIGNING_KEY
  process.env.INYON_SIGNING_KEY = `untrusted comment: test key\n${TEST_KEY}\n`
  try {
    expect(signingKey('http://127.0.0.1:8000/download')).toBe(TEST_KEY)
    for (const base of [`https://github.com/${RELEASES_REPO}/releases/download/v${VERSION}`, 'https://inyon.tech/download', 'https://inyon.abhashchakraborty.tech/download', 'HTTPS://GitHub.com/abhash-chakraborty/inyon/releases/latest/download']) {
      expect(signingKey(base)).toBe(RELEASE_KEY)
    }
    delete process.env.INYON_SIGNING_KEY
    expect(signingKey('http://127.0.0.1:8000/download')).toBe(RELEASE_KEY)
  } finally {
    if (old === undefined) delete process.env.INYON_SIGNING_KEY
    else process.env.INYON_SIGNING_KEY = old
  }
})
