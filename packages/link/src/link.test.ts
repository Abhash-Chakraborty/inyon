import { expect, test } from 'bun:test'
import { accept, connect, LinkError, type Wire } from './channel.ts'
import { identityFromSeed, isMachineId, newIdentity, noiseKeyOf, z32decode, z32encode } from './identity.ts'
import { decodePublished, encodePublished } from './pkarr.ts'
import { pairLink, parsePairLink } from './pair.ts'
import { frame, unframe } from './relay.ts'
import { generateKeyPair } from './noise.ts'

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

test('relay frames carry the session number', () => {
  const f = frame(70000, Uint8Array.of(1, 2, 3))
  expect(unframe(f)).toEqual({ sid: 70000, data: Uint8Array.of(1, 2, 3) })
})
