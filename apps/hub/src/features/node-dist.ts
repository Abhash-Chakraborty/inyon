import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { DATA_DIR } from '../config.ts'
import { HttpError } from '../hosts/registry.ts'

/**
 * What a machine downloads to become a tether-node: the script (one file, Windows prelude inlined)
 * for Unix machines with Bun, or for Windows a compiled .exe (Bun included, no console window) plus
 * busybox-w32, the small sh that runs the hub's commands there. Built and fetched on first use,
 * then cached under ~/.tether/node-dist.
 */
export const NODE_DIR = path.resolve(import.meta.dir, '../../../node')
const OUT = path.join(DATA_DIR, 'node-dist')

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

/** hash of the node's sources, so a changed tether-node.ts gets rebuilt */
function sourceHash() {
  const h = crypto.createHash('sha256')
  for (const f of ['tether-node.ts', 'win-prelude.sh']) h.update(fs.readFileSync(path.join(NODE_DIR, f)))
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

/** Earlier builds of tether-node (about 80 MB each for Windows) are never served again. */
function pruneOldBuilds() {
  const keep = sourceHash()
  try {
    for (const f of fs.readdirSync(OUT)) if (f.startsWith('tether-node-') && !f.includes(keep)) fs.rmSync(path.join(OUT, f), { force: true })
  } catch {}
}

async function nodeScript() {
  const file = path.join(OUT, `tether-node-${sourceHash()}.js`)
  if (fs.existsSync(file)) return file
  return once(file, async () => {
    fs.mkdirSync(OUT, { recursive: true })
    const r = await Bun.build({ entrypoints: [path.join(NODE_DIR, 'tether-node.ts')], target: 'bun' })
    if (!r.success) throw new HttpError(500, `Could not bundle tether-node: ${r.logs.join(' ')}`)
    fs.writeFileSync(file, await r.outputs[0].text())
    pruneOldBuilds()
    return file
  })
}

async function nodeExe(arch: string) {
  const file = path.join(OUT, `tether-node-${sourceHash()}-windows-${arch}.exe`)
  if (fs.existsSync(file)) return file
  return once(file, async () => {
    fs.mkdirSync(OUT, { recursive: true })
    // the first cross-compile downloads Bun's Windows runtime (about 35 MB)
    const p = Bun.spawn(
      [process.execPath, 'build', '--compile', `--target=bun-windows-${arch}`, '--windows-hide-console', path.join(NODE_DIR, 'tether-node.ts'), '--outfile', `${file}.tmp`],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
    // bun adds .exe to the output name
    const built = fs.existsSync(`${file}.tmp.exe`) ? `${file}.tmp.exe` : `${file}.tmp`
    if (code !== 0 || !fs.existsSync(built)) throw new HttpError(500, `Could not build tether-node.exe: ${err.trim().split('\n').at(-1)}`)
    fs.renameSync(built, file)
    pruneOldBuilds()
    return file
  })
}

/**
 * The .exe gzipped (86 MB down to about 40 MB), which matters over a VPN. Compressed on a worker
 * thread, once per build, so the hub keeps answering meanwhile.
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

/** sha256 of a build, so the installer can tell a cut-off download from a whole one */
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
    if (crypto.createHash('sha256').update(buf).digest('hex') !== sha256) throw new HttpError(502, 'busybox-w32 download did not match its pinned checksum')
    fs.writeFileSync(out, buf)
    return out
  })
}

const text = (file: string) => new Response(Bun.file(file), { headers: { 'content-type': 'text/plain; charset=utf-8' } })
const binary = (file: string, name: string) =>
  new Response(Bun.file(file), { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"` } })

/** plain-text errors: these are fetched by install scripts, not the app */
const route = (fn: (req: Request) => Promise<Response> | Response) => async (req: Request) => {
  try {
    return await fn(req)
  } catch (e) {
    return new Response(`${(e as Error).message}\n`, { status: e instanceof HttpError ? e.status : 500 })
  }
}

export const nodeRoutes = {
  '/node/install.sh': route(() => text(path.join(NODE_DIR, 'install.sh'))),
  '/node/install.ps1': route(() => text(path.join(NODE_DIR, 'install.ps1'))),
  '/node/tether-node.ts': route(async () => text(await nodeScript())),
  '/node/tether-node.exe': route(async (req) => binary(await nodeExe(archOf(new URL(req.url))), 'tether-node.exe')),
  '/node/tether-node.exe.gz': route(async (req) => binary(await gzipped(await nodeExe(archOf(new URL(req.url)))), 'tether-node.exe.gz')),
  '/node/tether-node.exe.sha256': route(async (req) => new Response(await sha256(await nodeExe(archOf(new URL(req.url)))), { headers: { 'content-type': 'text/plain' } })),
  '/node/busybox.exe': route(async (req) => binary(await busybox(archOf(new URL(req.url))), 'busybox.exe')),
}

/** The one-liners the "Add machine" sheet shows. */
export function pairCommands(hub: string, token: string) {
  return {
    unix: `curl -fsSL ${hub}/node/install.sh | sh -s -- ${hub} ${token}`,
    // works pasted into Windows PowerShell 5.1, PowerShell 7 and cmd.exe: no $ for the outer shell
    // to expand, and the token is base64url so single quotes are safe
    windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=3072; & ([scriptblock]::Create((irm '${hub}/node/install.ps1'))) -Hub '${hub}' -Token '${token}'"`,
  }
}

/** Builds the Windows binaries in the background so the first pairing doesn't wait for them. */
export function prebuildNode() {
  nodeScript().catch(() => {})
  nodeExe('x64')
    .then((f) => Promise.all([gzipped(f), sha256(f)]))
    .catch((e) => console.error('tether-node.exe build:', e?.message ?? e))
}
