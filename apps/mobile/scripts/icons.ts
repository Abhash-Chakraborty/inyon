// Renders the app icons and splash screens from the web app's icon (run: pnpm --filter @inyon/mobile icons)
import sharp from 'sharp'
import path from 'node:path'

const root = path.join(import.meta.dir, '..')
const svg = await Bun.file(path.join(root, '../web/public/icon.svg')).text()
const BG = '#14161B'
// the mark alone on a transparent square, scaled into the middle (adaptive icons and splash screens)
const mark = (scale: number) => {
  const inner = svg.replace(/<rect[^>]*\/>/, '')
  const off = (512 - 512 * scale) / 2
  return Buffer.from(inner.replace('<path', `<g transform="translate(${off} ${off}) scale(${scale})"><path`).replace('</svg>', '</g></svg>'))
}
const square = Buffer.from(svg.replace('rx="116"', 'rx="0"'))
const round = Buffer.from(svg.replace('rx="116"', 'rx="256"'))

// the browser's notification badge: the mark alone, white on transparent (it's shown as a mask)
await sharp(Buffer.from(mark(0.9).toString().replaceAll('#F4F4F1', '#FFFFFF'))).resize(96, 96).png().toFile(path.join(root, '../web/public/badge-96.png'))

// the web app's own icons (home screen, install prompt, Apple touch icon)
const web = path.join(root, '../web/public')
await sharp(Buffer.from(svg)).resize(192, 192).png().toFile(`${web}/icon-192.png`)
await sharp(Buffer.from(svg)).resize(512, 512).png().toFile(`${web}/icon-512.png`)
await sharp({ create: { width: 512, height: 512, channels: 3, background: BG } }).composite([{ input: await sharp(mark(0.72)).resize(512, 512).png().toBuffer() }]).png().toFile(`${web}/icon-maskable-512.png`)
await sharp(square).resize(180, 180).flatten({ background: BG }).png().toFile(`${web}/apple-touch-icon.png`)

const res = path.join(root, 'android/app/src/main/res')
for (const [dir, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]] as const) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(`${res}/mipmap-${dir}/ic_launcher.png`)
  await sharp(round).resize(size, size).png().toFile(`${res}/mipmap-${dir}/ic_launcher_round.png`)
  // adaptive icons crop to the middle 66%, so the mark sits well inside it
  const fg = Math.round((size * 108) / 48)
  await sharp(mark(0.74)).resize(fg, fg).png().toFile(`${res}/mipmap-${dir}/ic_launcher_foreground.png`)
}
await Bun.write(`${res}/values/ic_launcher_background.xml`, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG}</color>\n</resources>\n`)

async function splash(file: string, w: number, h: number) {
  const s = Math.round(Math.min(w, h) * 0.5)
  const icon = await sharp(mark(1)).resize(s, s).png().toBuffer()
  await sharp({ create: { width: w, height: h, channels: 3, background: BG } }).composite([{ input: icon, gravity: 'center' }]).png().toFile(file)
}
await splash(`${res}/drawable/splash.png`, 480, 320)
for (const [dir, w, h] of [['mdpi', 320, 480], ['hdpi', 480, 800], ['xhdpi', 720, 1280], ['xxhdpi', 960, 1600], ['xxxhdpi', 1280, 1920]] as const) {
  await splash(`${res}/drawable-port-${dir}/splash.png`, w, h)
  await splash(`${res}/drawable-land-${dir}/splash.png`, h, w)
}

const xc = path.join(root, 'ios/App/App/Assets.xcassets')
// iOS rounds the corners itself and wants no transparency
await sharp(square).resize(1024, 1024).flatten({ background: BG }).png().toFile(`${xc}/AppIcon.appiconset/AppIcon-512@2x.png`)
for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) await splash(`${xc}/Splash.imageset/${f}`, 2732, 2732)
console.log('icons and splash screens written')
