import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import {
  binaryName, cleanupOld, compareVersions, files, findInstall, isNewer, latestVersion, staleLink, sumFor, swapBack, swapIn,
  update, UpdateError, waitStarted, type Deps,
} from './update.ts'

// Nothing real is touched: home is a throwaway folder, a local server stands in for inyon-releases
// and the hub, and restarting the service is a fake that records what it was asked.
afterAll(() => mock.restore())

const sha = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const NAME = binaryName()
let release = { version: '9.9.9', body: 'new build', sums: '' }
let hub = { script: 'new script', exe: 'new exe', sumOverride: '' }
let requests: string[] = []
const server = Bun.serve({
  port: 4790,
  hostname: '127.0.0.1',
  fetch(req) {
    const u = new URL(req.url)
    requests.push(u.pathname + u.search)
    if (u.pathname === '/releases/latest') return new Response(null, { status: 302, headers: { location: `https://github.com/x/y/releases/tag/v${release.version}` } })
    if (u.pathname === `/releases/latest/download/${NAME}`) return new Response(release.body)
    if (u.pathname === '/releases/latest/download/SHA256SUMS') return new Response(release.sums || `${sha(release.body)}  ${NAME}\n${sha('other')}  tether-node-other\n`)
    if (u.pathname === '/node/tether-node.ts.sha256') return new Response(hub.sumOverride || sha(hub.script))
    if (u.pathname === '/node/tether-node.ts') return new Response(hub.script)
    if (u.pathname === '/node/tether-node.exe.sha256' && u.searchParams.get('arch') === 'x64') return new Response(hub.sumOverride || sha(hub.exe))
    if (u.pathname === '/node/tether-node.exe.gz' && u.searchParams.get('arch') === 'x64') return new Response(zlib.gzipSync(hub.exe))
    return new Response('not found', { status: 404 })
  },
})
afterAll(() => server.stop(true))
const BASE = 'http://127.0.0.1:4790'

let home: string
let restarts: [string, string[]][]
let startedOk: boolean
const deps = (more: Partial<Deps> = {}): Deps => ({
  version: '0.6.3',
  fetch,
  restart: (which, cmd) => (restarts.push([which, cmd]), { ok: true, how: 'fake' }),
  started: async () => startedOk,
  log: () => {},
  ...more,
})
const binDir = () => path.join(home, '.tether-node', 'bin')
const installed = () => path.join(binDir(), process.platform === 'win32' ? 'tether-node.exe' : 'tether-node')

beforeAll(() => {
  process.env.TETHER_DOWNLOAD = `${BASE}/releases/latest/download`
})
afterAll(() => {
  delete process.env.TETHER_DOWNLOAD
})
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'tether-node-update-'))
  spyOn(os, 'homedir').mockReturnValue(home)
  mkdirSync(binDir(), { recursive: true })
  writeFileSync(installed(), 'old build')
  release = { version: '9.9.9', body: 'new build', sums: '' }
  hub = { script: 'new script', exe: 'new exe', sumOverride: '' }
  requests = []
  restarts = []
  startedOk = true
})
afterEach(() => {
  mock.restore()
  rmSync(home, { recursive: true, force: true })
})

test('versions compare by number, and a release beats its own pre-releases', () => {
  expect(compareVersions('0.6.3', '0.3.0')).toBe(1)
  expect(compareVersions('0.3.0', '0.6.3')).toBe(-1)
  expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
  expect(compareVersions('v0.7.0', '0.7.0')).toBe(0)
  expect(compareVersions('0.7', '0.7.0')).toBe(0)
  expect(compareVersions('0.7.0', '0.7.0-rc.1')).toBe(1)
  expect(compareVersions('0.7.0-rc.10', '0.7.0-rc.2')).toBe(1)
  expect(isNewer('nonsense', '0.1.0')).toBe(false)
  expect(isNewer('0.6.3', '0.6.3')).toBe(false)
})

test('SHA256SUMS lines match the exact file name, in either sha256sum format', () => {
  const sums = `${'a'.repeat(64)}  tether-node-linux-x64\n${'b'.repeat(64)} *tether-node-windows-x64.exe\n`
  expect(sumFor(sums, 'tether-node-linux-x64')).toBe('a'.repeat(64))
  expect(sumFor(sums, 'tether-node-windows-x64.exe')).toBe('b'.repeat(64))
  expect(sumFor(sums, 'tether-node-linux')).toBeUndefined()
})

