import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { appendFileSync, chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { compressed, ENGINE, INSTALL_URL, RELEASES_REPO, releaseFiles } from '@inyon/protocol'
import { nodeDir, readEnvFile, savedHub } from './paths.ts'
import type { Role } from './service.ts'

export { readEnvFile, savedHub }

/**
 * `inyon update`: replaces the installed program with the newest build and restarts each job it
 * runs as (the phone link, the hub connection, the hub). A machine added to a hub takes the build
 * that hub serves, checked against the sha256 the hub publishes, so it always matches its hub;
 * anything else updates from the GitHub releases, checked against the release's SHA256SUMS like get.sh
 * does (the gzipped copy of each file first, since 0.11). Nothing is replaced until the download
 * matches, and the old copy comes back if the new one doesn't start. A release that comes as an
 * engine and a command-line program (0.13 and on, see releaseFiles) is installed as both.
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

/** This computer as the releases and the hub name it: linux, darwin or windows, x64 or arm64. */
export function target(platform: string = process.platform, arch: string = os.arch()) {
  const o = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined
  const a = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : undefined
  if (!o || !a) throw new UpdateError(`There's no Inyon build for ${platform} ${arch}.`)
  return { os: o, arch: a }
}

/**
 * The release files for this computer (see releaseFiles); `cli` is what get.sh and get.ps1 pick.
 * Windows on ARM gets the arm64 command but the x64 engine: Bun has no Windows on ARM build,
 * and the x64 one runs there under Windows' own emulation.
 */
export function releaseNames(platform: string = process.platform, arch: string = os.arch()) {
  const t = target(platform, arch)
  return { cli: releaseFiles(`${t.os}-${t.arch}`).cli, engine: releaseFiles(`${t.os}-${t.os === 'windows' ? 'x64' : t.arch}`).engine }
}
export const binaryName = (platform?: string, arch?: string) => releaseNames(platform, arch).cli

/** The one line that installs the newest version from scratch. */
export const reinstallCommand = (platform: string = process.platform) =>
  platform === 'win32' ? `irm ${INSTALL_URL}/get.ps1 | iex` : `curl -fsSL ${INSTALL_URL}/get.sh | sh`

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

async function download(url: string, get: typeof fetch) {
  let res: Response
  try {
    res = await get(url)
  } catch (err) {
    throw new UpdateError(`Couldn't download ${url} (${(err as Error).message}).`)
  }
  if (!res.ok || !res.body) throw new UpdateError(`Couldn't download ${url} (${res.status}).`)
  return new Uint8Array(await res.arrayBuffer())
}

const sha256 = (data: Uint8Array) => crypto.createHash('sha256').update(data).digest('hex')

/**
 * Downloads release file `name` to `to`, checked against the release's SHA256SUMS. The gzipped
 * copy is taken when the release lists one (under half the size), and checked before it's
 * unpacked; the unpacked file is checked like a plain download.
 */
export async function fetchRelease(base: string, name: string, sums: string, to: string, get: typeof fetch) {
  const want = sumFor(sums, name)
  if (!want) throw new UpdateError(`The release doesn't list ${name} in SHA256SUMS, so nothing was changed.`)
  const mismatch = new UpdateError("The download didn't match the release's checksum, so nothing was changed. Try again.")
  const gz = sumFor(sums, compressed(name))
  let data = await download(`${base}/${gz ? compressed(name) : name}`, get)
  if (gz) {
    if (sha256(data) !== gz) throw mismatch
    try {
      data = zlib.gunzipSync(data)
    } catch (err) {
      throw new UpdateError(`Couldn't unpack ${compressed(name)} (${(err as Error).message}).`)
    }
  }
  if (sha256(data) !== want) throw mismatch
  writeFileSync(to, data)
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
      const names = releaseNames(platform, deps.arch)
      const sums = await text(`${base}/SHA256SUMS`, deps.fetch)
      // from 0.13 a release is two files (see releaseFiles)
      if (sumFor(sums, names.engine)) return await crossOver(install, { base, sums, version, names }, platform, deps)
      deps.log(`Downloading inyon ${version} (${names.cli})…`)
      await fetchRelease(base, names.cli, sums, tmp, deps.fetch)
    } else {
      const t = target(platform, deps.arch)
      const q = `?os=${t.os}&arch=${t.arch}`
      const want = (await text(`${install.hub}/node/inyon.sha256${q}`, deps.fetch)).toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(want)) throw new UpdateError(`${install.hub} didn't give a checksum for inyon. Update the hub first.`)
      if (existsSync(install.file) && (await sha256File(install.file)) === want) return { changed: false, message: `inyon ${deps.version} is the same as the hub's.`, version: deps.version }
      deps.log(`Downloading inyon from ${install.hub}…`)
      // it comes gzipped (about half the size), which matters over a VPN
      const data = zlib.gunzipSync(await download(`${install.hub}/node/inyon.gz${q}`, deps.fetch))
      if (sha256(data) !== want) throw new UpdateError("The download didn't match the hub's checksum, so nothing was changed. Try again.")
      writeFileSync(tmp, data)
    }
  } catch (err) {
    files.remove(tmp)
    throw err
  }
  runnable(tmp, platform)
  return put(install, [{ file: install.file, tmp }], version, deps)
}

