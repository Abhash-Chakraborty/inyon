// Rewrites fixtures/expected/ from the TS readers: `bun apps/hub/src/cli/expected.ts`. Run it after
// a reader changes on purpose, or a capture is added, and commit the result with the change.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectedFiles, FIXTURES, format } from '../expected.ts'

const root = join(fileURLToPath(FIXTURES), 'expected')
const files = expectedFiles()

// files for captures that are gone
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
try {
  for (const f of walk(root)) if (!files.has(f.slice(root.length + 1))) rmSync(f)
} catch {}

for (const [path, value] of files) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), format(value))
}
console.log(`wrote ${files.size} files to fixtures/expected`)
