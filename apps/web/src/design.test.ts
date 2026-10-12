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

// status chips are neutral and the dot carries the state; blue was a colour nothing else used
test('there is no blue info colour', () => {
  expect(css).not.toMatch(/--info\b/)
  expect(offenders(/-info\b/)).toEqual([])
})
