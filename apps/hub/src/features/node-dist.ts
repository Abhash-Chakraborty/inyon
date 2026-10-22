import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { compressed, RELEASES_REPO, VERSION } from '@inyon/protocol'
import INSTALL_SH from '../../../node/install.sh' with { type: 'text' }
import INSTALL_PS1 from '../../../node/install.ps1' with { type: 'text' }
import HUB_UPDATE_PS1 from '../../../node/hub-update.ps1' with { type: 'text' }
import { CLI_TARGETS, cliFile, engineFile, HUB_TARGETS, type CliTarget, type HubTarget, type Target } from '../../../node/targets.ts'
import { DATA_DIR } from '../env.ts'
import { HttpError } from '../hosts/registry.ts'
import { fillUpdateScript, nodeUpdates } from '../hosts/node-update.ts'
import { signingKey, verifyMinisign } from './minisign.ts'
import { unixPairCommand } from './pair-command.ts'

/**
 * What a machine downloads from its hub to run Inyon: the inyon command for its system (/node/inyon,
 * small, what services run) and the engine it runs (/node/inyon-engine, Bun inside, nothing else
 * to install), and on Windows busybox-w32, the small sh the hub's commands run with. The hub
 * program (get.sh --hub) hands out the release of its own version from GitHub, checked against
 * that release's SHA256SUMS, so a machine never needs GitHub itself. A hub run from a git checkout
 * builds the engine from its own source, without the hub in it, and serves a command built with
 * cargo when one is in apps/cli/dist (INYON_CLI_DIST); without one Windows gets the release's
 * command, and otherwise the engine stands in for both, as every release before 0.13 was. Either
 * way it's kept under ~/.inyon/node-dist.
 */
export const NODE_DIR = path.resolve(import.meta.dir, '../../../node')
const OUT = path.join(DATA_DIR, 'node-dist')
const FROM_SOURCE = !Bun.isStandaloneExecutable
const CLI_DIST = process.env.INYON_CLI_DIST || path.resolve(NODE_DIR, '../cli/dist')
/**
 * What install.sh can ask for; their checksums go into the "Add a machine" command. The hub hands
 * out the glibc engines only (HUB_TARGETS, not the release's musl ones), so a checkout builds
 * five, as before.
 */
const UNIX = HUB_TARGETS.filter((t) => !t.startsWith('windows'))

/** busybox-w32 FRP-6075, checked against frippery.org/files/busybox/SHA256SUM */
const BUSYBOX: Record<string, { file: string; sha256: string }> = {
  x64: { file: 'busybox-w64u-FRP-6075-g169694ebd.exe', sha256: '6e263d154d8548d1eb936f65d1d8312c80df31c45974e48d6335e4dcc0f4f34c' },
  arm64: { file: 'busybox-w64a-FRP-6075-g169694ebd.exe', sha256: 'e67f873d19d58c535cc9f0c4965ffd622e19b7bab87e3da89cb2185fb54464d7' },
}

const archOf = (url: URL) => {
  const arch = url.searchParams.get('arch') ?? 'x64'
  if (arch !== 'x64' && arch !== 'arm64') throw new HttpError(400, 'arch must be x64 or arm64')
  return arch
}

/** The engine a request asks for (?os=linux&arch=arm64). Windows on ARM runs the x64 engine. */
export function targetOf(url: URL): Target {
  const os = url.searchParams.get('os') ?? 'windows'
  if (os === 'windows') return 'windows-x64'
  const t = `${os}-${archOf(url)}` as Target
  if (!(HUB_TARGETS as readonly Target[]).includes(t)) throw new HttpError(400, 'os must be linux, darwin or windows')
  return t
}

/** The inyon command a request asks for: the same systems, plus Windows on ARM as its own build. */
export function cliTargetOf(url: URL): CliTarget {
  const os = url.searchParams.get('os') ?? 'windows'
  const t = `${os}-${archOf(url)}` as CliTarget
  if (!CLI_TARGETS.includes(t)) throw new HttpError(400, 'os must be linux, darwin or windows')
  return t
}

