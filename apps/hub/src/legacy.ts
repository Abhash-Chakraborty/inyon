import fs from 'node:fs'
import path from 'node:path'

// Inyon was called Tether. What a machine kept from then still works. Imported before anything
// else in the hub, so a TETHER_* variable counts as its INYON_* name wherever it's read.
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('TETHER_') && v !== undefined) process.env[`INYON_${k.slice('TETHER_'.length)}`] ??= v
}

/**
 * Moves ~/.tether to ~/.inyon once and leaves a link at the old path, so hooks, status lines and
 * services still pointing there keep working until they're rewritten. Does nothing when the new
 * folder exists already or the old one is a link (moved before).
 */
export function moveOldFolder(home: string, from = '.tether', to = '.inyon') {
  const old = path.join(home, from)
  const dir = path.join(home, to)
  try {
    if (fs.lstatSync(old).isSymbolicLink() || fs.existsSync(dir)) return
  } catch {
    return
  }
  fs.renameSync(old, dir)
  try {
    fs.symlinkSync(dir, old)
  } catch {}
}

