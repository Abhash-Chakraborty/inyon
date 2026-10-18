import { afterAll, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { VERSION } from '@inyon/protocol'
import { ENGINE } from './engine-under-test.ts'

// The real hub (apps/hub, run with Bun) and the engine under test connecting to it as a machine
// would: the hub knows the machine's token, the engine connects with it, and the hub probes it
// through the connection, listing its tmux sessions. Both use a throwaway home and a tmux server
// of their own (TMUX_TMPDIR), so nothing touches the tmux you're running.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inyon-interop-'))
const data = path.join(root, 'data')
const tmuxDir = path.join(root, 'tmux')
const token = crypto.randomBytes(32).toString('base64url')
fs.mkdirSync(data, { recursive: true, mode: 0o700 })
fs.mkdirSync(tmuxDir, { recursive: true, mode: 0o700 })
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
fs.writeFileSync(path.join(data, 'hosts.json'), JSON.stringify([{ id: 'interop', name: 'Interop', kind: 'node', tokenHash: sha256(token), pairedAt: Date.now() }]))

const home = (name: string) => {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const { TMUX: _tmux, TMUX_PANE: _pane, ...outside } = process.env
const env = (extra: Record<string, string>) => ({ ...outside, TMUX_TMPDIR: tmuxDir, ...extra })
const children: ReturnType<typeof Bun.spawn>[] = []
const skip = process.platform === 'win32' || !Bun.which('tmux')

afterAll(async () => {
  for (const c of children) c.kill()
  await Promise.all(children.map((c) => c.exited))
  // only the private server these tests started, by its socket
  if (!skip) Bun.spawnSync(['tmux', '-S', path.join(tmuxDir, `tmux-${process.getuid?.() ?? 0}`, 'default'), 'kill-server'], { env: env({}), stderr: 'ignore' })
  fs.rmSync(root, { recursive: true, force: true })
})

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })

async function until<T>(what: string, ms: number, check: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try {
      const v = await check()
      if (v !== undefined) return v
    } catch (e) {
      last = e
    }
    await Bun.sleep(200)
  }
  throw new Error(`${what} didn't happen in ${ms} ms${last ? ` (${last})` : ''}`)
}

test.skipIf(skip)('the engine connects to the Bun hub, which probes it and lists its sessions', async () => {
  const port = await freePort()
  const hubHome = home('hub-home')
  children.push(
    Bun.spawn([process.execPath, path.join(import.meta.dir, '../hub/src/index.ts')], {
      cwd: path.join(import.meta.dir, '../hub'),
      env: env({ HOME: hubHome, INYON_DATA_DIR: data, PORT: String(port), BIND: '127.0.0.1', NODE_ENV: 'test' }),
      stdout: 'ignore',
      stderr: 'ignore',
    }),
  )
  const hub = `http://127.0.0.1:${port}`
  const localToken = await until('the hub starting', 30_000, async () => {
    await fetch(`${hub}/`)
    return fs.readFileSync(path.join(data, 'local-token'), 'utf8').trim() || undefined
  })

  // a session for the hub to find, on the private server the machine reports from
  const nodeHome = home('node-home')
  expect(Bun.spawnSync(['tmux', 'new-session', '-d', '-s', 'interop', 'sleep 300'], { env: env({ HOME: nodeHome }) }).exitCode).toBe(0)
  const cli = path.join(nodeHome, 'inyon')
  fs.writeFileSync(cli, `#!/bin/sh\necho "$*" >> '${nodeHome}/cli.log'\n`, { mode: 0o755 })
  children.push(Bun.spawn([...ENGINE, 'connect'], { env: env({ HOME: nodeHome, INYON_HUB: hub, INYON_TOKEN: token, INYON_CLI: cli }), stdout: 'ignore', stderr: 'ignore' }))

  const node = await until('the machine coming online with its session', 45_000, async () => {
    const r = (await (await fetch(`${hub}/api/local/nodes?token=${localToken}`)).json()) as { nodes: Record<string, unknown>[] }
    const n = r.nodes.find((x) => x.id === 'interop')
    return n?.status === 'online' && n.sessions === 1 ? n : undefined
  })
  expect(node).toMatchObject({ id: 'interop', kind: 'node', status: 'online', hostname: os.hostname(), version: VERSION })
  // it wrote down who's running, for `inyon update`
  expect(JSON.parse(fs.readFileSync(path.join(nodeHome, '.inyon', 'node', 'node.json'), 'utf8'))).toMatchObject({ version: VERSION })
  expect(fs.existsSync(path.join(nodeHome, 'cli.log'))).toBe(false)
}, 90_000)
