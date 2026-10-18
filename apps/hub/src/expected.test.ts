import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { expectedFiles, FIXTURES, format } from './expected.ts'

// The Rust readers are checked against fixtures/expected; these keep those files true to the TS
// readers. A failure here means a reader changed: rerun `bun src/cli/expected.ts` and commit it.
const files = expectedFiles()

test('fixtures/expected holds what the TS readers make of every capture', () => {
  const stale: string[] = []
  for (const [path, value] of files) {
    const url = new URL(`expected/${path}`, FIXTURES)
    if (!existsSync(url) || readFileSync(url, 'utf8') !== format(value)) stale.push(path)
  }
  expect(stale).toEqual([])
})

test('every chat.screen sample comes from a capture', () => {
  const sources = files.get('chat-screen.json') as { sample: string; capture: string | null }[]
  expect(sources.length).toBeGreaterThan(0)
  expect(sources.filter((s) => !s.capture).map((s) => s.sample)).toEqual([])
})
