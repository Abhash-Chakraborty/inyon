import { expect, test } from 'bun:test'
import { accept, Channel, connect, LinkError, type Wire } from './channel.ts'
import { identityFromSeed, isMachineId, newIdentity, noiseKeyOf, z32decode, z32encode } from './identity.ts'
import { decodePublished, encodePublished, nextSeq, publish } from './pkarr.ts'
import { pairLink, parsePairLink } from './pair.ts'
import { frame, unframe } from './relay.ts'
import { generateKeyPair, Initiator, Responder } from './noise.ts'

/** Two connected in-memory wires, delivering on later tasks like a socket would. */
function wires(): [Wire, Wire] {
  const a: Wire = { send: (d) => setTimeout(() => b.onmessage?.(d.slice())), close: (c = 1000, r = '') => setTimeout(() => (b.onclose?.(c, r), a.onclose?.(c, r))) }
  const b: Wire = { send: (d) => setTimeout(() => a.onmessage?.(d.slice())), close: (c = 1000, r = '') => setTimeout(() => (a.onclose?.(c, r), b.onclose?.(c, r))) }
  return [a, b]
}

test('z-base-32 round trips and ids are 52 characters', () => {
  const id = newIdentity()
  expect(id.id).toHaveLength(52)
  expect(isMachineId(id.id)).toBe(true)
  expect(z32decode(z32encode(id.publicKey))).toEqual(id.publicKey)
  // the machine's Noise key follows from its id alone
  expect([...noiseKeyOf(id.id)]).toEqual([...id.noise.publicKey])
  expect(identityFromSeed(id.seed).id).toBe(id.id)
})

test('an id has one spelling: other last characters decode to the same key but are refused', () => {
  const id = newIdentity()
  const alphabet = 'ybndrfg8ejkmcpqxot1uwisza345h769'
  const alike = [...alphabet].map((ch) => id.id.slice(0, 51) + ch).filter((s) => z32decode(s).every((b, i) => b === id.publicKey[i]))
  expect(alike).toHaveLength(16)
  expect(alike.filter(isMachineId)).toEqual([id.id])
  expect(isMachineId(id.id.toUpperCase())).toBe(false)
})

test('a paired phone gets an encrypted channel; large messages arrive whole', async () => {
  const machine = newIdentity()
  const phone = generateKeyPair()
  const [pw, mw] = wires()
  const accepted = accept(mw, { noise: machine.noise, check: (_rs, hello) => ({ hostname: 'box', echo: hello.name }) })
  const { channel: pc, welcome } = await connect(pw, { noise: phone, machineKey: noiseKeyOf(machine.id), hello: { name: 'Pixel' } })
  const { channel: mc, remoteStatic } = await accepted
  expect(welcome).toMatchObject({ ok: true, hostname: 'box', echo: 'Pixel' })
  expect(remoteStatic).toEqual(phone.publicKey)
  expect(pc.binding).toEqual(mc.binding)

  const big = 'x'.repeat(300_000)
  const got: any[] = []
  mc.onmessage = (m) => got.push(m)
  pc.send({ op: 'exec', cmd: 'true' })
  pc.send({ big })
  pc.send({})
  await new Promise((r) => setTimeout(r, 50))
  expect(got).toEqual([{ op: 'exec', cmd: 'true' }, { big }, {}])

  const back: any[] = []
  pc.onmessage = (m) => back.push(m)
  mc.send({ type: 'exit', code: 0 })
  await new Promise((r) => setTimeout(r, 20))
  expect(back).toEqual([{ type: 'exit', code: 0 }])
})

test('a message that keeps coming in pieces is cut off at 16 MiB', () => {
  const machine = newIdentity()
  const init = new Initiator(generateKeyPair(), machine.noise.publicKey)
  const resp = new Responder(machine.noise)
  resp.readMessage1(init.writeMessage1(new Uint8Array(0)))
  const { message, transport: mt } = resp.writeMessage2(new Uint8Array(0))
  const { transport: pt } = init.readMessage2(message)
  const closed: [number, string][] = []
  const wire: Wire = { send() {}, close: (c = 1000, r = '') => closed.push([c, r]) }
  const mc = new Channel(wire, mt)
  mc.onmessage = () => {
    throw new Error('nothing whole was sent')
  }
  // 60000 bytes of a message that is never marked as its last piece
  const piece = new Uint8Array(60001)
  let sent = 0
  while (!closed.length && sent < 20 * 1024 * 1024) {
    wire.onmessage!(pt.send.encrypt(new Uint8Array(0), piece))
    sent += 60000
  }
  expect(closed).toEqual([[4413, 'message too large']])
  expect(sent).toBeGreaterThan(16 * 1024 * 1024)
  expect(sent).toBeLessThan(16 * 1024 * 1024 + 60000)
  expect(mc.closed).toBe(true)
})

