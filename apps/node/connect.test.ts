import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// `inyon connect` against a stand-in hub; a stand-in `inyon` command records what it was asked
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inyon-connect-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

async function run(fetch: (req: Request, srv: any) => Response | undefined, ms: number) {
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch, websocket: { open: (ws) => void ws.close(4001, 'removed from Inyon'), message() {} } })
  const home = fs.mkdtempSync(path.join(dir, 'home-'))
  const cli = path.join(home, 'inyon')
  fs.writeFileSync(cli, `#!/bin/sh\necho "$*" >> '${home}/cli.log'\n`, { mode: 0o755 })
  const p = Bun.spawn([process.execPath, path.join(import.meta.dir, 'inyon.ts'), 'connect'], {
    env: { ...process.env, HOME: home, INYON_HUB: `http://127.0.0.1:${srv.port}`, INYON_TOKEN: 'tok', INYON_CLI: cli },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await Promise.race([p.exited, Bun.sleep(ms).then(() => 'still running')])
  p.kill()
  srv.stop(true)
  const log = path.join(home, 'cli.log')
  return { code, cli: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '' }
}

const shellFakes = process.platform === 'win32'

test.skipIf(shellFakes)('a machine the hub removes takes its own service down and stops', async () => {
  const r = await run((req, srv) => (srv.upgrade(req) ? undefined : new Response('Upgrade failed', { status: 400 })), 10_000)
  expect(r).toEqual({ code: 0, cli: 'disconnect' })
}, 15_000)

test.skipIf(shellFakes)('a machine removed while it was off learns it when it calls again', async () => {
  const r = await run(() => new Response('This machine was removed from the hub', { status: 410 }), 10_000)
  expect(r).toEqual({ code: 0, cli: 'disconnect' })
}, 15_000)

test.skipIf(shellFakes)('a token the hub doesn\'t know (a hub that lost its data) keeps it trying', async () => {
  const r = await run(() => new Response('Unknown token', { status: 403 }), 4_000)
  expect(r).toEqual({ code: 'still running', cli: '' })
}, 10_000)