test('the newest version comes from where releases/latest redirects, or from a pinned tag', async () => {
  release.version = '0.7.1'
  expect(await latestVersion(`${BASE}/releases/latest/download`)).toBe('0.7.1')
  expect(await latestVersion('https://example.invalid/x/releases/download/v0.6.9')).toBe('0.6.9')
  await expect(latestVersion(`${BASE}/nothing-here/download`)).rejects.toThrow(UpdateError)
})

test('a phone-link install downloads the newer build, checks it, swaps it in and restarts the link', async () => {
  const r = await update(findInstall([installed()], undefined), deps())
  expect(r).toMatchObject({ changed: true, version: '9.9.9' })
  expect(readFileSync(installed(), 'utf8')).toBe('new build')
  expect(restarts).toEqual([['link', [installed()]]])
  // the old copy is gone once the new one runs, and no download is left behind
  expect(readdirSync(binDir())).toEqual([path.basename(installed())])
})

test("a download that doesn't match SHA256SUMS changes nothing", async () => {
  release.sums = `${sha('something else')}  ${NAME}\n`
  await expect(update(findInstall([installed()], undefined), deps())).rejects.toThrow("didn't match the release's checksum")
  expect(readFileSync(installed(), 'utf8')).toBe('old build')
  expect(readdirSync(binDir())).toEqual([path.basename(installed())])
  expect(restarts).toEqual([])
})

test('a build missing from SHA256SUMS is refused too', async () => {
  release.sums = `${sha(release.body)}  tether-node-some-other-build\n`
  await expect(update(findInstall([installed()], undefined), deps())).rejects.toThrow(UpdateError)
  expect(readFileSync(installed(), 'utf8')).toBe('old build')
})

test('already on the newest version: says so and downloads nothing', async () => {
  release.version = '0.6.3'
  const r = await update(findInstall([installed()], undefined), deps())
  expect(r).toEqual({ changed: false, message: 'tether-node 0.6.3 is up to date.', version: '0.6.3' })
  expect(requests).toEqual(['/releases/latest'])
  expect(restarts).toEqual([])
})

test("a new version that doesn't start is swapped back out and the old one restarted", async () => {
  startedOk = false
  await expect(update(findInstall([installed()], undefined), deps())).rejects.toThrow('the previous version is running again')
  expect(readFileSync(installed(), 'utf8')).toBe('old build')
  expect(restarts.map(([w]) => w)).toEqual(['link', 'link'])
})

test('a hub install takes the hub build when it differs, checked against the hub sha256', async () => {
  const script = path.join(home, '.tether-node', 'tether-node.ts')
  writeFileSync(script, 'old script')
  const install = findInstall([process.execPath, script], BASE)
  expect(install.kind).toBe('hub')
  expect(await update(install, deps())).toMatchObject({ changed: true })
  expect(readFileSync(script, 'utf8')).toBe('new script')
  expect(restarts).toEqual([['hub', [process.execPath, script]]])

  // the same file as the hub's: nothing to do
  restarts = []
  expect(await update(install, deps())).toMatchObject({ changed: false })
  expect(restarts).toEqual([])

  // a checksum that doesn't match leaves the running copy alone
  hub.script = 'tampered'
  hub.sumOverride = sha('what the hub meant')
  await expect(update(install, deps())).rejects.toThrow("didn't match the hub's checksum")
  expect(readFileSync(script, 'utf8')).toBe('new script')
})

test('a Windows hub install gets the gzipped .exe for its architecture', async () => {
  const exe = path.join(home, '.tether-node', 'tether-node.exe')
  writeFileSync(exe, 'old exe')
  const install = findInstall([exe], BASE)
  expect(install).toMatchObject({ kind: 'hub', exe: true })
  expect(await update(install, deps({ platform: 'win32', arch: 'x64' }))).toMatchObject({ changed: true })
  expect(readFileSync(exe, 'utf8')).toBe('new exe')
  expect(requests).toContain('/node/tether-node.exe.gz?arch=x64')
})

