import { afterAll, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { generateKeyPair, parsePairLink } from '@inyon/link'
import type { HostConfig } from '@inyon/protocol'
import { nodeBackend } from '../hosts/node-backend.ts'
import { nodeLinks } from '../hosts/node-link.ts'
import { linkConnector, usable } from './link.ts'

// the phone's connector against the real inyon, in a throwaway home on a LAN address
const home = mkdtempSync(path.join(os.tmpdir(), 'inyon-phone-link-'))
const port = 4890 + Math.floor(Math.random() * 100)
const env = { ...process.env, HOME: home, USERPROFILE: home }
const NODE = path.resolve(import.meta.dir, '../../../node/inyon.ts')
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
  expect(nodeLinks.why('laptop2')).toBeUndefined()

  // removed while it was still connecting: the failure that comes back afterwards isn't kept,
  // so a computer added again under that id doesn't open with the old one's error
  links.ensure({ ...config, id: 'laptop3', name: 'Old name' })
  links.forget('laptop3')
  await Bun.sleep(1500)
  expect(nodeLinks.why('laptop3')).toBeUndefined()
}, 40_000)

test('a browser page on https skips plain ws:// addresses; the Android app and the hub keep them', () => {
  const urls = ['wss://abc.trycloudflare.com/link', 'ws://100.71.4.20:4780/link', 'ws://192.168.1.20:4780/link']
  expect(usable(urls, { protocol: 'https:' })).toEqual(['wss://abc.trycloudflare.com/link'])
  expect(usable(urls, { protocol: 'https:', native: true })).toEqual(urls)
  expect(usable(urls, { protocol: 'http:' })).toEqual(urls)
  expect(usable(urls, {})).toEqual(urls)
})

/** Something else at an address the computer once had: it answers every handshake with junk. */
function impostor() {
  let opened = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      if (srv.upgrade(req)) return
      return new Response('inyon\n')
    },
    websocket: {
      open() {
        opened++
      },
      message(ws) {
        ws.send(crypto.getRandomValues(new Uint8Array(48)))
      },
    },
  })
  return { url: `ws://127.0.0.1:${server.port}/link`, opened: () => opened, stop: () => server.stop(true) }
}

test('an address that something else answers is passed over for the ones the computer publishes', async () => {
  await until(() => fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false))
  const p = cli('pair')
  const info = parsePairLink((await new Response(p.stdout).text()).match(/inyon:\/\/pair\?\S+/)![0])!
  const phone = generateKeyPair()
  const real = `ws://127.0.0.1:${port}/link`
  const fake = impostor()
  try {
    // pairing too: the code goes to the computer, not to what answered first
    const links = linkConnector(async () => phone, 'Impostor test', () => {}, { resolve: async () => ({ urls: [real], relays: [] }) })
    await links.pair({ ...info, urls: [fake.url] })
    const config: HostConfig = { id: 'cafe', name: 'Laptop', kind: 'link', machineId: info.id, urls: [fake.url], relays: [] }
    links.ensure(config)
    expect(await until(() => nodeLinks.isUp('cafe'))).toBe(true)
    expect(fake.opened()).toBeGreaterThan(0)
    links.forget('cafe')
  } finally {
    fake.stop()
  }
}, 30_000)

test('with only something else answering, the phone keeps trying and never calls it the wrong computer', async () => {
  const fake = impostor()
  const phone = generateKeyPair()
  try {
    const links = linkConnector(async () => phone, 'Impostor test', () => {}, { resolve: async () => undefined })
    const id = (await import('@inyon/link')).newIdentity().id
    links.ensure({ id: 'cafe2', name: 'Laptop', kind: 'link', machineId: id, urls: [fake.url], relays: [] })
    // first try at once, the next within the first backoff step (up to a second)
    expect(await until(() => fake.opened() >= 2, 5000)).toBe(true)
    const why = nodeLinks.why('cafe2') ?? ''
    expect(why).not.toContain("didn't prove")
    expect(why).toContain('something else answered at 127.0.0.1')
    links.forget('cafe2')
  } finally {
    fake.stop()
  }
}, 30_000)

test('of a batch, only the address something else answered at is named, not one that timed out', async () => {
  const fake = impostor()
  // takes the connection and never says a word
  const silent = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('')), websocket: { message() {} } })
  const phone = generateKeyPair()
  try {
    const links = linkConnector(async () => phone, 'Impostor test', () => {}, { resolve: async () => undefined })
    const id = (await import('@inyon/link')).newIdentity().id
    links.ensure({ id: 'cafe3', name: 'Laptop', kind: 'link', machineId: id, urls: [fake.url, `ws://127.0.0.1:${silent.port}/link`], relays: [] })
    expect(await until(() => (nodeLinks.why('cafe3') ?? '').includes('something else answered'), 20_000)).toBe(true)
    const why = nodeLinks.why('cafe3') ?? ''
    expect(why).toContain(`something else answered at ${new URL(fake.url).host})`)
    expect(why).not.toContain(String(silent.port))
    links.forget('cafe3')
  } finally {
    fake.stop()
    silent.stop(true)
  }
}, 30_000)
