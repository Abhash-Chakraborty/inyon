import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { appendFileSync, chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { RELEASES_REPO } from '@inyon/protocol'
import { nodeDir, readEnvFile, savedHub } from './paths.ts'
import type { Role } from './service.ts'

export { readEnvFile, savedHub }

/**
 * `inyon update`: replaces the installed program with the newest build and restarts each job it
 * runs as (the phone link, the hub connection, the hub). A machine added to a hub takes the build
 * that hub serves, checked against the sha256 the hub publishes, so it always matches its hub;
 * anything else updates from the GitHub releases, checked against the release's SHA256SUMS like get.sh
 * does. Nothing is replaced until the download matches, and the old copy comes back if the new one
 * doesn't start.
 */

export const RELEASES = `https://github.com/${RELEASES_REPO}/releases/latest/download`
/** What the app reads to follow an update it started: running, done <version>, current, failed: … */
export const statusFile = () => path.join(nodeDir(), 'update-status')

export class UpdateError extends Error {}

/** 1 when `a` is newer than `b`, -1 when older, 0 when the same ("v0.6.3", "0.10.0", "0.7.0-rc.1"). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = String(v).trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)(?:-([\w.-]+))?/)
    return m ? { nums: m[1]!.split('.').map(Number), pre: m[2] } : undefined
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return 0
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return Math.sign(d)
  }
  // a release is newer than its own pre-releases
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0 ? 1 : -1
}
export const isNewer = (a: string, b: string) => compareVersions(a, b) > 0

/** The build for this computer as the releases and the hub name it (Windows on ARM runs x64). */
export function target(platform: string = process.platform, arch: string = os.arch()) {
  if (platform === 'win32') return { os: 'windows', arch: 'x64' }
  const o = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined
  const a = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : undefined
  if (!o || !a) throw new UpdateError(`There's no Inyon build for ${platform} ${arch}.`)
  return { os: o, arch: a }
}

/** The release file for this computer, as get.sh and get.ps1 pick it. */
export function binaryName(platform: string = process.platform, arch: string = os.arch()) {
  const t = target(platform, arch)
  return `inyon-${t.os}-${t.arch}${t.os === 'windows' ? '.exe' : ''}`
}

/** The checksum SHA256SUMS lists for `name` (sha256sum writes "<hex>  name" or "<hex> *name"). */
export function sumFor(sums: string, name: string) {
  for (const line of sums.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i)
    if (m && m[2] === name) return m[1]!.toLowerCase()
  }
  return undefined
}

/**
 * The newest release's version. `…/releases/latest` redirects to `…/releases/tag/v1.2.3`, so one
 * request without following it says which; a base pinned to a tag (…/download/v1.2.3) says so itself.
 */
