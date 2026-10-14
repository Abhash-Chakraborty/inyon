import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { policy, tidyUploads } from './tidy.ts'

const homes: string[] = []
afterEach(() => homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true })))

function home() {
  const h = mkdtempSync(join(tmpdir(), 'inyon-tidy-'))
  homes.push(h)
  return h
}
const DAY = 86400_000
function file(h: string, rel: string, kb: number, ageMs: number) {
  const p = join(h, '.inyon', 'uploads', rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, new Uint8Array(kb * 1024))
  const t = new Date(Date.now() - ageMs)
  utimesSync(p, t, t)
  return p
}

test('with no hub around, old uploads and half-written ones go after the default week and hour', () => {
  const h = home()
  const old = file(h, 'a/old.png', 1, 8 * DAY)
  const cut = file(h, 'b/cut.mp4.part', 1, 2 * 3600_000)
  const going = file(h, 'b/going.mp4.part', 1, 60_000)
  const keep = file(h, 'b/new.png', 1, DAY)
  expect(tidyUploads(h)).toBe(2)
  expect([old, cut, going, keep].map(existsSync)).toEqual([false, false, true, true])
  expect(existsSync(join(h, '.inyon', 'uploads', 'a'))).toBe(false)
})

test("it follows the rules the hub last used on this machine", () => {
  const h = home()
  mkdirSync(join(h, '.inyon'), { recursive: true })
  writeFileSync(join(h, '.inyon', 'upload-policy'), '0 1\n')
  expect(policy(h)).toEqual({ days: 0, maxTotalMB: 1 })
  const ancient = file(h, 'a/one.bin', 600, 40 * DAY)
  const mid = file(h, 'a/two.bin', 600, 20 * DAY)
  const recent = file(h, 'a/three.bin', 300, DAY)
  tidyUploads(h)
  // Never: nothing goes for its age, but past 1 MB the oldest go first
  expect([ancient, mid, recent].map(existsSync)).toEqual([false, true, true])
})
