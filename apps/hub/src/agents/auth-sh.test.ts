import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signedInTest } from './auth-sh.ts'

const home = mkdtempSync(join(tmpdir(), 'inyon-qwen-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const signedIn = () => Bun.spawnSync(['sh', '-c', signedInTest('qwen')], { env: { HOME: home, PATH: '/usr/bin:/bin' } }).exitCode === 0

test('Qwen Code counts as signed in once /auth picked a method, not when it only saved preferences', () => {
  expect(signedIn()).toBe(false)
  mkdirSync(join(home, '.qwen'))
  writeFileSync(join(home, '.qwen/settings.json'), '{ "ui": { "theme": "Default" } }')
  expect(signedIn()).toBe(false)
  writeFileSync(join(home, '.qwen/settings.json'), '{ "security": { "auth": { "selectedType": "openai" } } }')
  expect(signedIn()).toBe(true)
})
