import { afterAll, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unixPairCommand } from './pair-command.ts'

// a hub serving the real install.sh and a stand-in tether-node.ts
const installSh = readFileSync(resolve(import.meta.dir, '../../../node/install.sh'))
let script = 'console.log("tether-node")\n'
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (req) => new Response(new URL(req.url).pathname === '/node/install.sh' ? installSh : script),
})
const hub = `http://127.0.0.1:${server.port}`
const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex')

// a machine with no systemd and a stand-in bun, so nothing real gets installed or started
const root = mkdtempSync(join(tmpdir(), 'inyon-pair-'))
const bin = join(root, 'bin')
mkdirSync(bin)
for (const [name, body] of [['bun', 'exit 0'], ['systemctl', 'exit 1'], ['launchctl', 'exit 1']]) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
}
afterAll(() => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

async function run(cmd: string) {
  const home = mkdtempSync(join(root, 'home-'))
  const p = Bun.spawn(['sh', '-c', cmd], { env: { HOME: home, PATH: `${bin}:/usr/local/bin:/usr/bin:/bin` }, stdout: 'ignore', stderr: 'pipe' })
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
  return { code, err, dir: join(home, '.tether-node') }
}

test('the one-liner installs what the hub vouched for, with the token kept out of argv', async () => {
  const cmd = unixPairCommand(hub, 'tok_123-abc', sha(installSh), sha(script))
  expect(cmd.split(" sh -c '")[1]).not.toContain('tok_123-abc')
  const r = await run(cmd)
  expect(r.err).not.toContain('checksum')
  expect(r.code).toBe(0)
  expect(readFileSync(join(r.dir, 'tether-node.ts'), 'utf8')).toBe(script)
  expect(readFileSync(join(r.dir, 'env'), 'utf8')).toBe(`TETHER_HUB=${hub}\nTETHER_TOKEN=tok_123-abc\n`)
})

test('a swapped install.sh or tether-node.ts is refused', async () => {
  const swappedInstaller = await run(unixPairCommand(hub, 'tok', sha('something else'), sha(script)))
  expect(swappedInstaller.code).not.toBe(0)
  expect(swappedInstaller.err).toContain('install.sh did not match')
  expect(existsSync(swappedInstaller.dir)).toBe(false)

  const want = sha(script)
  script = 'console.log("not what the hub built")\n'
  const swappedScript = await run(unixPairCommand(hub, 'tok', sha(installSh), want))
  expect(swappedScript.code).not.toBe(0)
  expect(swappedScript.err).toContain('tether-node.ts did not match')
  expect(existsSync(join(swappedScript.dir, 'tether-node.ts'))).toBe(false)
  expect(existsSync(join(swappedScript.dir, 'env'))).toBe(false)
})

test('the old form, with the token as an argument, still installs', async () => {
  const r = await run(`curl -fsSL ${hub}/node/install.sh | sh -s -- ${hub} tok_old`)
  expect(r.code).toBe(0)
  expect(readFileSync(join(r.dir, 'env'), 'utf8')).toContain('TETHER_TOKEN=tok_old')
})
