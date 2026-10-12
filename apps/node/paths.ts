import os from 'node:os'
import path from 'node:path'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync } from 'node:fs'

// This program was tether-node before the rename to Inyon. A TETHER_* variable set then (by an
// installer, a service, a hub's command) counts as its INYON_* name wherever it's read.
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('TETHER_') && v !== undefined) process.env[`INYON_${k.slice('TETHER_'.length)}`] ??= v
}

/**
 * Where the inyon program keeps itself and the node's state: the binary in ~/.inyon/bin, pairings,
 * keys and logs in ~/.inyon/node. Worked out on each use, so tests can point HOME at a throwaway
 * folder.
 */
export const NAME = 'inyon'
export const binDir = () => path.join(os.homedir(), '.inyon', 'bin')
/** the installed program */
export const installedBinary = (win = process.platform === 'win32') => path.join(binDir(), win ? `${NAME}.exe` : NAME)

/** The folder before the rename to Inyon, when this program was tether-node. */
export const oldDir = () => path.join(os.homedir(), '.tether-node')
const newDir = () => path.join(os.homedir(), '.inyon', 'node')

/**
 * The node's folder. A machine set up as tether-node has ~/.tether-node: it moves to ~/.inyon/node
 * the first time, with a link left at the old path for whatever still points there (a service, an
 * update script). Windows won't move a folder while a program in it runs; the old folder is used
 * as it is until it can be moved.
 */
export function nodeDir() {
  const dir = newDir()
  if (existsSync(dir)) return dir
  const old = oldDir()
  try {
    if (lstatSync(old).isSymbolicLink()) return dir
  } catch {
    return dir
  }
  try {
    mkdirSync(path.dirname(dir), { recursive: true })
    renameSync(old, dir)
  } catch {
    return old
  }
  try {
    // a junction needs no admin rights on Windows
    symlinkSync(dir, old, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {}
  return dir
}

export function readEnvFile(file: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(file, 'utf8').split(/\r?\n/).flatMap((l) => {
        const m = l.match(/^(\w+)=(.*)$/)
        return m ? [[m[1], m[2]!.trim()]] : []
      }),
    )
  } catch {
    return {}
  }
}

/**
 * What the installers saved for the hub connection: env (Linux and macOS) or .env (Windows) in the
 * node's folder, with names from before the rename read as their INYON_* names.
 */
export function savedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ['.env', 'env']) {
    for (const [k, v] of Object.entries(readEnvFile(path.join(nodeDir(), name)))) {
      const key = k.startsWith('TETHER_') ? `INYON_${k.slice('TETHER_'.length)}` : k
      if (k.startsWith('INYON_') || !(key in out)) out[key] = v
    }
  }
  return out
}

/** The hub this machine connects to, if it was added to one. */
export function savedHub(env: Record<string, string | undefined> = process.env) {
  const hub = env.INYON_HUB || savedEnv().INYON_HUB
  return hub ? hub.replace(/\/+$/, '') : undefined
}
