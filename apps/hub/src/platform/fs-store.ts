import fs from 'node:fs'
import path from 'node:path'
import type { Store } from './store.ts'

/** The hub's records: one JSON file per key under the data directory, readable only by you. */
export function fsStore(dir: string): Store {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = (key: string) => path.join(dir, `${key}.json`)
  return {
    get(key) {
      try {
        return JSON.parse(fs.readFileSync(file(key), 'utf8'))
      } catch {
        return undefined
      }
    },
    set(key, value) {
      const f = file(key)
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 })
      // write then rename, so a crash never leaves half a file
      const tmp = `${f}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
      fs.renameSync(tmp, f)
    },
    del(key) {
      fs.rmSync(file(key), { force: true })
    },
    keys(prefix) {
      const sub = path.dirname(`${prefix}x`)
      try {
        return fs
          .readdirSync(path.join(dir, sub))
          .filter((f) => f.endsWith('.json'))
          .map((f) => path.posix.join(sub === '.' ? '' : sub, f.slice(0, -5)))
          .filter((k) => k.startsWith(prefix))
      } catch {
        return []
      }
    },
  }
}
