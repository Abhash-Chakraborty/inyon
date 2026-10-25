import { afterAll, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import type { ServerWebSocket } from 'bun'
import { authMessageV2, connect, frame, generateKeyPair, noiseKeyOf, parsePairLink, unframe, verify, type Channel, type MachineToRelay, type Wire } from '@inyon/link'
import { ENGINE } from './engine-under-test.ts'

// The engine's link reached only through a relay: a stand-in relay here, speaking the relay's side
// of packages/link/src/relay.ts, and a phone (the real @inyon/link) whose session it carries.
const home = mkdtempSync(path.join(os.tmpdir(), 'inyon-relay-'))
// TMUX empty: in tmux, `pair` leaves the link out
const env = { ...process.env, HOME: home, USERPROFILE: home, TMUX: '' }
const nonce = 'b9f7c1d2e3a4f5061728394a5b6c7d8e'

let machine: ServerWebSocket<{ id: string }> | undefined
const auths: { id: string; ok: boolean; path: string }[] = []
const closed: number[] = []
const phones = new Map<number, Wire>()
let ready: () => void
const isReady = new Promise<void>((r) => (ready = r))

const relay = Bun.serve<{ id: string }>({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    const id = new URL(req.url).pathname.match(/^\/m\/(\w+)$/)?.[1]
    if (id && srv.upgrade(req, { data: { id } })) return
    return new Response('not found', { status: 404 })
  },
  websocket: {
    open(ws) {
      machine = ws
      // v2: the answer is bound to this relay, so it can't be used to log in at another one
      ws.send(JSON.stringify({ t: 'challenge', nonce, v: 2 }))
    },
    message(ws, raw) {
      if (typeof raw !== 'string') {
        const { sid, data } = unframe(new Uint8Array(raw))
        phones.get(sid)?.onmessage?.(data.slice())
        return
      }
      const m = JSON.parse(raw) as MachineToRelay
      if (m.t === 'auth') {
        const ok = m.id === ws.data.id && verify(m.id, authMessageV2(`http://127.0.0.1:${relay.port}`, nonce), Buffer.from(m.sig, 'base64'))
        auths.push({ id: m.id, ok, path: ws.data.id })
        if (ok) {
          ws.send(JSON.stringify({ t: 'ready' }))
          ready()
        }
      } else if (m.t === 'close') {
        closed.push(m.sid)
        phones.get(m.sid)?.onclose?.(1000, 'machine closed')
        phones.delete(m.sid)
      }
    },
  },
})
const cli = (...args: string[]) => Bun.spawn([...ENGINE, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
const port = 4900 + Math.floor(Math.random() * 90)
const service = cli('link', '--no-tunnel', '--no-vpn', '--port', String(port), '--relay', `http://127.0.0.1:${relay.port}`)
afterAll(async () => {
  service.kill()
  await service.exited
  relay.stop(true)
  rmSync(home, { recursive: true, force: true })
})

/** A phone's session through the relay: what the relay would carry between /p/<id> and the machine. */
let nextSid = 6
function viaRelay(): Wire & { sid: number } {
  const sid = nextSid++
  const wire: Wire & { sid: number } = {
    sid,
    send: (d) => machine!.send(frame(sid, d)),
    close: () => {
      phones.delete(sid)
      machine?.send(JSON.stringify({ t: 'close', sid }))
    },
  }
  phones.set(sid, wire)
  machine!.send(JSON.stringify({ t: 'open', sid }))
  return wire
}

const exec = (channel: Channel, cmd: string) =>
  new Promise<any>((resolve) => {
    channel.onmessage = (m) => m.id === 'x' && m.type === 'exit' && resolve(m)
    channel.send({ op: 'exec', id: 'x', cmd })
  })

test('the link proves its id to the relay, and a phone pairs and runs commands through it', async () => {
  await Promise.race([isReady, Bun.sleep(15_000).then(() => Promise.reject(new Error(`the link never authenticated: ${JSON.stringify(auths)}`)))])
  expect(auths).toEqual([{ id: auths[0].id, ok: true, path: auths[0].id }])

  const p = cli('pair')
  const out = await new Response(p.stdout).text()
  await p.exited
  const info = parsePairLink(out.match(/inyon:\/\/pair\?\S+/)![0])!
  expect(info.id).toBe(auths[0].id)

  const phone = generateKeyPair()
  const first = await connect(viaRelay(), { noise: phone, machineKey: noiseKeyOf(info.id), hello: { name: 'Relay phone', pair: info.secret } })
  expect(first.welcome).toMatchObject({ ok: true, hostname: os.hostname() })
  expect((await exec(first.channel, 'echo relayed')).stdout).toBe('relayed\n')
  // a reply bigger than one Noise message comes in pieces and is put back together
  const big = await exec(first.channel, 'head -c 150000 /dev/zero | tr "\\0" a')
  expect(big.stdout.length).toBe(150000)
  first.channel.close()

  // paired now: no code needed
  const again = await connect(viaRelay(), { noise: phone, machineKey: noiseKeyOf(info.id), hello: { name: 'Relay phone' } })
  expect((await exec(again.channel, 'echo again')).stdout).toBe('again\n')
  again.channel.close()
}, 40_000)

test('a stranger is refused, and the link tells the relay to drop that session', async () => {
  await isReady
  const p = cli('pair', '--json')
  const { link } = JSON.parse(await new Response(p.stdout).text())
  const info = parsePairLink(link)!
  const wire = viaRelay()
  await expect(connect(wire, { noise: generateKeyPair(), machineKey: noiseKeyOf(info.id), hello: { name: 'Stranger' } })).rejects.toMatchObject({ code: 'NOT_PAIRED' })
  for (let i = 0; i < 30 && !closed.includes(wire.sid); i++) await Bun.sleep(100)
  expect(closed).toContain(wire.sid)
}, 30_000)
