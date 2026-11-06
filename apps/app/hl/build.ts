// bun apps/app/hl/build.ts <out dir> — bundles hl.ts with highlight.js's core into a small entry
// file and one file per language, each named by its content (the hub serves /next/assets/ as never
// changing). Prints the entry file's name.
import path from 'node:path'

const out = process.argv[2]
if (!out) throw new Error('usage: bun apps/app/hl/build.ts <out dir>')

const r = await Bun.build({
  entrypoints: [path.join(import.meta.dir, 'hl.ts')],
  outdir: out,
  naming: { entry: 'hl-[hash].[ext]', chunk: 'hl-[hash].[ext]' },
  target: 'browser',
  format: 'esm',
  splitting: true,
  minify: true,
})
if (!r.success) {
  for (const l of r.logs) console.error(l)
  process.exit(1)
}
const [file] = r.outputs.filter((o) => o.kind === 'entry-point')
console.log(path.basename(file!.path))
