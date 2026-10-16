import { beforeEach, expect, test } from 'bun:test'
import { compareVersions, forgetLatest, latestAgentVersions, latestNpmVersion, parseVersion } from './agent-latest.ts'

beforeEach(forgetLatest)

test('reads the digits out of what each agent prints for --version', () => {
  expect(parseVersion('2.1.296 (Claude Code)')).toEqual([2, 1, 296])
  expect(parseVersion('codex-cli 0.49.0')).toEqual([0, 49, 0])
  expect(parseVersion('GitHub Copilot CLI 1.0.95.')).toEqual([1, 0, 95])
  expect(parseVersion('v1.18.35')).toEqual([1, 18, 35])
  expect(parseVersion('')).toBeUndefined()
  expect(parseVersion('not installed')).toBeUndefined()
})

test('compares versions by number, not by text', () => {
  expect(compareVersions('0.49.0', '0.50.0')).toBe(-1)
  expect(compareVersions('0.162.1', '0.49.0')).toBe(1)
  expect(compareVersions('2.1.296 (Claude Code)', 'v2.1.296')).toBe(0)
  expect(compareVersions('1.2', '1.2.0')).toBe(0)
  expect(compareVersions('1.2', '1.2.1')).toBe(-1)
  // an unreadable side never counts as outdated
  expect(compareVersions('', '1.0.0')).toBe(0)
  expect(compareVersions('1.0.0', undefined)).toBe(0)
})

/** a registry that answers with the given version (or fails), counting the calls */
function registry(answer: { version?: string; status?: number; fail?: boolean }) {
  const calls: string[] = []
  const get = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url))
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    if (answer.fail) throw new TypeError('fetch failed')
    return new Response(JSON.stringify({ version: answer.version }), { status: answer.status ?? 200 })
  }) as unknown as typeof fetch
  return { get, calls }
}

test('asks the registry once an hour per package', async () => {
  const r = registry({ version: '0.50.0' })
  let t = 1_000_000
  const now = () => t
  expect(await latestNpmVersion('@openai/codex', r.get, now)).toBe('0.50.0')
  expect(await latestNpmVersion('@openai/codex', r.get, now)).toBe('0.50.0')
  expect(r.calls).toEqual(['https://registry.npmjs.org/@openai/codex/latest'])
  t += 59 * 60_000
  await latestNpmVersion('@openai/codex', r.get, now)
  expect(r.calls.length).toBe(1)
  t += 2 * 60_000
  await latestNpmVersion('@openai/codex', r.get, now)
  expect(r.calls.length).toBe(2)
})

test('a failed lookup is unknown, and not retried for a few minutes', async () => {
  const r = registry({ fail: true })
  let t = 1_000_000
  const now = () => t
  expect(await latestNpmVersion('opencode-ai', r.get, now)).toBeUndefined()
  expect(await latestNpmVersion('opencode-ai', r.get, now)).toBeUndefined()
  expect(r.calls.length).toBe(1)
  t += 6 * 60_000
  await latestNpmVersion('opencode-ai', r.get, now)
  expect(r.calls.length).toBe(2)
})

test('an error status or an odd body is unknown too, never a throw', async () => {
  expect(await latestNpmVersion('a', registry({ status: 503 }).get)).toBeUndefined()
  expect(await latestNpmVersion('b', registry({ version: 'latest' }).get)).toBeUndefined()
})

test('two callers at once share one request', async () => {
  const r = registry({ version: '1.0.0' })
  const [a, b] = await Promise.all([latestNpmVersion('@github/copilot', r.get), latestNpmVersion('@github/copilot', r.get)])
  expect([a, b]).toEqual(['1.0.0', '1.0.0'])
  expect(r.calls.length).toBe(1)
})

test('looks every agent with a package up in parallel, and skips the ones without', async () => {
  const r = registry({ version: '9.9.9' })
  const all = await latestAgentVersions(r.get)
  expect(all).toEqual({ claude: '9.9.9', codex: '9.9.9', opencode: '9.9.9', copilot: '9.9.9', gemini: '9.9.9' })
  expect(r.calls).toContain('https://registry.npmjs.org/@anthropic-ai/claude-code/latest')
  expect(r.calls.some((u) => u.includes('antigravity'))).toBe(false)
})
