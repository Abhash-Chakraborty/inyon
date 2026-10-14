/**
 * Keeps ~/.inyon/uploads tidy on this machine by itself, so files sent from a phone or a hub don't
 * pile up when no hub is around to clean them: a computer paired only with a phone, or one whose
 * hub is gone. It follows the rules the hub last used here (~/.inyon/upload-policy, written by the
 * hub's cleanup), and otherwise deletes uploads after 7 days and keeps at most 1 GB. Files an
 * upload left half written (*.part) go after an hour.
 */
import { existsSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DAY = 86400_000

export interface Policy {
  /** 0: keep them, whatever their age */
  days: number
  /** 0: no limit */
  maxTotalMB: number
}

export function policy(home = homedir()): Policy {
  try {
    const [days, max] = readFileSync(join(home, '.inyon', 'upload-policy'), 'utf8').trim().split(/\s+/).map(Number)
    if (days >= 0 && max >= 0) return { days, maxTotalMB: max }
  } catch {}
  return { days: 7, maxTotalMB: 1024 }
}

type Entry = { path: string; size: number; mtime: number }

function files(dir: string, out: Entry[] = []): Entry[] {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, d.name)
    try {
      if (d.isDirectory()) files(path, out)
      else if (d.isFile()) {
        const st = statSync(path)
        out.push({ path, size: st.size, mtime: st.mtimeMs })
      }
    } catch {}
  }
  return out
}

function dropEmpty(dir: string, top = true): boolean {
  let empty = true
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!(d.isDirectory() && dropEmpty(join(dir, d.name), false))) empty = false
  }
  if (empty && !top) {
    try {
      rmdirSync(dir)
    } catch {
      return false
    }
  }
  return empty
}

/** Deletes what the policy says should go; returns how many files went. */
export function tidyUploads(home = homedir(), p = policy(home), now = Date.now()) {
  const dir = join(home, '.inyon', 'uploads')
  if (!existsSync(dir)) return 0
  let gone = 0
  const drop = (e: Entry) => {
    try {
      unlinkSync(e.path)
      gone++
      return true
    } catch {
      return false
    }
  }
  let all = files(dir).filter((e) => {
    const old = (p.days > 0 && now - e.mtime > p.days * DAY) || (e.path.endsWith('.part') && now - e.mtime > 3600_000)
    return !(old && drop(e))
  })
  if (p.maxTotalMB > 0) {
    // oldest first, but never a file still being written
    all = all.filter((e) => !e.path.endsWith('.part')).sort((a, b) => a.mtime - b.mtime)
    let total = all.reduce((n, e) => n + e.size, 0)
    for (const e of all) {
      if (total <= p.maxTotalMB * 1024 * 1024) break
      if (drop(e)) total -= e.size
    }
  }
  dropEmpty(dir)
  return gone
}

/** Tidies a minute after start, then every six hours, for as long as this inyon runs. */
export function startTidying(home = homedir()) {
  const run = () => {
    try {
      tidyUploads(home)
    } catch {}
  }
  setTimeout(run, 60_000).unref?.()
  setInterval(run, 6 * 3600_000).unref?.()
}
