// bun apps/app/sw.ts <dist> — writes <dist>/sw.js: the web app's service worker (apps/web/public/sw.js),
// which shows push notifications and keeps the app's files for the next open, with this build's
// hashed files under assets/ as the ones to keep.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { withPrecacheList } from '../web/src/lib/precache.ts'

const dist = process.argv[2]
if (!dist) throw new Error('usage: bun apps/app/sw.ts <dist>')

const files = readdirSync(path.join(dist, 'assets'), { recursive: true, withFileTypes: true })
  .filter((f) => f.isFile())
  .map((f) => path.relative(dist, path.join(f.parentPath, f.name)).split(path.sep).join('/'))
const source = readFileSync(path.join(import.meta.dir, '../web/public/sw.js'), 'utf8')
writeFileSync(path.join(dist, 'sw.js'), withPrecacheList(source, files))
console.log(`sw.js keeps ${files.length} files`)
