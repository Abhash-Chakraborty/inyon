import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { writeConfig } from './features.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())

// a home with a space in its name, next to an unrelated file named after its first word
const root = mkdtempSync(join(tmpdir(), 'inyon-cfg-'))
const home = join(root, 'space home')
afterAll(() => {
  chmodSync(join(home, '.claude'), 0o755)
  rmSync(root, { recursive: true, force: true })
})
mkdirSync(join(home, '.claude'), { recursive: true })
const host = new Host({ id: 'cfg', name: 'Cfg', kind: 'local' } as any)
spyOn(registry, 'get').mockReturnValue({ host, probe: { home }, state: { status: 'online', agents: ['claude'], sessions: [] } } as any)
const file = join(home, '.claude', 'settings.json')

test("clearing old backups removes only backups, whatever spaces the path has", async () => {
  writeFileSync(join(root, 'space'), 'not a backup')
  writeFileSync(file, '{}')
  for (let i = 0; i < 7; i++) writeFileSync(`${file}.inyon-bak-2026-01-0${i + 1}T00-00-00`, '{}')
  expect(await writeConfig('cfg', file, '{"new":true}')).toEqual({ ok: true })
  expect(readFileSync(join(root, 'space'), 'utf8')).toBe('not a backup')
  expect(readdirSync(join(home, '.claude')).filter((f) => f.includes('inyon-bak'))).toHaveLength(5)
  expect(readFileSync(file, 'utf8')).toBe('{"new":true}')
})

test.skipIf(process.getuid?.() === 0)('a write that fails is reported, not passed off as saved', async () => {
  writeFileSync(file, '{"old":true}')
  chmodSync(join(home, '.claude'), 0o555)
  try {
    await expect(writeConfig('cfg', file, '{"new":true}')).rejects.toThrow()
  } finally {
    chmodSync(join(home, '.claude'), 0o755)
  }
  expect(readFileSync(file, 'utf8')).toBe('{"old":true}')
  expect(existsSync(`${file}.inyon-tmp`)).toBe(false)
})
