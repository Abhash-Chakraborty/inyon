// Renders the PNG app icons from public/icon.svg (run: bun --filter @inyon/web icons)
import sharp from 'sharp'
import path from 'node:path'

const pub = path.join(import.meta.dir, '../public')
const svg = await Bun.file(path.join(pub, 'icon.svg')).text()
const maskable = svg.replace('rx="116"', 'rx="0"').replace('<path', '<g transform="translate(51 51) scale(0.8)"><path').replace('</svg>', '</g></svg>')

for (const [file, size, src] of [
  ['icon-192.png', 192, svg],
  ['icon-512.png', 512, svg],
  ['apple-touch-icon.png', 180, maskable],
  ['icon-maskable-512.png', 512, maskable],
] as const) {
  await sharp(Buffer.from(src)).resize(size, size).png().toFile(path.join(pub, file))
  console.log('wrote', file)
}
