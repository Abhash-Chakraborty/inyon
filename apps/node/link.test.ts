import { afterAll, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, generateKeyPair, noiseKeyOf, parsePairLink, wsWire, type Channel } from '@tether/link'

// the real CLI in a throwaway home, reached the way a phone on the same network would
const home = mkdtempSync(path.join(os.tmpdir(), 'tether-node-test-'))
const port = 4790 + Math.floor(Math.random() * 100)
const env = { ...process.env, HOME: home, USERPROFILE: home }
const cli = (...args: string[]) => Bun.spawn([process.execPath, path.join(import.meta.dir, 'tether-node.ts'), ...args], { env, stdout: 'pipe', stderr: 'pipe' })
const service = cli('link', '--no-tunnel', '--lan', '--port', String(port))
afterAll(() => {
  service.kill()
  rmSync(home, { recursive: true, force: true })
})

async function pairingLink() {
  const p = cli('pair')
  const out = await new Response(p.stdout).text()
  await p.exited
  const link = out.match(/tether:\/\/pair\?\S+/)?.[0]
  if (!link) throw new Error(`no pairing link in:\n${out}`)
  return parsePairLink(link)!
}

const open = (phone: ReturnType<typeof generateKeyPair>, id: string, hello: object) =>
  connect(wsWire(new WebSocket(`ws://127.0.0.1:${port}/link`)), { noise: phone, machineKey: noiseKeyOf(id), hello })

const exec = (channel: Channel, cmd: string) =>
  new Promise<any>((resolve) => {
    channel.onmessage = (m) => m.id === 'x' && m.type === 'exit' && resolve(m)
    channel.send({ op: 'exec', id: 'x', cmd })
  })

test('a phone pairs with the code, runs commands, and comes back without it', async () => {
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100)
  const info = await pairingLink()
  expect(info.urls).toContain(`ws://${Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)!.address}:${port}/link`)
  const phone = generateKeyPair()

  const first = await open(phone, info.id, { name: 'Test phone', pair: info.secret })
  expect(first.welcome).toMatchObject({ ok: true, hostname: os.hostname() })
  expect((await exec(first.channel, 'echo linked')).stdout).toBe('linked\n')
  first.channel.close()

  // paired now: no code needed
  const again = await open(phone, info.id, { name: 'Test phone' })
  expect((await exec(again.channel, 'echo again')).stdout).toBe('again\n')
  again.channel.close()

  const list = cli('phones')
  expect(await new Response(list.stdout).text()).toContain('Test phone')
}, 30_000)

test('a used code, a stranger and an impostor machine are all refused', async () => {
  const info = await pairingLink()
  await open(generateKeyPair(), info.id, { name: 'A', pair: info.secret })
  // one code, one phone
  await expect(open(generateKeyPair(), info.id, { name: 'B', pair: info.secret })).rejects.toMatchObject({ code: 'NOT_PAIRED' })
  await expect(open(generateKeyPair(), info.id, { name: 'C' })).rejects.toMatchObject({ code: 'NOT_PAIRED' })
  // someone else's machine id: the handshake can't complete
  const other = generateKeyPair()
  await expect(connect(wsWire(new WebSocket(`ws://127.0.0.1:${port}/link`)), { noise: generateKeyPair(), machineKey: other.publicKey, hello: {} })).rejects.toThrow()
}, 30_000)

test('forget unpairs a phone', async () => {
  const info = await pairingLink()
  const phone = generateKeyPair()
  ;(await open(phone, info.id, { name: 'Forget me', pair: info.secret })).channel.close()
  const f = cli('forget', 'Forget me')
  expect(await new Response(f.stdout).text()).toContain('Forgot Forget me')
  await expect(open(phone, info.id, { name: 'Forget me' })).rejects.toMatchObject({ code: 'NOT_PAIRED' })
}, 30_000)
