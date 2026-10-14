import { expect, test } from 'bun:test'
import { Glob } from 'bun'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// the inyon-design rules that a look at the code can check, so a later change can't quietly undo them
const files = [...new Glob('**/*.tsx').scanSync(import.meta.dir)].filter((f) => !f.includes('.test.')).map((f) => [f, readFileSync(path.join(import.meta.dir, f), 'utf8')] as const)
const css = readFileSync(path.join(import.meta.dir, 'styles.css'), 'utf8')
const offenders = (re: RegExp) => files.filter(([, src]) => re.test(src)).map(([f]) => f)

test('no text is set below 12px', () => {
  expect(offenders(/text-\[(\d|1[01])(\.\d+)?px\]/)).toEqual([])
})

test('labels are sentence case, not uppercase eyebrows', () => {
  expect(offenders(/\buppercase\b/)).toEqual([])
})

test('nothing uses a gradient', () => {
  expect(offenders(/bg-gradient|linear-gradient|radial-gradient/)).toEqual([])
  expect(css).not.toMatch(/gradient\(/)
})

test('nothing blurs what is behind it', () => {
  expect(offenders(/backdrop-blur/)).toEqual([])
})

// status chips are neutral and the dot carries the state; blue was a colour nothing else used
test('there is no blue info colour', () => {
  expect(css).not.toMatch(/--info\b/)
  expect(offenders(/-info\b/)).toEqual([])
})

// motion moves things with transform and opacity; animating size or position makes the page lay out
// again on every frame. The .expand grid-rows helper is the one allowed exception.
const LAYOUT = /\b(left|right|top|bottom|inset|width|height|margin|padding)\b/
test('no transition animates a layout property', () => {
  expect(offenders(/transition-\[[^\]]*\b(left|right|top|bottom|inset|width|height|margin|padding)\b/)).toEqual([])
  const declared = [...css.matchAll(/transition(?:-property)?:\s*([^;}]+)/g)].map((m) => m[1]!)
  expect(declared.filter((d) => LAYOUT.test(d))).toEqual([])
})

test('with reduced motion, sheets fade for about 120ms instead of sliding', () => {
  const block = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
  for (const cls of ['animate-sheet-in', 'animate-sheet-out']) expect(block).toContain('.' + cls)
  expect(block).toMatch(/\.animate-sheet-in[^{]*\{[^}]*animation-name: fade-in !important;[^}]*animation-duration: 120ms !important/)
  expect(block).toMatch(/\.animate-sheet-out[^{]*\{[^}]*animation-name: fade-out !important;[^}]*animation-duration: 120ms !important/)
})

// the motion rules from the 0.11.1 pass: nothing overshoots, nothing but a sheet takes longer
// than 480ms, and no transition is left to transition-all
test('no ease overshoots', () => {
  for (const m of css.matchAll(/cubic-bezier\(([^)]+)\)/g)) {
    const [, y1, , y2] = m[1]!.split(',').map(Number)
    expect(y1! <= 1 && y2! <= 1, m[0]).toBe(true)
  }
  expect(offenders(/ease-out-back|ease-\[cubic-bezier\([^)]*1\.[1-9]/)).toEqual([])
})

test('nothing but a sheet or a loop animates longer than 480ms', () => {
  const long = [...css.matchAll(/animation:\s*([\w-]+)\s+([\d.]+)s[^;}]*/g)].filter((m) => Number(m[2]) > 0.48 && !/infinite/.test(m[0]) && !/sheet/.test(m[1]!))
  expect(long.map((m) => m[0])).toEqual([])
  expect(offenders(/duration-(5\d\d|[6-9]\d\d|1000)\b/)).toEqual([])
})

test('no transition-all', () => {
  expect(offenders(/transition-all/)).toEqual([])
  expect(css).not.toMatch(/transition:\s*all\b/)
})

// a tablet held sideways has no keyboard: "Ctrl K" and "Alt N" there are noise (Oct 2026 test)
test('keyboard hints hide on a touch screen', () => {
  const hints = files.flatMap(([f, src]) => [...src.matchAll(/<kbd className="([^"]*)"/g)].map((m) => [f, m[1]!] as const))
  expect(hints.length).toBeGreaterThan(0)
  expect(hints.filter(([, cls]) => !cls.includes('pointer-coarse:hidden'))).toEqual([])
  const menu = files.find(([f]) => f.endsWith('primitives.tsx'))![1]
  expect(menu).toMatch(/\{it\.keys && <span className="[^"]*pointer-coarse:hidden/)
})

// the Android app draws under the status bar; everything at the top of the screen starts below it
test('the sidebar and every page header leave room for the status bar', () => {
  const shell = files.find(([f]) => f.endsWith('AppShell.tsx'))![1]
  expect(shell).toMatch(/<aside className="pt-safe /)
  const headers = files.flatMap(([f, src]) => [...src.matchAll(/<header className="([^"]*)"/g)].map((m) => [f, m[1]!] as const))
  expect(headers.length).toBeGreaterThan(0)
  expect(headers.filter(([, cls]) => !cls.includes('pt-safe'))).toEqual([])
})
