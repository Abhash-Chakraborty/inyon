// bun scripts/readme/frames.ts in.webp out.png [ms…]: a contact sheet of an animated WebP at the
// given times, to check a recording without playing it.
import sharp from 'sharp'

const [input, output, ...times] = process.argv.slice(2)
if (!input || !output) throw new Error('usage: frames.ts in.webp out.png [ms…]')
const meta = await sharp(input, { animated: true }).metadata()
const delays = meta.delay ?? []
const pages = meta.pages ?? 1
const total = delays.reduce((a, b) => a + b, 0)
const at = times.length ? times.map(Number) : [0, 0.25, 0.5, 0.75, 0.98].map((f) => Math.floor(f * total))
const pageAt = (ms: number) => {
  let t = 0
  for (let i = 0; i < pages; i++) {
    t += delays[i] ?? 0
    if (t > ms) return i
  }
  return pages - 1
}
const w = meta.width!
const h = meta.pageHeight ?? meta.height!
const cols = Math.min(at.length, 3)
const rows = Math.ceil(at.length / cols)
const tiles = await Promise.all(at.map(async (ms) => ({ input: await sharp(input, { page: pageAt(ms) }).png().toBuffer(), ms })))
await sharp({ create: { width: cols * w, height: rows * h, channels: 3, background: '#888' } })
  .composite(tiles.map((t, i) => ({ input: t.input, left: (i % cols) * w, top: Math.floor(i / cols) * h })))
  .png()
  .toFile(output)
console.log(`${pages} frames, ${total} ms; sampled at ${at.join(', ')} ms -> ${output}`)
