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

// Nothing real is touched: home is a throwaway folder, a local server stands in for the GitHub releases
// and the hub, and restarting the services is a fake that records what it was asked.
afterAll(() => mock.restore())

const sha = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const NAME = binaryName()
let release = { version: '9.9.9', body: 'new build', sums: '' }
let hub = { builds: { 'linux-x64': 'new linux build', 'windows-x64': 'new exe' } as Record<string, string>, sumOverride: '' }
let requests: string[] = []
const server = Bun.serve({
  port: 4790,
  hostname: '127.0.0.1',
  fetch(req) {
    const u = new URL(req.url)
    requests.push(u.pathname + u.search)
    if (u.pathname === '/releases/latest') return new Response(null, { status: 302, headers: { location: `https://github.com/x/y/releases/tag/v${release.version}` } })
    if (u.pathname === `/releases/latest/download/${NAME}`) return new Response(release.body)
    if (u.pathname === '/releases/latest/download/SHA256SUMS') return new Response(release.sums || `${sha(release.body)}  ${NAME}\n${sha('other')}  inyon-other\n`)
    const build = hub.builds[`${u.searchParams.get('os')}-${u.searchParams.get('arch')}`]
    if (u.pathname === '/node/inyon.sha256' && build) return new Response(hub.sumOverride || sha(build))
    if (u.pathname === '/node/inyon.gz' && build) return new Response(zlib.gzipSync(build))
    return new Response('not found', { status: 404 })
  },
})
afterAll(() => server.stop(true))
const BASE = 'http://127.0.0.1:4790'

let home: string
let restarts: [string, string[]][]
let waited: string[]
let startedOk: boolean
const deps = (more: Partial<Deps> = {}): Deps => ({
  version: '0.6.3',
  fetch,
  roles: () => ['link'],
  restart: (role, cmd) => (restarts.push([role, cmd]), { ok: true, how: 'fake' }),
  started: async (role) => (waited.push(role), startedOk),
  log: () => {},
  ...more,
})
const binDir = () => path.join(home, '.inyon', 'bin')
const installed = () => path.join(binDir(), process.platform === 'win32' ? 'inyon.exe' : 'inyon')

beforeAll(() => {
  process.env.INYON_DOWNLOAD = `${BASE}/releases/latest/download`
})
afterAll(() => {
  delete process.env.INYON_DOWNLOAD
})
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'inyon-update-'))
  spyOn(os, 'homedir').mockReturnValue(home)
  mkdirSync(binDir(), { recursive: true })
  writeFileSync(installed(), 'old build')
  release = { version: '9.9.9', body: 'new build', sums: '' }
  hub = { builds: { 'linux-x64': 'new linux build', 'windows-x64': 'new exe' }, sumOverride: '' }
  requests = []
  restarts = []
  waited = []
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
  const sums = `${'a'.repeat(64)}  inyon-linux-x64\n${'b'.repeat(64)} *inyon-windows-x64.exe\n`
  expect(sumFor(sums, 'inyon-linux-x64')).toBe('a'.repeat(64))
  expect(sumFor(sums, 'inyon-windows-x64.exe')).toBe('b'.repeat(64))
  expect(sumFor(sums, 'inyon-linux')).toBeUndefined()
})

test('the release file for each system', () => {
  expect(binaryName('linux', 'arm64')).toBe('inyon-linux-arm64')
  expect(binaryName('darwin', 'x64')).toBe('inyon-darwin-x64')
  // Windows on ARM runs the x64 build
  expect(binaryName('win32', 'arm64')).toBe('inyon-windows-x64.exe')
  expect(() => binaryName('freebsd', 'x64')).toThrow(UpdateError)
})

test('the newest version comes from where releases/latest redirects, or from a pinned tag', async () => {
  release.version = '0.7.1'
  expect(await latestVersion(`${BASE}/releases/latest/download`)).toBe('0.7.1')
  expect(await latestVersion('https://example.invalid/x/releases/download/v0.6.9')).toBe('0.6.9')
  await expect(latestVersion(`${BASE}/nothing-here/download`)).rejects.toThrow(UpdateError)
})

