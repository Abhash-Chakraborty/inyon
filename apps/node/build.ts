import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { engineFile, TARGETS, type Target } from './targets.ts'

/**
 * Builds the engine: one file per system with Bun inside, so a machine needs nothing else.
 *
 *   bun apps/node/build.ts <out-dir> [target…]
 *
 * builds the release files (all targets unless some are named) with the hub and the web app in
 * them, plus SHA256SUMS. Each is attached as inyon-engine-<system>, which the inyon command
 * (apps/cli) runs. Build the web app first (bun run build). A hub run from a git checkout calls
 * buildInyon itself for the machines it adds, leaving the hub out.
 */

const ENTRY = path.join(import.meta.dir, 'inyon.ts')
const WEB_DIST = path.resolve(import.meta.dir, '../web/dist')

/** Bun's name for a target: the same as ours, except that it spells arm64 on musl as aarch64. */
const bunTarget = (t: Target) => `bun-${t === 'linux-arm64-musl' ? 'linux-aarch64-musl' : t}` as Bun.Build.CompileTarget

export interface BuildOptions {
  target: Target
  outfile: string
  /** with the hub and the web app, as released; without, only what a machine added to a hub runs */
  hub: boolean
  /** the commit it's built from, which the hub shows in Settings */
  commit?: string
  /** no console window on Windows, for a program that only ever runs in the background */
  hideConsole?: boolean
}

export async function buildInyon(o: BuildOptions) {
  // the web app goes in under a name of its own; the hub finds it next to its code (see index.ts)
  let stage: string | undefined
  if (o.hub) {
    if (!existsSync(path.join(WEB_DIST, 'index.html'))) throw new Error(`${WEB_DIST} has no web app in it. Run bun run build first.`)
    stage = mkdtempSync(path.join(os.tmpdir(), 'inyon-build-'))
    cpSync(WEB_DIST, path.join(stage, 'inyon-web'), { recursive: true })
  }
  try {
    mkdirSync(path.dirname(o.outfile), { recursive: true })
    const r = await Bun.build({
      entrypoints: [ENTRY],
      minify: true,
      define: o.hub ? { 'process.env.INYON_BUILD_COMMIT': JSON.stringify(o.commit ?? '') } : { 'process.env.INYON_NODE_ONLY': '"1"' },
      compile: {
        target: bunTarget(o.target),
        outfile: o.outfile,
        ...(stage ? { assets: [path.join(stage, 'inyon-web')] } : {}),
        ...(o.hideConsole && o.target.startsWith('windows') ? { windows: { hideConsole: true } } : {}),
      },
    })
    if (!r.success) throw new Error(`Couldn't build inyon for ${o.target}: ${r.logs.map(String).join(' ')}`)
    // Bun adds .exe for Windows
    return existsSync(o.outfile) ? o.outfile : `${o.outfile}.exe`
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true })
  }
}

export async function sha256File(file: string) {
  const h = crypto.createHash('sha256')
  await pipeline(createReadStream(file), h)
  return h.digest('hex')
}

if (import.meta.main) {
  const [out, ...wanted] = process.argv.slice(2)
  if (!out) {
    console.error('usage: bun apps/node/build.ts <out-dir> [target…]')
    process.exit(2)
  }
  const targets = wanted.length ? (wanted as Target[]) : [...TARGETS]
  const commit = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: import.meta.dir }).stdout.toString().trim()
  const sums: string[] = []
  for (const t of targets) {
    if (!TARGETS.includes(t)) throw new Error(`${t} isn't one of ${TARGETS.join(', ')}`)
    // on Windows the engine only runs in the background or for the inyon command, so it gets no
    // console window of its own: the sign-in task starts it directly, with nothing flashing up
    const file = await buildInyon({ target: t, outfile: path.join(out, engineFile(t)), hub: true, commit, hideConsole: true })
    sums.push(`${await sha256File(file)}  ${path.basename(file)}`)
    console.log(`built ${path.basename(file)}`)
  }
  writeFileSync(path.join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`)
}
