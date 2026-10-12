import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../hosts/host.ts'
import { sha256Hex } from '../platform/store.ts'
import { guessCodexRollout } from './codex.ts'
import { guessGeminiSession } from './gemini.ts'

// a home folder with a space in its name, as on many Macs and Windows machines
const root = mkdtempSync(join(tmpdir(), 'inyon-find-'))
const home = join(root, 'my home')
afterAll(() => rmSync(root, { recursive: true, force: true }))
const host = new Host({ id: 'find', name: 'Find', kind: 'local' } as any)
const startedAt = Math.floor(Date.now() / 1000) - 60

test("a Codex conversation is found under a home whose path has a space", async () => {
  const dir = join(home, '.codex', 'sessions', '2026', '10', '12')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'rollout-2026-10-12T00-00-00-abc.jsonl')
  writeFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: 'abc', cwd: '/work/my app' } }) + '\n')
  expect(await guessCodexRollout(host, home, { pid: 1, cwd: '/work/my app', startedAt })).toBe(file)
})

test('a Gemini chat is found under a home whose path has a space', async () => {
  const dir = join(home, '.gemini', 'tmp', 'proj', 'chats')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session-1.json')
  writeFileSync(file, JSON.stringify({ sessionId: 's1', projectHash: sha256Hex('/work/my app') }) + '\n')
  expect(await guessGeminiSession(host, home, { cwd: '/work/my app', startedAt })).toBe(file)
})
