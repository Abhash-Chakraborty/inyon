import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dropAuthorizedKey, tidyMachine } from './tidy.ts'

const homes: string[] = []
afterEach(() => homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true })))

const PHONE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPhone inyon-phone'
function home(keys: string) {
  const h = mkdtempSync(join(tmpdir(), 'inyon-keys-'))
  homes.push(h)
  mkdirSync(join(h, '.ssh'), { mode: 0o700 })
  writeFileSync(join(h, '.ssh', 'authorized_keys'), keys, { mode: 0o600 })
  return h
}
const run = (h: string, sh: string) => Bun.spawnSync(['sh', '-c', sh], { env: { ...process.env, HOME: h } })
const keysOf = (h: string) => readFileSync(join(h, '.ssh', 'authorized_keys'), 'utf8')

test("removing a server takes exactly the phone's line out of authorized_keys, and keeps its permissions", () => {
  const h = home(`ssh-ed25519 AAAAmine me@laptop\n${PHONE}\nssh-rsa AAAAwork work@ci\n`)
  expect(run(h, dropAuthorizedKey(PHONE)).exitCode).toBe(0)
  expect(keysOf(h)).toBe('ssh-ed25519 AAAAmine me@laptop\nssh-rsa AAAAwork work@ci\n')
  expect(statSync(join(h, '.ssh', 'authorized_keys')).mode & 0o777).toBe(0o600)
  expect(() => statSync(join(h, '.ssh', 'authorized_keys.inyon-tmp'))).toThrow()
})

test("a file without the phone's line is left exactly as it is, and so is a line that only looks like it", () => {
  const near = `${PHONE} extra\nfrom="10.0.0.1" ${PHONE}\n`
  const h = home(near)
  run(h, dropAuthorizedKey(PHONE))
  expect(keysOf(h)).toBe(near)
})

test('the only key in the file can come out too', () => {
  const h = home(`${PHONE}\n`)
  run(h, dropAuthorizedKey(PHONE))
  expect(keysOf(h)).toBe('')
})

test('a file whose last line has no newline after it loses the line all the same', () => {
  // the phone's line last, unterminated: how `echo >>` used to leave it after another such line
  const h = home(`ssh-ed25519 AAAAmine me@laptop\n${PHONE}`)
  expect(run(h, dropAuthorizedKey(PHONE)).exitCode).toBe(0)
  expect(keysOf(h)).toBe('ssh-ed25519 AAAAmine me@laptop\n')
  // and another key's line last, unterminated, which keeps its place
  const h2 = home(`${PHONE}\nssh-rsa AAAAwork work@ci`)
  run(h2, dropAuthorizedKey(PHONE))
  expect(keysOf(h2)).toBe('ssh-rsa AAAAwork work@ci\n')
})

function fakeHost() {
  const ran: string[] = []
  let closed = 0
  const host = {
    config: { id: 'srv', kind: 'ssh' },
    exec: async (cmd: string) => {
      ran.push(cmd)
      return { code: 0, stdout: '{}', stderr: '' }
    },
    close: async () => void closed++,
  }
  return { host: host as any, ran, closed: () => closed }
}

test('a machine that answers loses its uploads and prompt log, and the connection to it is closed', async () => {
  const f = fakeHost()
  await tidyMachine(f.host, { status: 'online', integration: 'missing' }, 'echo extra;')
  const rm = f.ran.find((c) => c.includes('rm -rf'))!
  expect(rm).toContain('.inyon/uploads')
  expect(rm).toContain('.inyon/events.jsonl')
  expect(rm).toContain('echo extra;')
  expect(f.closed()).toBe(1)
})

test("a machine that is away isn't asked anything, but its connection still closes", async () => {
  const f = fakeHost()
  await tidyMachine(f.host, { status: 'error', integration: 'installed' })
  expect(f.ran).toEqual([])
  expect(f.closed()).toBe(1)
})