test('a release install downloads the newer build, checks it, swaps it in and restarts each job', async () => {
  const r = await update(findInstall([installed()], undefined), deps({ roles: () => ['link', 'hub'] }))
  expect(r).toMatchObject({ changed: true, version: '9.9.9' })
  expect(readFileSync(installed(), 'utf8')).toBe('new build')
  expect(restarts).toEqual([['link', [installed()]], ['hub', [installed()]]])
  expect(waited).toEqual(['link', 'hub'])
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
  release.sums = `${sha(release.body)}  inyon-some-other-build\n`
  await expect(update(findInstall([installed()], undefined), deps())).rejects.toThrow(UpdateError)
  expect(readFileSync(installed(), 'utf8')).toBe('old build')
})

test('already on the newest version: says so and downloads nothing', async () => {
  release.version = '0.6.3'
  const r = await update(findInstall([installed()], undefined), deps())
  expect(r).toEqual({ changed: false, message: 'inyon 0.6.3 is up to date.', version: '0.6.3' })
  expect(requests).toEqual(['/releases/latest'])
  expect(restarts).toEqual([])
})

test("a new version that doesn't start is swapped back out and every job restarted on the old one", async () => {
  startedOk = false
  await expect(update(findInstall([installed()], undefined), deps({ roles: () => ['link', 'node'] }))).rejects.toThrow('the previous version is running again')
  expect(readFileSync(installed(), 'utf8')).toBe('old build')
  expect(restarts.map(([r]) => r)).toEqual(['link', 'node', 'link', 'node'])
})

test('nothing running in the background: the new file is in place for the next start', async () => {
  const r = await update(findInstall([installed()], undefined), deps({ roles: () => [] }))
  expect(r.message).toContain("isn't running as a background service")
  expect(readFileSync(installed(), 'utf8')).toBe('new build')
})

test('a machine added to a hub takes the hub build when it differs, checked against the hub sha256', async () => {
  const install = findInstall([installed()], BASE)
  expect(install.kind).toBe('hub')
  const linux = deps({ platform: 'linux', arch: 'x64', roles: () => ['node'] })
  expect(await update(install, linux)).toMatchObject({ changed: true })
  expect(readFileSync(installed(), 'utf8')).toBe('new linux build')
  expect(restarts).toEqual([['node', [installed()]]])
  expect(requests).toContain('/node/inyon.gz?os=linux&arch=x64')

  // the same file as the hub's: nothing to do
  restarts = []
  expect(await update(install, linux)).toMatchObject({ changed: false })
  expect(restarts).toEqual([])

  // a checksum that doesn't match leaves the running copy alone
  hub.builds['linux-x64'] = 'tampered'
  hub.sumOverride = sha('what the hub meant')
  await expect(update(install, linux)).rejects.toThrow("didn't match the hub's checksum")
  expect(readFileSync(installed(), 'utf8')).toBe('new linux build')
})

test('a Windows machine asks its hub for the Windows build, whatever its processor', async () => {
  const install = findInstall([installed()], BASE)
  expect(await update(install, deps({ platform: 'win32', arch: 'arm64' }))).toMatchObject({ changed: true })
  expect(readFileSync(installed(), 'utf8')).toBe('new exe')
  expect(requests).toContain('/node/inyon.gz?os=windows&arch=x64')
})

test('which install is running', () => {
  expect(findInstall([installed()], undefined).kind).toBe('binary')
  expect(findInstall([installed()], 'http://hub')).toMatchObject({ kind: 'hub', hub: 'http://hub' })
  // tether-node's old place, before it has moved
  expect(findInstall([path.join(home, '.tether-node', 'tether-node.exe')], 'http://hub').kind).toBe('hub')
  expect(() => findInstall([process.execPath, '/src/inyon/apps/node/inyon.ts'], undefined)).toThrow('source checkout')
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
  const state = path.join(home, '.inyon', 'node', 'state.json')
  mkdirSync(path.dirname(state), { recursive: true })
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