test('empty frames count for nothing, so they can\'t raise the 16 MiB cap', () => {
  const machine = newIdentity()
  const init = new Initiator(generateKeyPair(), machine.noise.publicKey)
  const resp = new Responder(machine.noise)
  resp.readMessage1(init.writeMessage1(new Uint8Array(0)))
  const { message, transport: mt } = resp.writeMessage2(new Uint8Array(0))
  const { transport: pt } = init.readMessage2(message)
  const closed: [number, string][] = []
  const wire: Wire = { send() {}, close: (c = 1000, r = '') => closed.push([c, r]) }
  new Channel(wire, mt)
  for (let i = 0; i < 1000; i++) wire.onmessage!(pt.send.encrypt(new Uint8Array(0), new Uint8Array(0)))
  expect(closed).toEqual([])
  // then exactly one byte over the cap, never marked as the last piece
  const piece = new Uint8Array(1 + 1024 * 1024)
  for (let i = 0; i < 16; i++) wire.onmessage!(pt.send.encrypt(new Uint8Array(0), piece))
  expect(closed).toEqual([])
  wire.onmessage!(pt.send.encrypt(new Uint8Array(0), new Uint8Array(2)))
  expect(closed).toEqual([[4413, 'message too large']])
})

test('an unpaired phone is told why, encrypted', async () => {
  const machine = newIdentity()
  const [pw, mw] = wires()
  const refused = accept(mw, { noise: machine.noise, check: () => { throw new LinkError('NOT_PAIRED', 'Pair this phone first') } })
  refused.catch(() => {})
  await expect(connect(pw, { noise: generateKeyPair(), machineKey: noiseKeyOf(machine.id), hello: {} })).rejects.toMatchObject({ code: 'NOT_PAIRED', message: 'Pair this phone first' })
  await expect(refused).rejects.toThrow()
})

test('a phone talking to an impostor fails the handshake', async () => {
  const real = newIdentity()
  const impostor = newIdentity()
  const [pw, mw] = wires()
  accept(mw, { noise: impostor.noise, check: () => ({}) }).catch(() => {})
  await expect(connect(pw, { noise: generateKeyPair(), machineKey: noiseKeyOf(real.id), hello: {} })).rejects.toThrow()
})

test('published addresses verify against the machine id only', () => {
  const machine = newIdentity()
  const body = encodePublished(machine, { urls: ['wss://abc.trycloudflare.com/link', 'ws://192.168.1.20:4780/link'], relays: ['https://relay.example.com'] }, 1_700_000_000_000_000)
  expect(body.length).toBeLessThan(1072)
  expect(decodePublished(machine.id, body)).toEqual({
    urls: ['wss://abc.trycloudflare.com/link', 'ws://192.168.1.20:4780/link'],
    relays: ['https://relay.example.com'],
    seq: 1_700_000_000_000_000,
  })
  expect(decodePublished(newIdentity().id, body)).toBeUndefined()
  const tampered = body.slice()
  tampered[tampered.length - 3] ^= 1
  expect(decodePublished(machine.id, tampered)).toBeUndefined()
})

test('a new record is newer than the last one even after the clock went back', async () => {
  expect(nextSeq(undefined, 1_700_000_000_000)).toBe(1_700_000_000_000_000)
  expect(nextSeq(1_700_000_000_000_000, 1_699_999_999_000)).toBe(1_700_000_000_000_001)
  expect(nextSeq(1_600_000_000_000_000, 1_700_000_000_000)).toBe(1_700_000_000_000_000)
  // publish says which seq it used, so the caller can keep it for next time
  const machine = newIdentity()
  let body: Uint8Array | undefined
  const fetcher = (async (_url: string, init?: RequestInit) => {
    body = new Uint8Array(init!.body as ArrayBuffer)
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  const seq = await publish(machine, { urls: ['wss://a.example'], relays: [] }, ['https://relay.test'], fetcher, 4_000_000_000_000_000)
  expect(seq).toBe(4_000_000_000_000_001)
  expect(decodePublished(machine.id, body!)?.seq).toBe(seq)
})

test('pairing links round trip and reject junk', () => {
  const machine = newIdentity()
  const info = { id: machine.id, secret: 'a'.repeat(32), name: 'Laptop', urls: ['wss://x.trycloudflare.com/link'], relays: ['https://relay.example.com'] }
  expect(pairLink(info)).toStartWith('inyon://pair?')
  expect(parsePairLink(pairLink(info))).toEqual(info)
  // a code printed before the rename to Inyon still pairs
  expect(parsePairLink(pairLink(info).replace('inyon://', 'tether://'))).toEqual(info)
  expect(parsePairLink('inyon://pair?m=nope&s=short')).toBeUndefined()
  expect(parsePairLink('hello')).toBeUndefined()
  expect(parsePairLink(pairLink({ ...info, urls: ['javascript:alert(1)'] }))!.urls).toEqual([])
})

test('the web app link keeps the code after # and still pairs', () => {
  const machine = newIdentity()
  const info = { id: machine.id, secret: 'b'.repeat(32), name: 'Laptop', urls: ['wss://x.trycloudflare.com/link'], relays: [] }
  const web = pairLink(info, 'https://example.github.io/inyon-releases/')
  const url = new URL(web)
  // nothing about the code reaches the server: no query, everything in the fragment
  expect(url.search).toBe('')
  expect(url.pathname).toBe('/inyon-releases/')
  expect(url.hash).toStartWith('#pair?m=')
  expect(parsePairLink(web)).toEqual(info)
})

test('relay frames carry the session number', () => {
  const f = frame(70000, Uint8Array.of(1, 2, 3))
  expect(unframe(f)).toEqual({ sid: 70000, data: Uint8Array.of(1, 2, 3) })
})
