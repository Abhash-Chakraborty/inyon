import { expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const css = readFileSync(path.join(import.meta.dir, 'symbols.css'), 'utf8')
const src = readFileSync(path.join(import.meta.dir, 'TerminalView.tsx'), 'utf8')

// "⏵⏵ accept edits on" came out as two boxes on an Android phone: its fonts have no U+23F5
test("the terminal's last font draws the symbols agents use that phones lack", () => {
  const url = /url\(\.\/([^)]+)\)/.exec(css)?.[1]
  expect(url).toBe('symbols.woff2')
  const file = path.join(import.meta.dir, url!)
  expect(existsSync(file)).toBe(true)
  // a cut of a few glyphs, not a whole symbol font in the APK
  expect(statSync(file).size).toBeLessThan(4096)
  expect(css).toContain("font-family: 'Inyon Symbols'")
  // ⏵ ⏸ ⏹ ⏺ and the rest of the block
  expect(css).toContain('unicode-range: U+23E9-23FA')
  expect(src).toContain("import './symbols.css'")
  expect(/TERMINAL_FONT = "([^"]+)"/.exec(src)?.[1]?.trim().endsWith("'Inyon Symbols'")).toBe(true)
  expect(existsSync(path.join(import.meta.dir, 'symbols-OFL.txt'))).toBe(true)
})

// parts of Claude's diffs came out dark on dark over psmux: xterm lifts text that is too faint
test('text in the terminal keeps a readable contrast', () => {
  expect(src).toMatch(/minimumContrastRatio: MIN_CONTRAST/)
  expect(Number(/MIN_CONTRAST = ([\d.]+)/.exec(src)?.[1])).toBeGreaterThanOrEqual(4.5)
})
