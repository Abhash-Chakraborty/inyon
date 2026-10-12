import { afterAll, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { generateKeyPair, parsePairLink } from '@inyon/link'
import type { HostConfig } from '@inyon/protocol'
import { nodeBackend } from '../hosts/node-backend.ts'
import { nodeLinks } from '../hosts/node-link.ts'
import { linkConnector } from './link.ts'

// the phone's connector against the real tether-node, in a throwaway home on a LAN address
const home = mkdtempSync(path.join(os.tmpdir(), 'inyon-phone-link-'))
const port = 4890 + Math.floor(Math.random() * 100)
const env = { ...process.env, HOME: home, USERPROFILE: home }
const NODE = path.resolve(import.meta.dir, '../../../node/tether-node.ts')
const cli = (...args: string[]) => Bun.spawn([process.execPath, NODE, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
let service = cli('link', '--no-tunnel', '--lan', '--port', String(port))
afterAll(() => {
  service.kill()
  rmSync(home, { recursive: true, force: true })
})

const until = async (ok: () => boolean | Promise<boolean>, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ok()) return true
  return false
}

test('pairs from the code, runs commands, and reconnects after the laptop restarts', async () => {
  await until(() => fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false))
  const p = cli('pair')
  const info = parsePairLink((await new Response(p.stdout).text()).match(/inyon:\/\/pair\?\S+/)![0])!
  const phone = generateKeyPair()
  const saved: string[][] = []
  const links = linkConnector(async () => phone, 'Test phone', (_id, urls) => saved.push(urls))

  const welcome = await links.pair(info)
  expect(welcome.hostname).toBe(os.hostname())
  const config: HostConfig = { id: 'laptop', name: 'Laptop', kind: 'link', machineId: info.id, urls: welcome.urls, relays: [] }
  links.ensure(config)
  expect(await until(() => nodeLinks.isUp('laptop'))).toBe(true)
  const r = await nodeBackend.exec(config, 'echo hi from the laptop', {})
  expect(r).toMatchObject({ code: 0, stdout: 'hi from the laptop\n' })

  // a laptop that stops answering is noticed on every check, not just the first one
  links.resume()
  await Bun.sleep(600) // the pong for that check arrives
  service.kill('SIGSTOP')
  links.resume()
  expect(await until(() => !nodeLinks.isUp('laptop'), 6000)).toBe(true)
  service.kill('SIGCONT')
  links.resume()
  expect(await until(() => nodeLinks.isUp('laptop'), 8000)).toBe(true)

  // the laptop goes away: the machine shows as down, and comes back once the service does
  service.kill()
  await service.exited
  expect(await until(() => !nodeLinks.isUp('laptop'))).toBe(true)
  service = cli('link', '--no-tunnel', '--lan', '--port', String(port))
  await until(() => fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false))
  links.resume()
  expect(await until(() => nodeLinks.isUp('laptop'), 5000)).toBe(true)
  expect((await nodeBackend.exec(config, 'echo back', {})).stdout).toBe('back\n')

  // unpaired on the laptop: the phone is told why instead of retrying silently
  const f = cli('forget', 'Test phone')
  await f.exited
  links.forget('laptop')
  links.ensure({ ...config, id: 'laptop2' })
  expect(await until(() => /isn't paired/.test(nodeLinks.why('laptop2') ?? ''))).toBe(true)
  links.forget('laptop2')
}, 40_000)