test('which install is running', () => {
  expect(findInstall([installed()], 'http://hub').kind).toBe('binary')
  expect(findInstall([path.join(home, '.tether-node', 'tether-node.exe')], 'http://hub')).toMatchObject({ kind: 'hub', exe: true })
  expect(findInstall(['/tmp/Downloads/tether-node-linux-x64'], undefined).kind).toBe('binary')
  expect(() => findInstall([process.execPath, '/src/inyon/apps/node/tether-node.ts'], undefined)).toThrow('source checkout')
})

/** Acts like Windows: a running program can be renamed, but not deleted or overwritten. */
function windowsFiles(locked: Set<string>) {
  const real = { ...files }
  spyOn(files, 'remove').mockImplementation((f) => {
    if (locked.has(f)) throw Object.assign(new Error(`EBUSY: ${f}`), { code: 'EBUSY' })
    real.remove(f)
  })
  spyOn(files, 'rename').mockImplementation((from, to) => {
    if (locked.has(String(to))) throw Object.assign(new Error(`EPERM: ${to}`), { code: 'EPERM' })
    renameSync(from, to)
    // the lock follows the running file to its new name
    if (locked.delete(String(from))) locked.add(String(to))
  })
}

test('Windows: the running .exe is renamed aside, the new one takes its name, the old one goes later', () => {
  const exe = installed()
  const fresh = `${exe}.download`
  writeFileSync(fresh, 'new build')
  const locked = new Set([exe])
  windowsFiles(locked)
  const t0 = 1_000_000_000_000
  const old = swapIn(exe, fresh, t0)!
  expect(old).toBe(`${exe}.old-${t0}`)
  expect(readFileSync(exe, 'utf8')).toBe('new build')
  expect(locked.has(old)).toBe(true)

  // still running: cleaning up leaves it, quietly
  cleanupOld(exe, t0 + 11 * 60_000)
  expect(existsSync(old)).toBe(true)
  // stopped, but from an update that may still be going on: kept for going back to
  locked.clear()
  cleanupOld(exe, t0 + 5 * 60_000)
  expect(existsSync(old)).toBe(true)
  cleanupOld(exe, t0 + 11 * 60_000)
  expect(existsSync(old)).toBe(false)
  expect(existsSync(exe)).toBe(true)
})

test("Windows: if the new file can't take the name, the old one gets it back", () => {
  const exe = installed()
  const fresh = `${exe}.download`
  writeFileSync(fresh, 'new build')
  spyOn(files, 'rename').mockImplementation((from, to) => {
    if (from === fresh) throw new Error('EPERM: blocked by antivirus')
    renameSync(from, to)
  })
  expect(() => swapIn(exe, fresh)).toThrow('EPERM')
  expect(readFileSync(exe, 'utf8')).toBe('old build')
})

test('Windows: going back renames the new copy aside too, in case it is still running', () => {
  const exe = installed()
  writeFileSync(`${exe}.download`, 'new build')
  const old = swapIn(exe, `${exe}.download`, 1)!
  const locked = new Set([exe])
  windowsFiles(locked)
  swapBack(exe, old, 2)
  expect(readFileSync(exe, 'utf8')).toBe('old build')
  expect(readFileSync(`${exe}.old-2`, 'utf8')).toBe('new build')
})

test('the restarted copy counts once it names the new version, is a new process, and stays up', async () => {
  const state = path.join(home, '.tether-node', 'state.json')
  const fast = { tries: 3, every: 1, settle: 1 }
  writeFileSync(state, JSON.stringify({ pid: process.pid, version: '9.9.9' }))
  expect(await waitStarted('link', '9.9.9', undefined, fast)).toBe(true)
  // still the copy from before the restart
  expect(await waitStarted('link', '9.9.9', process.pid, fast)).toBe(false)
  expect(await waitStarted('link', '9.9.10', undefined, fast)).toBe(false)
  writeFileSync(state, JSON.stringify({ pid: 2 ** 22 + 12345, version: '9.9.9' }))
  expect(await waitStarted('link', '9.9.9', undefined, fast)).toBe(false)
})

test('a link from before versions were recorded counts as stale, so setup restarts it', () => {
  expect(staleLink({}, '0.6.4')).toBe(true)
  expect(staleLink({ version: '0.6.3' }, '0.6.4')).toBe(true)
  expect(staleLink({ version: '0.6.4' }, '0.6.4')).toBe(false)
  expect(staleLink(undefined, '0.6.4')).toBe(false)
})
