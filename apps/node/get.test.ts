import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { releaseFiles } from '@inyon/protocol'

// get.sh run for real, against a local server standing in for the website's copy of the release,
// with HOME in a throwaway folder. The "program" it installs is a script that records how it was started. The
// release's SHA256SUMS is signed with the test key (apps/cli/tests/keys) when minisign is on this
// machine, as get.sh checks it then; without minisign it only says so and trusts the list.
const sha = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const GET = path.join(import.meta.dir, 'get.sh')
/** this machine as the releases name it */
const SYSTEM = `${process.platform === 'win32' ? 'windows' : process.platform}-${os.arch()}`
const NAME = releaseFiles(SYSTEM).cli
const PROGRAM = '#!/bin/sh\necho "started with $*" > "$HOME/started"\n'
const ENGINE_NAME = releaseFiles(SYSTEM).engine
const KEYS = path.resolve(import.meta.dir, '../cli/tests/keys')
const TEST_KEY = readFileSync(path.join(KEYS, 'test.pub'), 'utf8').split('\n')[1]!
const SIGNED = !!Bun.which('minisign')
/** what get.sh asks for before the program itself */
const LIST = SIGNED ? ['SHA256SUMS', 'SHA256SUMS.minisig'] : ['SHA256SUMS']
/** `split`: a release from 0.13 on, which lists the engine as a file of its own; `apk`: the
 * version whose inyon-<version>.apk the list names, as a real release's does */
let release = { gz: true, sums: '', split: false, apk: '' }
/** the signature served for the list: a good one, one made over other text, or none at all */
let signature: 'good' | 'bad' | 'none' = 'good'
let requests: string[] = []

async function sign(text: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'inyon-sign-'))
  try {
    const f = path.join(dir, 'SHA256SUMS')
    writeFileSync(f, text)
    const p = Bun.spawn(['minisign', '-S', '-s', path.join(KEYS, 'test.key'), '-m', f, '-x', `${f}.minisig`], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
    if ((await p.exited) !== 0) throw new Error(`minisign: ${await new Response(p.stderr).text()}`)
    return readFileSync(`${f}.minisig`, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const name = new URL(req.url).pathname.slice(1)
    requests.push(name)
    const sums = () => {
      const engine = release.split ? `${sha('engine')}  ${ENGINE_NAME}\n${sha(zlib.gzipSync('engine'))}  ${ENGINE_NAME}.gz\n${sha('musl')}  ${ENGINE_NAME}-musl\n` : ''
      const apk = release.apk ? `${sha('the app')}  inyon-${release.apk}.apk\n` : ''
      return release.sums || `${sha(PROGRAM)}  ${NAME}\n${release.gz ? `${sha(zlib.gzipSync(PROGRAM))}  ${NAME}.gz\n` : ''}${engine}${apk}`
    }
    if (name === 'SHA256SUMS') return new Response(sums())
    if (name === 'SHA256SUMS.minisig' && signature !== 'none') return new Response(await sign(signature === 'bad' ? `${sums()}tampered\n` : sums()))
    if (name === NAME) return new Response(PROGRAM)
    if (name === `${NAME}.gz` && release.gz) return new Response(zlib.gzipSync(PROGRAM))
    return new Response('not found', { status: 404 })
  },
})
afterAll(() => server.stop(true))

let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'inyon-get-'))
  release = { gz: true, sums: '', split: false, apk: '' }
  signature = 'good'
  requests = []
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