/** Makes a checked download a program this system will start. */
function runnable(file: string, platform: string) {
  if (platform !== 'win32') chmodSync(file, 0o755)
  // Apple Silicon only runs signed programs; a local signature is enough (as get.sh does)
  if (platform === 'darwin') Bun.spawnSync(['codesign', '--force', '--sign', '-', file], { stdout: 'ignore', stderr: 'ignore' })
}

/**
 * The update to a release of two files (0.13 and on): the engine goes in next to `inyon`, then the
 * command-line program that starts it takes `inyon`'s place. Both are checked before either moves,
 * and both go back if the new version doesn't start. This version's updater can't try again on
 * its own, so a machine that gets stuck halfway is told the one line that installs the new
 * version from scratch.
 */
async function crossOver(install: Install, release: { base: string; sums: string; version: string; names: { cli: string; engine: string } }, platform: string, deps: Deps): Promise<Result> {
  const engine = path.join(path.dirname(install.file), ENGINE + path.extname(install.file))
  const swaps = [
    { file: engine, tmp: `${engine}.download`, name: release.names.engine },
    { file: install.file, tmp: `${install.file}.download`, name: release.names.cli },
  ]
  try {
    for (const s of swaps) {
      deps.log(`Downloading inyon ${release.version} (${s.name})…`)
      await fetchRelease(release.base, s.name, release.sums, s.tmp, deps.fetch)
      runnable(s.tmp, platform)
    }
    return await put(install, swaps, release.version, deps)
  } catch (err) {
    for (const s of swaps) files.remove(s.tmp)
    if (!(err instanceof UpdateError)) throw err
    throw new UpdateError(`${err.message} Inyon ${release.version} comes as two files, and this copy couldn't put both in place. Install it with:\n  ${reinstallCommand(platform)}`)
  }
}

/**
 * Swaps the checked downloads in (the program that's restarted last), restarts each job, and
 * puts everything back if the new copy won't run.
 */
async function put(install: Install, swaps: { file: string; tmp: string }[], version: string | undefined, deps: Deps): Promise<Result> {
  const roles = deps.roles()
  const done = swaps.map((s) => ({ ...s, old: swapIn(s.file, s.tmp) }))
  const program = done[done.length - 1]!
  const label = version ? `inyon ${version}` : 'The new inyon'
  const before = new Map(roles.map((r) => [r, readRunning(r)?.pid]))
  const restarted = roles.filter((r) => deps.restart(r, install.cmd).ok)
  if (!restarted.length) {
    // nothing runs it in the background: the new file is in place for the next start
    return { changed: true, version, message: `${label} is installed. It isn't running as a background service, so start it again to use it.` }
  }
  const up = await Promise.all(restarted.map((r) => deps.started(r, version, before.get(r))))
  if (up.every(Boolean)) {
    for (const s of done) {
      if (!s.old) continue
      try {
        files.remove(s.old)
      } catch {}
    }
    return { changed: true, version, message: `${label} is installed and running.` }
  }
  if (!program.old) throw new UpdateError(`${label} didn't start.`)
  // the program first, so the restart runs the old one; a file that had no old copy just goes
  for (const s of [...done].reverse()) {
    if (s.old) swapBack(s.file, s.old)
    else {
      try {
        files.remove(s.file)
      } catch {}
    }
  }
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
