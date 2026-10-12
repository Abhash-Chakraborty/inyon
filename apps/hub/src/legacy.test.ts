import { afterAll, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { moveOldFolder } from './legacy.ts'
import { hiddenSession } from './tmux/tmux.ts'

const home = mkdtempSync(path.join(tmpdir(), 'inyon-legacy-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

test("a hub from before the rename to Inyon keeps its records, and the old folder's path still works", () => {
  mkdirSync(path.join(home, '.tether'))
  writeFileSync(path.join(home, '.tether/hosts.json'), '[]')
  moveOldFolder(home)
  expect(readFileSync(path.join(home, '.inyon/hosts.json'), 'utf8')).toBe('[]')
  expect(lstatSync(path.join(home, '.tether')).isSymbolicLink()).toBe(true)
  expect(readlinkSync(path.join(home, '.tether'))).toBe(path.join(home, '.inyon'))
  // again, or with nothing to move, it leaves things alone
  moveOldFolder(home)
  moveOldFolder(path.join(home, 'nobody'))
  expect(existsSync(path.join(home, '.inyon/hosts.json'))).toBe(true)
})

test('an Inyon folder that exists already is never replaced by the old one', () => {
  const h = mkdtempSync(path.join(tmpdir(), 'inyon-legacy-both-'))
  try {
    mkdirSync(path.join(h, '.tether'))
    mkdirSync(path.join(h, '.inyon'))
    writeFileSync(path.join(h, '.inyon/hub.json'), 'new')
    moveOldFolder(h)
    expect(readFileSync(path.join(h, '.inyon/hub.json'), 'utf8')).toBe('new')
    expect(lstatSync(path.join(h, '.tether')).isDirectory()).toBe(true)
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('TETHER_ variables still count, under their INYON_ names, and never over one that is set', () => {
  const p = Bun.spawnSync([process.execPath, '-e', `await import(${JSON.stringify(path.join(import.meta.dir, 'legacy.ts'))}); console.log(process.env.INYON_ALLOWED_HOSTS, process.env.INYON_DEBUG)`], {
    env: { PATH: process.env.PATH!, TETHER_ALLOWED_HOSTS: 'box.example', TETHER_DEBUG: 'old', INYON_DEBUG: 'new' },
  })
  expect(p.stdout.toString().trim()).toBe('box.example new')
})

test("the old name's terminal views and sign-ins stay out of the session list", () => {
  expect(hiddenSession('tether-view-ab12cd')).toBe(true)
  expect(hiddenSession('inyon-login-claude-x1')).toBe(true)
  expect(hiddenSession('tether-work')).toBe(false)
})
