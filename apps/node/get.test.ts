import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { binaryName, releaseNames } from './update.ts'

// get.sh run for real, against a local server standing in for the GitHub releases, with HOME in a
// throwaway folder. The "program" it installs is a script that records how it was started.
const sha = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const GET = path.join(import.meta.dir, 'get.sh')
const NAME = binaryName()
const PROGRAM = '#!/bin/sh\necho "started with $*" > "$HOME/started"\n'
const ENGINE_NAME = releaseNames().engine
/** `split`: a release from 0.13 on, which lists the engine as a file of its own */
let release = { gz: true, sums: '', split: false }
let requests: string[] = []
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const name = new URL(req.url).pathname.slice(1)
    requests.push(name)
    if (name === 'SHA256SUMS') {
      const engine = release.split ? `${sha('engine')}  ${ENGINE_NAME}\n${sha(zlib.gzipSync('engine'))}  ${ENGINE_NAME}.gz\n` : ''
      return new Response(release.sums || `${sha(PROGRAM)}  ${NAME}\n${release.gz ? `${sha(zlib.gzipSync(PROGRAM))}  ${NAME}.gz\n` : ''}${engine}`)
    }
    if (name === NAME) return new Response(PROGRAM)
    if (name === `${NAME}.gz` && release.gz) return new Response(zlib.gzipSync(PROGRAM))
    return new Response('not found', { status: 404 })
  },
})
afterAll(() => server.stop(true))

let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'inyon-get-'))
  release = { gz: true, sums: '', split: false }
  requests = []
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

// not spawnSync: the server answering the script runs on this same thread
async function run(env: Record<string, string> = {}, args: string[] = []) {
  const p = Bun.spawn(['/bin/sh', GET, ...args], { env: { ...process.env, HOME: home, INYON_DOWNLOAD: `http://127.0.0.1:${server.port}`, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, out: out + err }
}
const installed = () => path.join(home, '.inyon', 'bin', 'inyon')
const started = () => readFileSync(path.join(home, 'started'), 'utf8')

test('a release from 0.13 on: the command goes in, its setup gets the engine, and --hub is a setup role', async () => {
  release.split = true
  const r = await run()
  expect(r.code).toBe(0)
  expect(readFileSync(installed(), 'utf8')).toBe(PROGRAM)
  expect(started()).toBe('started with setup\n')
  // only the command is downloaded here; the engine is the command's to fetch
  expect(requests).toEqual(['SHA256SUMS', `${NAME}.gz`])
  expect(existsSync(path.join(home, '.inyon', 'bin', 'inyon-engine'))).toBe(false)

  expect((await run({}, ['--hub'])).code).toBe(0)
  expect(started()).toBe('started with setup --role hub\n')
})

test('a release from before 0.13 is one program, set up as it always was', async () => {
  expect((await run({}, ['--hub'])).code).toBe(0)
  expect(started()).toBe('started with hub install\n')
  expect((await run({}, ['--nope'])).code).toBe(2)
})

test('gets the gzipped file when the release lists one, checks it, and starts setup with the unpacked program', async () => {
  const r = await run()
  expect(r.out).toContain(`Downloading ${NAME}.gz`)
  expect(r.code).toBe(0)
  expect(readFileSync(installed(), 'utf8')).toBe(PROGRAM)
  expect(readFileSync(path.join(home, 'started'), 'utf8')).toBe('started with setup\n')
  expect(requests).toEqual(['SHA256SUMS', `${NAME}.gz`])
  expect(existsSync(`${installed()}.download.gz`)).toBe(false)
})

test('a release without a .gz (before 0.11) is downloaded plain', async () => {
  release.gz = false
  const r = await run()
  expect(r.code).toBe(0)
  expect(readFileSync(installed(), 'utf8')).toBe(PROGRAM)
  expect(requests).toEqual(['SHA256SUMS', NAME])
})

test('without gzip on the computer the plain file is taken, so nothing else is needed', async () => {
  // a PATH with every tool get.sh uses but gzip
  const bin = path.join(home, 'tools')
  mkdirSync(bin)
  for (const tool of ['uname', 'mkdir', 'curl', 'awk', 'sha256sum', 'shasum', 'cut', 'rm', 'chmod', 'mv']) {
    const found = Bun.which(tool)
    if (found) symlinkSync(found, path.join(bin, tool))
  }
  const r = await run({ PATH: bin })
  expect(r.out).toContain(`Downloading ${NAME}…`)
  expect(r.code).toBe(0)
  expect(readFileSync(installed(), 'utf8')).toBe(PROGRAM)
  expect(requests).toEqual(['SHA256SUMS', NAME])
})

test('a .gz that is not the one listed is refused before it is unpacked', async () => {
  release.sums = `${sha(PROGRAM)}  ${NAME}\n${sha('tampered')}  ${NAME}.gz\n`
  const r = await run()
  expect(r.code).toBe(1)
  expect(r.out).toContain("didn't match the release's checksum")
  expect(existsSync(installed())).toBe(false)
  expect(existsSync(`${installed()}.download.gz`)).toBe(false)
  expect(requests).toEqual(['SHA256SUMS', `${NAME}.gz`])
})

test('an unpacked file that does not match the plain checksum is refused too', async () => {
  release.sums = `${sha('tampered')}  ${NAME}\n${sha(zlib.gzipSync(PROGRAM))}  ${NAME}.gz\n`
  const r = await run()
  expect(r.code).toBe(1)
  expect(r.out).toContain("didn't match the release's checksum")
  expect(existsSync(installed())).toBe(false)
  expect(existsSync(`${installed()}.download`)).toBe(false)
})