export async function latestVersion(base: string, get: typeof fetch = fetch) {
  const pinned = base.match(/\/releases\/download\/v?([^/]+)\/?$/)
  if (pinned) return pinned[1]!
  const page = base.replace(/\/+$/, '').replace(/\/download$/, '')
  let res: Response
  try {
    res = await get(page, { redirect: 'manual' })
  } catch (err) {
    throw new UpdateError(`Couldn't reach ${new URL(page).host} to look for a new version (${(err as Error).message}).`)
  }
  const tag = (res.headers.get('location') ?? res.url ?? '').match(/\/tag\/v?([^/?#]+)/)
  if (!tag) throw new UpdateError(`Couldn't tell the newest version from ${page} (${res.status}).`)
  return decodeURIComponent(tag[1]!)
}

export async function sha256File(file: string) {
  const h = crypto.createHash('sha256')
  await pipeline(createReadStream(file), h)
  return h.digest('hex')
}

async function download(url: string, to: string, get: typeof fetch, gunzip = false) {
  let res: Response
  try {
    res = await get(url)
  } catch (err) {
    throw new UpdateError(`Couldn't download ${url} (${(err as Error).message}).`)
  }
  if (!res.ok || !res.body) throw new UpdateError(`Couldn't download ${url} (${res.status}).`)
  const data = new Uint8Array(await res.arrayBuffer())
  writeFileSync(to, gunzip ? zlib.gunzipSync(data) : data)
}

async function text(url: string, get: typeof fetch) {
  let res: Response
  try {
    res = await get(url)
  } catch (err) {
    throw new UpdateError(`Couldn't reach ${url} (${(err as Error).message}).`)
  }
  if (!res.ok) throw new UpdateError(`${url} answered ${res.status}.`)
  return (await res.text()).trim()
}

/** The file system calls the swap makes, so tests can act like Windows (a running .exe is locked). */
export const files = { rename: renameSync, remove: (f: string) => rmSync(f, { force: true }), exists: existsSync, list: readdirSync }

/**
 * Puts `fresh` in place of `target` and returns where the old copy went. Windows can't overwrite
 * or delete a running .exe, but it can rename one, so the old copy is always renamed aside first
 * (target.old-<time>); it's removed once the new version runs, or by a later start.
 */
export function swapIn(target: string, fresh: string, now = Date.now()) {
  const old = aside(target, now)
  const had = files.exists(target)
  if (had) files.rename(target, old)
  try {
    files.rename(fresh, target)
  } catch (err) {
    if (had) files.rename(old, target)
    throw err
  }
  return had ? old : undefined
}

/** Puts the old copy back; the new one is renamed aside too, in case it's still running. */
export function swapBack(target: string, old: string, now = Date.now()) {
  if (files.exists(target)) files.rename(target, aside(target, now))
  files.rename(old, target)
}

/** A free name to rename `target` aside to (two in the same millisecond don't collide). */
function aside(target: string, now: number) {
  let n = now
  while (files.exists(`${target}.old-${n}`)) n++
  return `${target}.old-${n}`
}

/**
 * Removes copies renamed aside by earlier updates. Only ones older than ten minutes: a copy from
 * the update running right now may still be needed to go back to.
 */
export function cleanupOld(target: string, now = Date.now()) {
  const base = path.basename(target)
  let names: string[]
  try {
    names = files.list(path.dirname(target)) as string[]
  } catch {
    return
  }
  for (const name of names) {
    const m = name.startsWith(`${base}.old-`) && name.slice(base.length + 5).match(/^(\d+)$/)
    if (!m || now - Number(m[1]) < 10 * 60_000) continue
    try {
      files.remove(path.join(path.dirname(target), name))
    } catch {}
  }
}

export type Install =
  /** from the GitHub releases (get.sh, get.ps1) */
  | { kind: 'binary'; file: string; cmd: string[] }
  /** from the hub this machine was added to */
  | { kind: 'hub'; file: string; cmd: string[]; hub: string }

/** Which kind of install `cmd` (the program, or Bun and a script) is. */
export function findInstall(cmd: string[], hub = savedHub()): Install {
  if (cmd.length > 1) throw new UpdateError('This copy of inyon runs from a source checkout. Update it with git pull.')
  const file = cmd[0]!
  return hub ? { kind: 'hub', file, cmd, hub } : { kind: 'binary', file, cmd }
}

export interface Deps {
  version: string
  fetch: typeof fetch
  /** the jobs this machine runs inyon as in the background, each restarted after the swap */
  roles(): Role[]
  /** restarts a job's background service so the new file runs */
  restart(role: Role, cmd: string[]): { ok: boolean; how: string }
  /** waits for the restarted copy to come up (not the copy `before`); true once it runs and stays up */
  started(role: Role, version?: string, before?: number): Promise<boolean>
  log(line: string): void
  platform?: NodeJS.Platform
  arch?: string
}

export interface Result {
  changed: boolean
  message: string
  version?: string
}

/** Updates the install `cmd` belongs to. Throws an UpdateError that says what went wrong. */
export async function update(install: Install, deps: Deps): Promise<Result> {
  const platform = deps.platform ?? process.platform
  const tmp = `${install.file}.download`
  files.remove(tmp)
  let version: string | undefined
  try {
    if (install.kind === 'binary') {
      const base = (process.env.INYON_DOWNLOAD || RELEASES).replace(/\/+$/, '')
      version = await latestVersion(base, deps.fetch)
      if (!isNewer(version, deps.version)) return { changed: false, message: `inyon ${deps.version} is up to date.`, version: deps.version }
      const name = binaryName(platform, deps.arch)
      deps.log(`Downloading inyon ${version} (${name})…`)
      await download(`${base}/${name}`, tmp, deps.fetch)
      const want = sumFor(await text(`${base}/SHA256SUMS`, deps.fetch), name)
      if (!want || want !== (await sha256File(tmp))) throw new UpdateError("The download didn't match the release's checksum, so nothing was changed. Try again.")
    } else {
      const t = target(platform, deps.arch)
      const q = `?os=${t.os}&arch=${t.arch}`
      const want = (await text(`${install.hub}/node/inyon.sha256${q}`, deps.fetch)).toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(want)) throw new UpdateError(`${install.hub} didn't give a checksum for inyon. Update the hub first.`)
      if (existsSync(install.file) && (await sha256File(install.file)) === want) return { changed: false, message: `inyon ${deps.version} is the same as the hub's.`, version: deps.version }
      deps.log(`Downloading inyon from ${install.hub}…`)
      // it comes gzipped (about half the size), which matters over a VPN
      await download(`${install.hub}/node/inyon.gz${q}`, tmp, deps.fetch, true)
      if ((await sha256File(tmp)) !== want) throw new UpdateError("The download didn't match the hub's checksum, so nothing was changed. Try again.")
    }
  } catch (err) {
    files.remove(tmp)
    throw err
  }
  if (platform !== 'win32') chmodSync(tmp, 0o755)
  // Apple Silicon only runs signed programs; a local signature is enough (as get.sh does)
  if (platform === 'darwin') Bun.spawnSync(['codesign', '--force', '--sign', '-', tmp], { stdout: 'ignore', stderr: 'ignore' })
  return put(install, tmp, version, deps)
}

/** Swaps the checked download in, restarts each job, and goes back if the new copy won't run. */
async function put(install: Install, tmp: string, version: string | undefined, deps: Deps): Promise<Result> {
  const roles = deps.roles()
  const old = swapIn(install.file, tmp)
  const label = version ? `inyon ${version}` : 'The new inyon'
  const before = new Map(roles.map((r) => [r, readRunning(r)?.pid]))
  const restarted = roles.filter((r) => deps.restart(r, install.cmd).ok)
  if (!restarted.length) {
    // nothing runs it in the background: the new file is in place for the next start
    return { changed: true, version, message: `${label} is installed. It isn't running as a background service, so start it again to use it.` }
  }
  const up = await Promise.all(restarted.map((r) => deps.started(r, version, before.get(r))))
  if (up.every(Boolean)) {
    if (old) {
      try {
        files.remove(old)
      } catch {}
    }
    return { changed: true, version, message: `${label} is installed and running.` }
  }
  if (!old) throw new UpdateError(`${label} didn't start.`)
  swapBack(install.file, old)
  for (const r of restarted) deps.restart(r, install.cmd)
  throw new UpdateError(`${label} didn't start, so the previous version is running again.`)
}

/** What a started copy writes with its pid and version: state.json (the link), node.json, hub.json. */
export const runningFile = (role: Role) => path.join(nodeDir(), role === 'link' ? 'state.json' : `${role}.json`)

const alive = (pid: unknown) => {
  if (typeof pid !== 'number' || pid <= 1) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return !exited(pid)
}

/**
 * A process that has exited but wasn't collected yet (in a container whose first process doesn't
 * collect them, say) still answers kill(pid, 0). Linux shows it as Z.
 */
export function exited(pid: number) {
  try {
    return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return false
  }
}

/** Whether a copy doing `role` has started and still runs. */
export const isRunning = (role: Role) => alive(readRunning(role)?.pid)

export function readRunning(role: Role): { pid?: number; version?: string } | undefined {
  try {
    return JSON.parse(readFileSync(runningFile(role), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Waits for the restarted copy: it writes its pid and version when it starts (a pid other than the
 * copy before it), and must still be running a few seconds later.
 */
export async function waitStarted(role: Role, version: string | undefined, before?: number, o = { tries: 60, every: 500, settle: 4000 }) {
  for (let i = 0; i < o.tries; i++) {
    const s = readRunning(role)
    if (s && s.pid !== before && alive(s.pid) && (!version || s.version === version)) {
      await Bun.sleep(o.settle)
      return alive(s.pid)
    }
    await Bun.sleep(o.every)
  }
  return false
}

/** Records how the update went, for the app (and appends to update.log). */
export function setStatus(line: string) {
  try {
    mkdirSync(nodeDir(), { recursive: true })
    writeFileSync(statusFile(), `${line}\n`)
    appendFileSync(path.join(nodeDir(), 'update.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

/**
 * The link from before this version doesn't write its version into state.json: running setup
 * again (get.sh, get.ps1) restarts such a link, so re-running the installer is an update too.
 */
export const staleLink = (state: { version?: string } | undefined, version: string) => !!state && state.version !== version
