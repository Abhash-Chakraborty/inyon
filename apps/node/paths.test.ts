import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { nodeDir, savedEnv, savedHub } from './paths.ts'

// A machine set up as tether-node, before the rename to Inyon, in a throwaway home.
let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'inyon-paths-'))
  spyOn(os, 'homedir').mockReturnValue(home)
})
afterEach(() => {
  mock.restore()
  rmSync(home, { recursive: true, force: true })
})

test("tether-node's folder moves to ~/.inyon/node once, with a link left at the old path", () => {
  const old = path.join(home, '.tether-node')
  mkdirSync(path.join(old, 'bin'), { recursive: true })
  writeFileSync(path.join(old, 'phones.json'), '{"k":1}')
  expect(nodeDir()).toBe(path.join(home, '.inyon', 'node'))
  expect(readFileSync(path.join(home, '.inyon', 'node', 'phones.json'), 'utf8')).toBe('{"k":1}')
  expect(lstatSync(old).isSymbolicLink()).toBe(true)
  // what still points at the old path (a service, the hub's status read) finds the same files
  expect(readFileSync(path.join(old, 'phones.json'), 'utf8')).toBe('{"k":1}')
  expect(nodeDir()).toBe(path.join(home, '.inyon', 'node'))
})

test('a new machine gets ~/.inyon/node, and nothing is made until something is written', () => {
  expect(nodeDir()).toBe(path.join(home, '.inyon', 'node'))
  expect(existsSync(path.join(home, '.inyon'))).toBe(false)
  expect(existsSync(path.join(home, '.tether-node'))).toBe(false)
})

test("the hub connection's saved settings are read under either name", () => {
  const dir = path.join(home, '.tether-node')
  mkdirSync(dir, { recursive: true })
  // install.ps1 before the rename wrote .env; install.sh wrote env
  writeFileSync(path.join(dir, '.env'), 'TETHER_HUB=http://hub.lan:4777/\r\nTETHER_TOKEN=old\r\nTETHER_SH=C:\\bb.exe\r\n')
  expect(savedEnv()).toEqual({ INYON_HUB: 'http://hub.lan:4777/', INYON_TOKEN: 'old', INYON_SH: 'C:\\bb.exe' })
  expect(savedHub({})).toBe('http://hub.lan:4777')
  // a new name wins over the old one
  writeFileSync(path.join(nodeDir(), 'env'), 'INYON_TOKEN=new\n')
  expect(savedEnv().INYON_TOKEN).toBe('new')
  expect(savedHub({ INYON_HUB: 'https://elsewhere/' })).toBe('https://elsewhere')
})