// not spawnSync: the server answering the script runs on this same thread
async function run(env: Record<string, string> = {}, args: string[] = []) {
  const p = Bun.spawn(['/bin/sh', GET, ...args], {
    env: { ...process.env, HOME: home, INYON_DOWNLOAD: `http://127.0.0.1:${server.port}`, INYON_SIGNING_KEY: TEST_KEY, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, out: out + err }
}
const installed = () => path.join(home, '.inyon', 'bin', 'inyon')
const started = () => readFileSync(path.join(home, 'started'), 'utf8')
/** a PATH with only these tools on it (get.sh needs uname, curl, awk, cat, grep, a sha256 and the file tools) */
function tools(names: string[]) {
  const bin = path.join(home, 'tools')
  mkdirSync(bin, { recursive: true })
  for (const tool of names) {
    const found = Bun.which(tool)
    if (found) symlinkSync(found, path.join(bin, tool))
  }
  return bin
}
const TOOLS = ['uname', 'mkdir', 'curl', 'awk', 'cat', 'grep', 'sha256sum', 'shasum', 'cut', 'rm', 'chmod', 'mv']

test('a release from 0.13 on: the command goes in, its setup gets the engine, and --hub is a setup role', async () => {
  release.split = true
  const r = await run()
  expect(r.code).toBe(0)
  expect(readFileSync(installed(), 'utf8')).toBe(PROGRAM)
  expect(started()).toBe('started with setup\n')
  // only the command is downloaded here; the engine is the command's to fetch
  expect(requests).toEqual([...LIST, `${NAME}.gz`])
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
  expect(requests).toEqual([...LIST, `${NAME}.gz`])
  expect(existsSync(`${installed()}.download.gz`)).toBe(false)
})

test('a release without a .gz (before 0.11) is downloaded plain', async () => {
  release.gz = false
  const r = await run()
  expect(r.code).toBe(0)
  expect(readFileSync(installed(), 'utf8')).toBe(PROGRAM)
  expect(requests).toEqual([...LIST, NAME])
})

test('without gzip on the computer the plain file is taken, so nothing else is needed', async () => {
  // a PATH with every tool get.sh uses but gzip (and minisign: the notice is tested below)
  const r = await run({ PATH: tools(TOOLS) })
  expect(r.out).toContain(`Downloading ${NAME}…`)
  expect(r.code).toBe(0)
  expect(readFileSync(installed(), 'utf8')).toBe(PROGRAM)
  expect(requests).toEqual(['SHA256SUMS', NAME])
})

test('without minisign the checksums are trusted as they come, and the script says so', async () => {
  const r = await run({ PATH: tools([...TOOLS, 'gzip']) })
  expect(r.code).toBe(0)
  expect(r.out).toContain("(minisign isn't installed, so the checksums weren't signature-checked)")
  expect(readFileSync(installed(), 'utf8')).toBe(PROGRAM)
  expect(requests).toEqual(['SHA256SUMS', `${NAME}.gz`])
})

test.skipIf(!SIGNED)('with minisign the list must carry a good signature, from the key downloads are pointed at', async () => {
  const refused = async (env: Record<string, string> = {}) => {
    const r = await run(env)
    expect(r.code).toBe(1)
    expect(r.out).toContain("isn't signed by Inyon's release key, so nothing was installed")
    expect(existsSync(installed())).toBe(false)
    expect(requests).toEqual(['SHA256SUMS', 'SHA256SUMS.minisig'])
    expect(existsSync(path.join(home, '.inyon', 'bin', 'SHA256SUMS.download'))).toBe(false)
    requests = []
  }
  signature = 'bad'
  await refused()
  signature = 'none'
  await refused()
  // the test key only stands in because downloads are pointed away from the website; the release
  // key is the default, and this list isn't signed with it
  signature = 'good'
  await refused({ INYON_SIGNING_KEY: '' })
  expect((await run()).code).toBe(0)
})

const SITE = 'https://inyon.abhashchakraborty.tech/download/'
const GITHUB = 'https://github.com/Abhash-Chakraborty/inyon/releases/'

/**
 * A curl in front of the real one (put first on `PATH`, or into `bin`): it notes each address on
 * the website or GitHub and fetches that file from the local server instead, so nothing leaves
 * this machine. Returns the addresses noted so far.
 */
function realAddresses(bin = tools([])) {
  const asked = path.join(home, 'asked')
  rmSync(path.join(bin, 'curl'), { force: true })
  writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/sh
n=$#
for a in "$@"; do
  case "$a" in ${SITE}* | ${GITHUB}*) echo "$a" >> "${asked}"; a="http://127.0.0.1:${server.port}/\${a##*/}" ;; esac
  set -- "$@" "$a"
done
shift $n
exec ${Bun.which('curl')} "$@"
`,
    { mode: 0o755 },
  )
  return { bin, asked: () => (existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n') : []) }
}

test('by default the release comes from the website', async () => {
  const curl = realAddresses()
  const r = await run({ PATH: `${curl.bin}:${process.env.PATH}`, INYON_DOWNLOAD: '', TETHER_DOWNLOAD: '', INYON_SIGNING_KEY: '' })
  // the test key signed this list, and the release key is the one that counts here
  if (SIGNED) {
    expect(r.code).toBe(1)
    expect(curl.asked()).toEqual([`${SITE}SHA256SUMS`, `${SITE}SHA256SUMS.minisig`])
  } else {
    expect(r.code).toBe(0)
    expect(curl.asked()).toEqual([`${SITE}SHA256SUMS`, `${SITE}${NAME}.gz`])
  }
})

test.skipIf(!SIGNED)('a signing key from the environment is ignored for the website and GitHub, named or not', async () => {
  const curl = realAddresses()
  const PATH = `${curl.bin}:${process.env.PATH}`
  // INYON_SIGNING_KEY names the test key, which signed this list, every time
  for (const INYON_DOWNLOAD of ['', SITE, SITE.slice(0, -1), `${GITHUB}latest/download`, `${GITHUB}download/v0.14.0`]) {
    const r = await run({ PATH, INYON_DOWNLOAD, TETHER_DOWNLOAD: '' })
    expect(r.code).toBe(1)
    expect(r.out).toContain("isn't signed by Inyon's release key, so nothing was installed")
    expect(existsSync(installed())).toBe(false)
  }
  // TETHER_DOWNLOAD, the name from before the rename, is no different
  expect((await run({ PATH, INYON_DOWNLOAD: '', TETHER_DOWNLOAD: SITE })).code).toBe(1)
  // somewhere else, it counts (run() points INYON_DOWNLOAD at the local server)
  expect((await run()).code).toBe(0)
})

test("without gzip, the website's release takes the plain file from GitHub, checked against the same list", async () => {
  release.apk = '0.14.0'
  const curl = realAddresses(tools(TOOLS))
  const r = await run({ PATH: curl.bin, INYON_DOWNLOAD: '', TETHER_DOWNLOAD: '' })
  expect(r.code).toBe(0)
  expect(readFileSync(installed(), 'utf8')).toBe(PROGRAM)
  expect(curl.asked()).toEqual([`${SITE}SHA256SUMS`, `${GITHUB}download/v0.14.0/${NAME}`])
  // a list without the APK doesn't say which tag: the plain file is asked of the website
  release.apk = ''
  rmSync(path.join(home, 'asked'))
  expect((await run({ PATH: curl.bin, INYON_DOWNLOAD: '', TETHER_DOWNLOAD: '' })).code).toBe(0)
  expect(curl.asked()).toEqual([`${SITE}SHA256SUMS`, `${SITE}${NAME}`])
  // the plain file from GitHub must match the list like any other
  release.apk = '0.14.0'
  release.sums = `${sha('tampered')}  ${NAME}\n${sha('the app')}  inyon-0.14.0.apk\n`
  rmSync(installed())
  const bad = await run({ PATH: curl.bin, INYON_DOWNLOAD: '', TETHER_DOWNLOAD: '' })
  expect(bad.code).toBe(1)
  expect(bad.out).toContain("didn't match the release's checksum")
  expect(existsSync(installed())).toBe(false)
})

test('on musl (Alpine) the engine is the musl build, and setup is told what it needs', async () => {
  release.split = true
  // an ldd that answers as musl's does, in front of everything else
  const bin = tools([])
  writeFileSync(path.join(bin, 'ldd'), '#!/bin/sh\necho "musl libc (aarch64)"\n', { mode: 0o755 })
  const r = await run({ PATH: `${bin}:${process.env.PATH}` })
  expect(r.code).toBe(0)
  expect(started()).toBe('started with setup\n')
  // Alpine's libstdc++ lives in /usr/lib; elsewhere the line is the hint setup repeats
  if (!existsSync('/usr/lib/libstdc++.so.6')) expect(r.out).toContain('apk add libstdc++ libgcc')
  // a release without a musl engine is taken for one from before the split
  release.sums = `${sha(PROGRAM)}  ${NAME}\n${sha('engine')}  ${ENGINE_NAME}\n`
  expect((await run({ PATH: `${bin}:${process.env.PATH}` }, ['--hub'])).code).toBe(0)
  expect(started()).toBe('started with hub install\n')
})

test('a .gz that is not the one listed is refused before it is unpacked', async () => {
  release.sums = `${sha(PROGRAM)}  ${NAME}\n${sha('tampered')}  ${NAME}.gz\n`
  const r = await run()
  expect(r.code).toBe(1)
  expect(r.out).toContain("didn't match the release's checksum")
  expect(existsSync(installed())).toBe(false)
  expect(existsSync(`${installed()}.download.gz`)).toBe(false)
  expect(requests).toEqual([...LIST, `${NAME}.gz`])
})

test('an unpacked file that does not match the plain checksum is refused too', async () => {
  release.sums = `${sha('tampered')}  ${NAME}\n${sha(zlib.gzipSync(PROGRAM))}  ${NAME}.gz\n`
  const r = await run()
  expect(r.code).toBe(1)
  expect(r.out).toContain("didn't match the release's checksum")
  expect(existsSync(installed())).toBe(false)
  expect(existsSync(`${installed()}.download`)).toBe(false)
})