const SOURCES = [NODE_DIR, path.resolve(NODE_DIR, '../../packages/link/src'), path.resolve(NODE_DIR, '../../packages/protocol/src')]

/** hash of what goes into a machine's engine (the node and the packages it uses), so any change gets rebuilt */
function sourceHash() {
  const h = crypto.createHash('sha256')
  for (const dir of SOURCES) {
    for (const f of fs.readdirSync(dir).filter((f) => /\.(ts|sh)$/.test(f) && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')).sort()) {
      h.update(`${path.basename(dir)}/${f}`).update(fs.readFileSync(path.join(dir, f)))
    }
  }
  return h.digest('hex').slice(0, 16)
}

const building = new Map<string, Promise<string>>()
function once(key: string, make: () => Promise<string>) {
  let p = building.get(key)
  if (!p) {
    p = make().finally(() => building.delete(key))
    building.set(key, p)
  }
  return p
}

export const tag = () => (FROM_SOURCE ? sourceHash() : `v${VERSION}`)

/**
 * Earlier builds and downloads (about 100 MB each) are never served again. A file is named after
 * its build (`<tag>-inyon-engine-…`, `v<version>-inyon-…`, with .gz and .sha256 next to it); only
 * this hub's own tag and release version stay, and files from before 0.13 (`inyon-<tag>-…`,
 * `tether-node-…`) go with the rest. busybox is pinned on its own and isn't touched.
 */
export function pruneOld(dir = OUT) {
  const keep = new Set([tag(), `v${VERSION}`])
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /^(?:(.*?)-)?(?:inyon|tether-node)-/.exec(f)
      if (m && !keep.has(m[1] ?? '')) fs.rmSync(path.join(dir, f), { force: true })
    }
  } catch {}
}

/** The engine for `t`, built or downloaded once. */
export async function engine(t: Target) {
  const file = path.join(OUT, `${tag()}-${engineFile(t)}`)
  if (fs.existsSync(file)) return file
  return once(file, async () => {
    fs.mkdirSync(OUT, { recursive: true })
    if (FROM_SOURCE) {
      const { buildInyon } = await import('../../../node/build.ts')
      // the first build for a system downloads Bun's runtime for it (about 35 MB)
      const built = await buildInyon({ target: t, outfile: `${file}.tmp`, hub: false, hideConsole: true }).catch((e) => {
        throw new HttpError(500, `Could not build the Inyon engine for ${t}: ${(e as Error).message}`)
      })
      fs.renameSync(built, file)
    } else {
      fs.writeFileSync(`${file}.tmp`, await releaseFile(engineFile(t), await releaseSums(), releaseBase()))
      fs.renameSync(`${file}.tmp`, file)
    }
    pruneOld()
    return file
  })
}

/** The cargo-built command for `t` next to a checkout, if there is one. */
const builtCommand = (t: CliTarget) => {
  const f = path.join(CLI_DIST, cliFile(t))
  return fs.existsSync(f) ? f : undefined
}

/** The inyon command for `t`: the release's, or for a hub run from a checkout see sourceCommand. */
export async function command(t: CliTarget): Promise<string> {
  return FROM_SOURCE ? sourceCommand(t) : releaseCommand(t)
}

/** The release's inyon command for `t`, downloaded once and checked against its SHA256SUMS. */
async function releaseCommand(t: CliTarget): Promise<string> {
  const file = path.join(OUT, `v${VERSION}-${cliFile(t)}`)
  if (fs.existsSync(file)) return file
  return once(file, async () => {
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(`${file}.tmp`, await releaseFile(cliFile(t), await releaseSums(), releaseBase()))
    fs.renameSync(`${file}.tmp`, file)
    pruneOld()
    return file
  })
}

