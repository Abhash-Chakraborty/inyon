import { afterAll, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unixPairCommand } from './pair-command.ts'

// A hub serving the real install.sh and a stand-in inyon program: a script that writes down how it
// was run. Nothing real gets installed or started.
const installSh = readFileSync(resolve(import.meta.dir, '../../../node/install.sh'))
const os = process.platform === 'darwin' ? 'darwin' : 'linux'
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
let program = '#!/bin/sh\nprintf "%s\\n" "$*" "$INYON_TOKEN" > "$HOME/ran"\n'
const ENGINE = '#!/bin/sh\necho engine\n'
/** a hub from 0.13 on lists the engine as a file of its own */
let split = false
const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const sums = () => `${sha(program)}  inyon-${os}-${arch}\n${sha('another build')}  inyon-other-x64\n${split ? `${sha(ENGINE)}  inyon-engine-${os}-${arch}\n` : ''}`
/** a list the hub serves as it is, whatever the program has become */
let fixedList: string | undefined
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (req) => {
    const u = new URL(req.url)
    const mine = u.searchParams.get('os') === os && u.searchParams.get('arch') === arch
    if (u.pathname === '/node/install.sh') return new Response(installSh)
    if (u.pathname === '/node/SHA256SUMS') return new Response(fixedList ?? sums())
    if (u.pathname === '/node/inyon' && mine) return new Response(program)
    if (u.pathname === '/node/inyon-engine' && mine && split) return new Response(ENGINE)
    return new Response('not found', { status: 404 })
  },
})
const hub = `http://127.0.0.1:${server.port}`
const root = mkdtempSync(join(tmpdir(), 'inyon-pair-'))
afterAll(() => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

async function run(cmd: string) {
  const home = mkdtempSync(join(root, 'home-'))
  const p = Bun.spawn(['sh', '-c', cmd], { env: { HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin' }, stdout: 'ignore', stderr: 'pipe' })
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
  const ran = existsSync(join(home, 'ran')) ? readFileSync(join(home, 'ran'), 'utf8') : undefined
  return { code, err, ran, bin: join(home, '.inyon', 'bin') }
}

test('the one-liner installs what the hub vouched for and has it join, with the token kept out of argv', async () => {
  const cmd = unixPairCommand(hub, 'tok_123-abc', sha(installSh), sha(sums()))
  expect(cmd.split(" sh -c '")[1]).not.toContain('tok_123-abc')
  const r = await run(cmd)
  expect(r.err).not.toContain('checksum')
  expect(r.code).toBe(0)
  expect(readFileSync(join(r.bin, 'inyon'), 'utf8')).toBe(program)
  expect(r.ran).toBe(`join ${hub}\ntok_123-abc\n`)
  expect(existsSync(join(r.bin, 'inyon.download'))).toBe(false)
})

test('a swapped install.sh, checksum list or program is refused, and nothing runs', async () => {
  const swappedInstaller = await run(unixPairCommand(hub, 'tok', sha('something else'), sha(sums())))
  expect(swappedInstaller.code).not.toBe(0)
  expect(swappedInstaller.err).toContain('install.sh did not match')
  expect(swappedInstaller.ran).toBeUndefined()

  const swappedSums = await run(unixPairCommand(hub, 'tok', sha(installSh), sha('a different list')))
  expect(swappedSums.code).not.toBe(0)
  expect(swappedSums.err).toContain("The hub's checksums did not match")
  expect(swappedSums.ran).toBeUndefined()

  // the list as vouched for, but the program swapped on the way
  fixedList = sums()
  program = '#!/bin/sh\necho "not what the hub built" > "$HOME/ran"\n'
  const swappedProgram = await run(unixPairCommand(hub, 'tok', sha(installSh), sha(fixedList)))
  expect(swappedProgram.code).not.toBe(0)
  expect(swappedProgram.err).toContain('inyon did not match its checksum')
  expect(swappedProgram.ran).toBeUndefined()
  expect(existsSync(join(swappedProgram.bin, 'inyon'))).toBe(false)
})

test('a hub from 0.13 on hands out the engine too, checked the same way, and the command joins', async () => {
  split = true
  fixedList = undefined
  program = '#!/bin/sh\nprintf "%s\\n" "$*" "$INYON_TOKEN" > "$HOME/ran"\n'
  try {
    const r = await run(unixPairCommand(hub, 'tok_456', sha(installSh), sha(sums())))
    expect(r.err).not.toContain('checksum')
    expect(r.code).toBe(0)
    expect(readFileSync(join(r.bin, 'inyon'), 'utf8')).toBe(program)
    expect(readFileSync(join(r.bin, 'inyon-engine'), 'utf8')).toBe(ENGINE)
    expect(r.ran).toBe(`join ${hub}\ntok_456\n`)
    expect(existsSync(join(r.bin, 'inyon.download'))).toBe(false)

    // an engine swapped on the way is refused before anything joins
    fixedList = sums().replace(sha(ENGINE), sha('other engine'))
    const swapped = await run(unixPairCommand(hub, 'tok', sha(installSh), sha(fixedList)))
    expect(swapped.code).not.toBe(0)
    expect(swapped.err).toContain('engine did not match its checksum')
    expect(swapped.ran).toBeUndefined()
  } finally {
    split = false
    fixedList = undefined
  }
})
