import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// Vite leaves a url() it can't resolve as it is, and the hub answers that path with the app's
// page, so a wrong font path builds fine and quietly falls back to the system font.
test('every font file the stylesheet names can be found', () => {
  const css = readFileSync(path.join(import.meta.dir, 'fonts.css'), 'utf8')
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]!.replace(/['"]/g, ''))
  expect(urls.length).toBeGreaterThan(0)
  for (const url of urls) {
    const file = url.startsWith('.') ? path.resolve(import.meta.dir, url) : Bun.resolveSync(url, import.meta.dir)
    expect(existsSync(file)).toBe(true)
  }
})