/**
 * A checkout's command for `t`: what cargo built into apps/cli/dist. Without that, Windows gets the
 * release's command (the engine as inyon.exe has no `inyon uninstall` and the like), and the
 * engine only when the release can't be had. Linux and macOS get the engine, which is a whole
 * program too: install.sh learns from SHA256SUMS that it stands in for both.
 */
export async function sourceCommand(
  t: CliTarget,
  from: { built: (t: CliTarget) => string | undefined; release: (t: CliTarget) => Promise<string>; engine: (t: Target) => Promise<string> } = { built: builtCommand, release: releaseCommand, engine },
): Promise<string> {
  const built = from.built(t)
  if (built) return built
  if (!t.startsWith('windows')) return from.engine(t as Target)
  try {
    return await from.release(t)
  } catch (e) {
    const why = (e as Error).message
    if (t === 'windows-arm64') throw new HttpError(503, `This hub runs from a checkout and has no inyon command for ${t}: none in ${CLI_DIST}, and the release's failed (${why}).`)
    console.warn(`inyon command for ${t}: none in ${CLI_DIST} and the release's failed (${why}); handing out the engine instead`)
    return from.engine(t as Target)
  }
}

/** Whether this hub hands out the engine as a file of its own (a checkout without a built command doesn't). */
const splitRelease = (t: HubTarget) => !FROM_SOURCE || !!builtCommand(t)

/** Where the hub finds the release of its own version (INYON_DOWNLOAD for a mirror). */
const releaseBase = () => (process.env.INYON_DOWNLOAD || `https://github.com/${RELEASES_REPO}/releases/download/v${VERSION}`).replace(/\/+$/, '')

let sumsText: Promise<string> | undefined
function releaseSums() {
  sumsText ??= signedSums(releaseBase(), signingKey(releaseBase()))
  sumsText.catch(() => (sumsText = undefined))
  return sumsText
}

/**
 * The release's SHA256SUMS, refused unless SHA256SUMS.minisig signs it with `key`: the hub hands
 * out what this list names, and puts its hash in every "Add a machine" command.
 */
export async function signedSums(base: string, key: string, get: typeof fetch = fetch): Promise<string> {
  const r = await get(`${base}/SHA256SUMS`)
  if (!r.ok) throw new HttpError(502, `Could not get the checksums of Inyon ${VERSION} (${r.status})`)
  const sums = new Uint8Array(await r.arrayBuffer())
  const s = await get(`${base}/SHA256SUMS.minisig`)
  if (!s.ok) throw new HttpError(502, `Could not get the signature of Inyon ${VERSION}'s checksums (${s.status}), so nothing from that release is handed out`)
  if (!verifyMinisign(sums, await s.text(), key)) throw new HttpError(502, `The checksums of Inyon ${VERSION} at ${base} aren't signed with Inyon's release key, so nothing from that release is handed out`)
  return new TextDecoder().decode(sums)
}

const sumFor = (sums: string, name: string) => sums.split(/\r?\n/).map((l) => l.trim().split(/\s+\*?/)).find(([, n]) => n === name)?.[0]?.toLowerCase()
const digest = (data: Uint8Array) => crypto.createHash('sha256').update(data).digest('hex')

/**
 * Release file `name`, checked against the release's SHA256SUMS. The gzipped copy is taken when
 * the release lists one (under half the size) and checked before it's unpacked; machines get the
 * plain bytes either way.
 */
export async function releaseFile(name: string, sums: string, base: string, get: typeof fetch = fetch): Promise<Buffer> {
  const want = sumFor(sums, name)
  if (!want) throw new HttpError(502, `Inyon ${VERSION} has no ${name} on ${RELEASES_REPO}`)
  const gz = sumFor(sums, compressed(name))
  const asset = gz ? compressed(name) : name
  const r = await get(`${base}/${asset}`)
  if (!r.ok) throw new HttpError(502, `Could not download ${asset} (${r.status})`)
  let data = Buffer.from(await r.arrayBuffer())
  if (gz) {
    if (digest(data) !== gz) throw new HttpError(502, `${asset} did not match its release checksum`)
    data = zlib.gunzipSync(data)
  }
  if (digest(data) !== want) throw new HttpError(502, `${name} did not match its release checksum`)
  return data
}

/**
 * The checksums of the Linux and macOS files, which install.sh checks its downloads against: the
 * command under its release name, and the engine under its own when the hub hands it out apart.
 * The "Add a machine" command carries the checksum of this list, so neither can be swapped on the way.
 */
export async function unixSums() {
  const sums = FROM_SOURCE ? undefined : await releaseSums()
  const lines = await Promise.all(
    UNIX.flatMap((t) => {
      const names = splitRelease(t) ? [cliFile(t), engineFile(t)] : [cliFile(t)]
      return names.map(async (name) => {
        const sum = sums ? sumFor(sums, name) : await sha256(name === cliFile(t) ? await command(t) : await engine(t))
        if (!sum) throw new HttpError(502, `Inyon ${VERSION} has no ${name} on ${RELEASES_REPO}`)
        return `${sum}  ${name}`
      })
    }),
  )
  return `${lines.join('\n')}\n`
}

/**
 * A file gzipped (the engine comes down to about half), which matters over a VPN. Compressed on a
 * worker thread, once per build, so the hub keeps answering meanwhile.
 */
async function gzipped(file: string) {
  const gz = `${file}.gz`
  if (fs.existsSync(gz)) return gz
  return once(gz, async () => {
    await pipeline(fs.createReadStream(file), zlib.createGzip({ level: 6 }), fs.createWriteStream(`${gz}.tmp`))
    fs.renameSync(`${gz}.tmp`, gz)
    return gz
  })
}

/** sha256 of a build, so a download can be told from a cut-off or swapped one */
async function sha256(file: string) {
  const out = `${file}.sha256`
  if (fs.existsSync(out)) return fs.readFileSync(out, 'utf8')
  const h = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), h)
  const hex = h.digest('hex')
  fs.writeFileSync(out, hex)
  return hex
}

async function busybox(arch: string) {
  const { file, sha256 } = BUSYBOX[arch]
  const out = path.join(OUT, file)
  if (fs.existsSync(out)) return out
  return once(out, async () => {
    fs.mkdirSync(OUT, { recursive: true })
    const r = await fetch(`https://frippery.org/files/busybox/${file}`)
    if (!r.ok) throw new HttpError(502, `Could not download busybox-w32 (${r.status})`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (digest(buf) !== sha256) throw new HttpError(502, 'busybox-w32 download did not match its pinned checksum')
    fs.writeFileSync(out, buf)
    return out
  })
}

const plain = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
const binary = (file: string, name: string) =>
  new Response(Bun.file(file), { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"` } })

/** plain-text errors: these are fetched by install scripts, not the app */
const route = (fn: (req: Request) => Promise<Response> | Response) => async (req: Request) => {
  try {
    return await fn(req)
  } catch (e) {
    return plain(`${(e as Error).message}\n`, e instanceof HttpError ? e.status : 500)
  }
}

const engineOf = (req: Request) => targetOf(new URL(req.url))
const commandOf = (req: Request) => cliTargetOf(new URL(req.url))
/** what tether-node's own installer and update script ask for: the Windows program, whole */
const windows = () => engine('windows-x64')
const REPLACED = 'Inyon replaced tether-node with the inyon program. Copy the "Add a machine" command from the hub again and run it on this machine.\n'

export const nodeRoutes = {
  '/node/install.sh': route(() => plain(INSTALL_SH)),
  '/node/install.ps1': route(() => plain(INSTALL_PS1)),
  '/node/SHA256SUMS': route(async () => plain(await unixSums())),
  // the inyon command: what install.sh, install.ps1 and `inyon update` on a machine take first
  '/node/inyon': route(async (req) => binary(await command(commandOf(req)), cliFile(commandOf(req)))),
  '/node/inyon.gz': route(async (req) => binary(await gzipped(await command(commandOf(req))), `${cliFile(commandOf(req))}.gz`)),
  '/node/inyon.sha256': route(async (req) => plain(await sha256(await command(commandOf(req))))),
  // the engine behind it, which the command fetches from here rather than from GitHub
  '/node/inyon-engine': route(async (req) => binary(await engine(engineOf(req)), engineFile(engineOf(req)))),
  '/node/inyon-engine.gz': route(async (req) => binary(await gzipped(await engine(engineOf(req))), `${engineFile(engineOf(req))}.gz`)),
  '/node/inyon-engine.sha256': route(async (req) => plain(await sha256(await engine(engineOf(req))))),
  '/node/busybox.exe': route(async (req) => binary(await busybox(archOf(new URL(req.url))), 'busybox.exe')),
  // its pinned checksum, which install.ps1 checks the download against (known without downloading it)
  '/node/busybox.exe.sha256': route((req) => plain(BUSYBOX[archOf(new URL(req.url))]!.sha256)),
  // a Windows machine set up before the rename updates through these (see hub-update.ps1)
  '/node/tether-node.exe': route(async () => binary(await windows(), 'tether-node.exe')),
  '/node/tether-node.exe.gz': route(async () => binary(await gzipped(await windows()), 'tether-node.exe.gz')),
  '/node/tether-node.exe.sha256': route(async () => plain(await sha256(await windows()))),
  // tether-node as a Bun script (install.sh before the rename) has no update to the program
  '/node/tether-node.ts': route(() => plain(REPLACED, 410)),
  '/node/tether-node.ts.sha256': route(() => plain(REPLACED, 410)),
}

/** The one-liners the "Add machine" sheet shows (the Unix one checks what it downloads, see pair-command.ts). */
export async function pairCommands(hub: string, token: string) {
  const installSh = crypto.createHash('sha256').update(INSTALL_SH).digest('hex')
  const sums = crypto.createHash('sha256').update(await unixSums()).digest('hex')
  return {
    unix: unixPairCommand(hub, token, installSh, sums),
    // works pasted into Windows PowerShell 5.1, PowerShell 7 and cmd.exe: no $ for the outer shell
    // to expand, and the token is base64url so single quotes are safe
    windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=3072; & ([scriptblock]::Create((irm '${hub}/node/install.ps1'))) -Hub '${hub}' -Token '${token}'"`,
  }
}

/**
 * The update script for a Windows machine set up before the rename to Inyon (see
 * hosts/node-update.ts), with the checksum of the program this hub serves it filled in.
 */
export async function updateScript(platform: string, arch: string) {
  if (platform !== 'win32') throw new HttpError(409, REPLACED.trim())
  const sum = await sha256(await windows())
  return fillUpdateScript(HUB_UPDATE_PS1, { sha256: sum, version: VERSION, arch: arch === 'arm64' ? 'arm64' : 'x64' })
}
nodeUpdates.useScripts(updateScript)

/**
 * Builds what machines download in the background, so adding one doesn't wait for it. The hub
 * program only fetches the release's checksums now, and each file the first time it's asked for.
 */
export function prebuildNode() {
  // hubs started by tests never hand out the program, and building it fetches Bun for four systems
  if (process.env.NODE_ENV === 'test') return
  ;(async () => {
    if (!FROM_SOURCE) return void (await releaseSums())
    for (const t of [...UNIX, 'windows-x64'] as Target[]) await engine(t).then((f) => Promise.all([sha256(f), gzipped(f)]))
  })().catch((e) => console.error('inyon build for machines:', e?.message ?? e))
}
