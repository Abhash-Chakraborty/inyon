import { mkdirSync, writeFileSync } from 'node:fs'
import { x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { Channel, type Wire } from './channel.ts'
import { formatShortId, parseShortCode, shortCodeIdentity, shortSecret, type ShortCode } from './code.ts'
import { identityFromSeed, isMachineId, noiseKeyOf, sign, verify, z32decode, z32encode, type Identity } from './identity.ts'
import { Initiator, Responder, type KeyPair, type Transport } from './noise.ts'
import { pairLink, parsePairLink, type PairInfo } from './pair.ts'
import { decodePublished, encodePublished, type Published } from './pkarr.ts'
import { authMessage, authMessageV2, frame, machinePath, phonePath, relayOrigin, relayWs, unframe } from './relay.ts'

/**
 * Cross-language vectors for the phone link: everything the Rust port (crates/inyon-link) has to
 * produce byte for byte so a Rust machine and a Bun phone, or the other way round, still talk.
 * Every input is fixed (seeds, ephemeral keys, seqs), so running this twice gives the same files.
 *
 *   bun packages/link/src/vectors.ts      writes fixtures/link/*.json
 *   bun test                              (vectors.test.ts) checks the TS code still matches them
 */

const enc = new TextEncoder()
const hex = bytesToHex
const text = (s: string) => hex(enc.encode(s))
/** A fixed 32-byte key from a label, so the vectors say where their keys come from. */
const fixed = (label: string) => sha256(enc.encode(`inyon-link vector: ${label}`))
const x25519Pair = (secretKey: Uint8Array): KeyPair => ({ secretKey, publicKey: x25519.getPublicKey(secretKey) })

function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`vectors: ${what}`)
}

const machine = identityFromSeed(fixed('machine seed'))
const phoneStatic = x25519Pair(fixed('phone static'))
const PROLOGUE = 'tether-link 1'

function identityVectors() {
  const seeds = [fixed('machine seed'), fixed('phone seed'), new Uint8Array(32), new Uint8Array(32).fill(0xff)]
  const messages = ['', 'tether-relay-auth:nonce', 'a longer message that spans more than one block of sha512 input, so the hashing is exercised past 128 bytes in total']
  const ids = seeds.map((seed) => {
    const id = identityFromSeed(seed)
    check(hex(noiseKeyOf(id.id)) === hex(id.noise.publicKey), 'noiseKeyOf')
    return {
      seed: hex(seed),
      public_key: hex(id.publicKey),
      id: id.id,
      x25519_secret: hex(id.noise.secretKey),
      x25519_public: hex(id.noise.publicKey),
      signatures: messages.map((m) => {
        const sig = sign(id, enc.encode(m))
        check(verify(id.id, enc.encode(m), sig), 'verify')
        return { message: text(m), signature: hex(sig) }
      }),
    }
  })
  const z32 = [new Uint8Array(0), Uint8Array.of(0), Uint8Array.of(0xff), Uint8Array.of(1, 2, 3, 4, 5), fixed('z32').subarray(0, 7), fixed('z32')].map((b) => {
    const t = z32encode(b)
    check(hex(z32decode(t)) === hex(b), 'z32 round trip')
    return { bytes: hex(b), text: t }
  })
  const good = machine.id
  // the last character's low four bits are padding: change them and it's another spelling of the same key
  const alias = good.slice(0, 51) + 'ybndrfg8ejkmcpqxot1uwisza345h769'.split('').find((ch) => ch !== good[51] && hex(z32decode(good.slice(0, 51) + ch)) === hex(machine.publicKey))!
  const machineIds = [good, good.toUpperCase(), alias, good.slice(0, 51), good + 'y', good.slice(0, 51) + 'l', '', 'not a machine id'].map((t) => ({ text: t, valid: isMachineId(t) }))
  // bad signatures: a flipped bit in the signature, in the message, and the wrong key
  const sig = sign(machine, enc.encode('hello'))
  const flipped = sig.slice()
  flipped[10]! ^= 1
  const otherId = identityFromSeed(fixed('phone seed')).id
  const verifications = [
    { id: machine.id, message: text('hello'), signature: hex(sig) },
    { id: machine.id, message: text('hellp'), signature: hex(sig) },
    { id: machine.id, message: text('hello'), signature: hex(flipped) },
    { id: otherId, message: text('hello'), signature: hex(sig) },
    { id: machine.id, message: text('hello'), signature: hex(sig.subarray(0, 63)) },
  ].map((v) => ({ ...v, valid: verify(v.id, hexToBytes(v.message), hexToBytes(v.signature)) }))
  return {
    about: 'ed25519 identities: seed -> public key, z-base-32 id, the X25519 (Noise) key pair from the same seed, and signatures',
    identities: ids,
    z32,
    machine_ids: machineIds,
    verifications,
  }
}

interface Handshake {
  name: string
  prologue: Uint8Array<ArrayBuffer>
  initiatorStatic: KeyPair
  initiatorEphemeral: KeyPair
  responderStatic: KeyPair
  responderEphemeral: KeyPair
  payload1: Uint8Array
  payload2: Uint8Array
}

function handshake(h: Handshake) {
  const i = new Initiator(h.initiatorStatic, h.responderStatic.publicKey, h.prologue, h.initiatorEphemeral)
  const r = new Responder(h.responderStatic, h.prologue, h.responderEphemeral)
  const message1 = i.writeMessage1(h.payload1)
  check(hex(r.readMessage1(message1)) === hex(h.payload1), 'message 1 payload')
  check(hex(r.remoteStatic!) === hex(h.initiatorStatic.publicKey), 'remote static')
  const { message: message2, transport: responder } = r.writeMessage2(h.payload2)
  const { payload, transport: initiator } = i.readMessage2(message2)
  check(hex(payload) === hex(h.payload2), 'message 2 payload')
  check(hex(initiator.hash) === hex(responder.hash), 'handshake hash')
  return { message1, message2, initiator, responder }
}

const json = (v: unknown) => enc.encode(JSON.stringify(v))

const linkHandshake: Handshake = {
  name: 'phone-machine',
  prologue: enc.encode(PROLOGUE),
  initiatorStatic: phoneStatic,
  initiatorEphemeral: x25519Pair(fixed('phone ephemeral')),
  responderStatic: machine.noise,
  responderEphemeral: x25519Pair(fixed('machine ephemeral')),
  payload1: json({ name: 'Pixel 9', pair: 'b'.repeat(32) }),
  payload2: json({ ok: true, version: '0.18.0', hostname: 'build-box', os: 'linux x64', platform: 'linux', mux: 'tmux', urls: ['wss://a.trycloudflare.com/link'], relays: ['https://relay.example'] }),
}

function noiseVectors() {
  const cases: Handshake[] = [
    linkHandshake,
    {
      name: 'refused',
      prologue: enc.encode(PROLOGUE),
      initiatorStatic: x25519Pair(fixed('stranger static')),
      initiatorEphemeral: x25519Pair(fixed('stranger ephemeral')),
      responderStatic: machine.noise,
      responderEphemeral: x25519Pair(fixed('machine ephemeral 2')),
      payload1: json({ name: 'Stranger' }),
      payload2: json({ ok: false, code: 'NOT_PAIRED', error: 'This phone is not paired with build-box.' }),
    },
    {
      // keys and payloads of the IK vector in cacophony (also checked in noise.test.ts), tying these to an outside source
      name: 'cacophony',
      prologue: hexToBytes('4a6f686e2047616c74'),
      initiatorStatic: x25519Pair(hexToBytes('e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1')),
      initiatorEphemeral: x25519Pair(hexToBytes('893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a')),
      responderStatic: x25519Pair(hexToBytes('4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893')),
      responderEphemeral: x25519Pair(hexToBytes('bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b')),
      payload1: hexToBytes('4c756477696720766f6e204d69736573'),
      payload2: hexToBytes('4d757272617920526f746862617264'),
    },
    {
      // the empty prologue and empty payloads: the smallest messages the pattern makes
      name: 'empty',
      prologue: new Uint8Array(0),
      initiatorStatic: x25519Pair(fixed('empty initiator static')),
      initiatorEphemeral: x25519Pair(fixed('empty initiator ephemeral')),
      responderStatic: x25519Pair(fixed('empty responder static')),
      responderEphemeral: x25519Pair(fixed('empty responder ephemeral')),
      payload1: new Uint8Array(0),
      payload2: new Uint8Array(0),
    },
  ]
  return {
    about: 'Noise_IK_25519_ChaChaPoly_SHA256 handshakes with fixed static and ephemeral keys, then transport messages (empty associated data), alternating from the initiator',
    protocol: 'Noise_IK_25519_ChaChaPoly_SHA256',
    prologue_used_by_inyon: text(PROLOGUE),
    cases: cases.map((h) => {
      const { message1, message2, initiator, responder } = handshake(h)
      const transport = ['first from the phone', 'first from the machine', '', 'x'.repeat(1000)].map((s, n) => {
        const [from, to] = n % 2 === 0 ? [initiator, responder] : [responder, initiator]
        const c = from.send.encrypt(new Uint8Array(0), enc.encode(s))
        check(hex(to.recv.decrypt(new Uint8Array(0), c)) === text(s), 'transport decrypt')
        return { from: n % 2 === 0 ? 'initiator' : 'responder', payload: text(s), ciphertext: hex(c) }
      })
      return {
        name: h.name,
        prologue: hex(h.prologue),
        initiator_static: hex(h.initiatorStatic.secretKey),
        initiator_static_public: hex(h.initiatorStatic.publicKey),
        initiator_ephemeral: hex(h.initiatorEphemeral.secretKey),
        responder_static: hex(h.responderStatic.secretKey),
        responder_static_public: hex(h.responderStatic.publicKey),
        responder_ephemeral: hex(h.responderEphemeral.secretKey),
        payload1: hex(h.payload1),
        message1: hex(message1),
        payload2: hex(h.payload2),
        message2: hex(message2),
        handshake_hash: hex(initiator.hash),
        transport,
      }
    }),
  }
}

/** A message body: short ones spelt out, long ones as prefix + fill * count + suffix. */
type Body = { text: string } | { prefix: string; fill: string; count: number; suffix: string }
const bodyBytes = (b: Body) => enc.encode('text' in b ? b.text : b.prefix + b.fill.repeat(b.count) + b.suffix)

function channelVectors() {
  const { initiator, responder } = handshake(linkHandshake)
  const make = (t: Transport, frames: Uint8Array[], got: unknown[]) => {
    const wire: Wire = { send: (d) => frames.push(d), close: () => {} }
    const ch = new Channel(wire, t)
    ch.onmessage = (m) => got.push(m)
    return { ch, wire }
  }
  const phoneFrames: Uint8Array[] = []
  const machineFrames: Uint8Array[] = []
  const phoneGot: unknown[] = []
  const machineGot: unknown[] = []
  const phone = make(initiator, phoneFrames, phoneGot)
  const mach = make(responder, machineFrames, machineGot)

  // a fill of mixed one- to four-byte characters, so chunk edges fall inside a character
  const mixed = 'abé€\u{1f642}'
  const messages: { from: 'phone' | 'machine'; body: Body }[] = [
    { from: 'phone', body: { text: '{"t":"hello","id":1}' } },
    { from: 'machine', body: { text: '{"t":"ok","id":1}' } },
    { from: 'machine', body: { prefix: '{"t":"chat.reset","text":"', fill: mixed, count: 9000, suffix: '"}' } },
    // exactly one chunk: still one frame, marked final
    { from: 'phone', body: { prefix: '"', fill: 'p', count: 60000 - 2, suffix: '"' } },
    // exactly two chunks
    { from: 'machine', body: { prefix: '"', fill: 'm', count: 120000 - 2, suffix: '"' } },
    // one byte over a chunk: the last frame carries a single byte
    { from: 'phone', body: { prefix: '"', fill: 'q', count: 60001 - 2, suffix: '"' } },
    { from: 'phone', body: { text: '{}' } },
  ]
  const out = messages.map(({ from, body }) => {
    const [sender, frames, receiverWire, got] = from === 'phone' ? [phone, phoneFrames, mach.wire, machineGot] : [mach, machineFrames, phone.wire, phoneGot]
    const bytes = bodyBytes(body)
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    const start = frames.length
    sender.ch.send(parsed)
    const sent = frames.slice(start)
    // the receiving end puts it back together
    for (const f of sent) receiverWire.onmessage!(f)
    check(JSON.stringify(got.pop()) === JSON.stringify(parsed), 'channel round trip')
    return {
      from,
      body,
      body_len: bytes.length,
      body_sha256: hex(sha256(bytes)),
      frames: sent.map((f, n) => ({
        final: n === sent.length - 1,
        len: f.length,
        sha256: hex(sha256(f)),
        ...(f.length <= 256 ? { hex: hex(f) } : {}),
      })),
    }
  })
  return {
    about:
      'The encrypted JSON channel after the phone-machine handshake in noise.json: each message is cut into 60000-byte chunks, each chunk is sent as one Noise transport message whose plaintext is a flag byte (1 on the last chunk, else 0) and the chunk. Frames are listed in send order per direction; long frames by length and sha256.',
    handshake: 'phone-machine',
    phone_is: 'initiator',
    chunk: 60000,
    max_message: 16 * 1024 * 1024,
    close_codes: { bad_message: 4400, too_large: 4413, bad_handshake: 4401, refused: 4403, handshake_timeout: 4408 },
    messages: out,
  }
}

async function codeVectors() {
  const codes: ShortCode[] = [
    { id: 'K7Q4MX2T', code: '493812' },
    { id: '00000000', code: '000000' },
    { id: 'ZZZZZZZZ', code: '999999' },
    { id: '9ABHJKMN', code: '012345' },
  ]
  const derived = await Promise.all(
    codes.map(async (c) => {
      const id = await shortCodeIdentity(c)
      return { id: c.id, code: c.code, formatted: formatShortId(c.id), secret: shortSecret(c), seed: hex(id.seed), machine_id: id.id }
    }),
  )
  const texts = [
    'K7Q4-MX2T 493812',
    'k7q4-mx2t 493 812',
    'K7Q4 MXOI 493812',
    'K7Q4MX2T493812',
    '  k7q4  mx2t : 493-812  ',
    'K7Q4-MX2T,493812',
    'ilou-ILOU 000000',
    'K7Q4-MX2T',
    'K7Q4-MX2T 49381',
    'K7Q4-MX2T 4938123',
    'K7Q4-MX2 493812',
    'K7Q!-MX2T 493812',
    'inyon://pair?m=x',
    '',
  ]
  return {
    about:
      'Short pairing codes: an 8-character Crockford base32 ID and 6 digits. scrypt(secret, "inyon-pair-id:v2", N=16384, r=8, p=1, 32 bytes) is the seed of the throwaway identity the machine publishes its record under. parse lists what parseShortCode reads from typed text (null: not a code).',
    scrypt: { salt: 'inyon-pair-id:v2', n: 16384, r: 8, p: 1, len: 32 },
    codes: derived,
    parse: texts.map((t) => ({ text: t, result: parseShortCode(t) ?? null })),
  }
}

function pairVectors() {
  const infos: { info: PairInfo; web?: string }[] = [
    { info: { id: machine.id, secret: 'b'.repeat(32), name: 'Laptop', urls: ['wss://x.trycloudflare.com/link'], relays: [] } },
    {
      info: {
        id: machine.id,
        secret: 'K7Q4MX2T:493812abc',
        name: "Abhash's box & co / 100% été",
        urls: ['wss://a.example/link?x=1&y=2', 'ws://192.168.1.4:7842/link'],
        relays: ['https://relay.example', 'https://relay2.example/base/'],
      },
    },
    { info: { id: machine.id, secret: 'c'.repeat(43), name: 'Laptop', urls: ['wss://x.trycloudflare.com/link'], relays: [] }, web: 'https://example.github.io/inyon-releases/' },
  ]
  const links = infos.map(({ info, web }) => ({ info, ...(web ? { web } : {}), link: pairLink(info, web) }))
  const good = `m=${machine.id}&s=${'s'.repeat(16)}`
  const texts = [
    ...links.map((l) => l.link),
    links[0]!.link.replace('inyon://', 'tether://'),
    `https://example.com/app?${good}&n=Web`,
    `inyon://pair?${good}&n=${'n'.repeat(80)}`,
    `inyon://pair?${good}`,
    `inyon://pair?${good}&u=javascript:alert(1)&u=wss://ok.example&u=wss://&r=http://plain.example&r=https://r.example&u=https://h.example/x`,
    `  inyon://pair?${good}&n=%20spaced+name%20  `,
    `inyon://pair?m=${machine.id}&s=${'s'.repeat(15)}`,
    `inyon://pair?m=${machine.id.toUpperCase()}&s=${'s'.repeat(16)}`,
    `http://example.com/#pair?${good}`,
    `ftp://pair?${good}`,
    'inyon://pair?m=nope&s=short',
    'hello',
    '',
  ]
  return {
    about: 'Pairing links (QR codes): pairLink output for fixed PairInfo, and what parsePairLink reads from text (null: not a pairing link). The query is application/x-www-form-urlencoded as URLSearchParams writes it.',
    links,
    parse: texts.map((t) => ({ text: t, result: parsePairLink(t) ?? null })),
  }
}

function packet(parts: (number[] | Uint8Array)[]) {
  return Uint8Array.from(parts.flatMap((p) => [...p]))
}
const label = (s: string) => [enc.encode(s).length, ...enc.encode(s)]
const u16 = (n: number) => [n >> 8, n & 255]
const strings = (...s: string[]) => s.flatMap((x) => label(x))

/** A record written by some other pkarr client: compression pointers, an A record, a TXT under another label. */
function foreignRecord(id: Identity, seq: bigint) {
  const txt = strings('n=Foreign', 'u=wss://a.example/x', 'r=https://relay.example')
  const other = strings('u=wss://ignored.example')
  const v = packet([
    [0, 0, 0x84, 0, 0, 1, 0, 3, 0, 0, 0, 0],
    // question at 12: _tether.<id> TXT IN; the id label starts at 12 + 8 = 20
    label('_tether'),
    label(id.id),
    [0],
    [0, 16, 0, 1],
    // an A record under the same name, which the reader skips
    [0xc0, 12, 0, 1, 0, 1, 0, 0, 1, 44, 0, 4, 1, 2, 3, 4],
    // the TXT record, its name a pointer back to the question
    [0xc0, 12, 0, 16, 0, 1, 0, 0, 1, 44],
    u16(txt.length),
    txt,
    // a TXT under _other.<id>: a label, then a pointer to the id label
    label('_other'),
    [0xc0, 20, 0, 16, 0, 1, 0, 0, 1, 44],
    u16(other.length),
    other,
  ])
  const head = enc.encode(`3:seqi${seq}e1:v${v.length}:`)
  const sig = sign(id, concatBytes(head, v))
  const body = new Uint8Array(72 + v.length)
  body.set(sig)
  new DataView(body.buffer).setBigUint64(64, seq)
  body.set(v, 72)
  return body
}

const decoded = (p: Published | undefined) =>
  p ? { urls: p.urls, relays: p.relays, seq: p.seq, machine: p.machine ?? null, name: p.name ?? null } : null

function pkarrVectors() {
  const seq = 1760745600123456
  const records: Omit<Published, 'seq'>[] = [
    { urls: ['wss://a.trycloudflare.com/link', 'ws://192.168.1.4:7842/link'], relays: ['https://relay.example'] },
    { urls: [], relays: [] },
    { machine: machine.id, name: 'build-box', urls: ['wss://a.example'], relays: [] },
    { name: 'n'.repeat(80), urls: ['wss://été.example/link'], relays: ['https://r1.example', 'https://r2.example'] },
  ]
  const encoded = records.map((r, n) => {
    const s = seq + n
    const body = encodePublished(machine, r, s)
    const v = body.subarray(72)
    return {
      published: r,
      seq: s,
      signable: hex(concatBytes(enc.encode(`3:seqi${s}e1:v${v.length}:`), v)),
      dns_packet: hex(v),
      body: hex(body),
      decoded: decoded(decodePublished(machine.id, body)),
    }
  })
  const body = hexToBytes(encoded[0]!.body)
  const badSig = body.slice()
  badSig[5]! ^= 1
  const badSeq = body.slice()
  badSeq[71]! ^= 1
  const foreign = foreignRecord(machine, BigInt(seq))
  const otherId = identityFromSeed(fixed('phone seed')).id
  const bodies: [string, string, Uint8Array][] = [
    ['ours', machine.id, body],
    ['written by another client', machine.id, foreign],
    ['signature changed', machine.id, badSig],
    ['seq changed', machine.id, badSeq],
    ['another machine id', otherId, body],
    ['too short', machine.id, body.subarray(0, 83)],
  ]
  return {
    about:
      'pkarr records: the machine signs bencode("3:seqi<seq>e1:v<len>:" + DNS packet) and relays take signature (64) + seq (8, big-endian) + DNS packet. The packet holds one TXT record "_tether.<machine id>" with m=, n=, u= and r= strings. decode lists what decodePublished accepts (null: refused).',
    machine_seed: hex(machine.seed),
    machine_id: machine.id,
    relays: ['https://relay.pkarr.org', 'https://dns.iroh.link/pkarr'],
    records: encoded,
    decode: bodies.map(([name, id, b]) => ({ name, id, body: hex(b), result: decoded(decodePublished(id, b)) })),
  }
}

function relayVectors() {
  const frames = [
    [0, new Uint8Array(0)],
    [1, Uint8Array.of(1, 2, 3)],
    [70000, fixed('frame').subarray(0, 20)],
    [0xffffffff, Uint8Array.of(0xff)],
  ] as const
  const nonces = ['abc123', 'b9f7c1d2e3a4f5061728394a5b6c7d8e']
  return {
    about:
      'Relay transport: on the machine socket (/m/<id>) binary frames carry a 4-byte big-endian session number then the bytes; phones open /p/<id>. The machine proves its id by signing "tether-relay-auth:<nonce>", or "tether-relay-auth:v2:<origin>:<nonce>" when the challenge has v: 2, with the origin of the address it dialed.',
    frames: frames.map(([sid, data]) => {
      const f = frame(sid, data)
      const back = unframe(f)
      check(back.sid === sid && hex(back.data) === hex(data), 'unframe')
      return { sid, data: hex(data), framed: hex(f) }
    }),
    auth: nonces.map((nonce) => ({ seed: hex(machine.seed), id: machine.id, nonce, message: hex(authMessage(nonce)), signature: hex(sign(machine, authMessage(nonce))) })),
    auth_v2: nonces.map((nonce) => {
      const origin = 'https://relay.example'
      return { seed: hex(machine.seed), origin, nonce, message: hex(authMessageV2(origin, nonce)), signature: hex(sign(machine, authMessageV2(origin, nonce))) }
    }),
    origins: [
      ['https://relay.example', 'https://relay.example'],
      ['https://Relay.Example:443/base/', 'https://relay.example'],
      ['wss://relay.example:8443/m/x', 'https://relay.example:8443'],
      ['http://127.0.0.1:80', 'http://127.0.0.1'],
      ['ws://user@relay.example:9000?x', 'http://relay.example:9000'],
      ['ftp://relay.example', null],
      ['https://', null],
    ].map(([relay, want]) => {
      const origin = relayOrigin(relay!) ?? null
      check(origin === want, `origin of ${relay}`)
      return { relay, origin }
    }),
    paths: { machine: machinePath(machine.id), phone: phonePath(machine.id) },
    ws_urls: [
      ['https://relay.example', '/m/x'],
      ['https://relay.example/', '/p/x'],
      ['http://127.0.0.1:8080//', '/m/x'],
      ['https://relay.example/base/', '/p/x'],
    ].map(([relay, path]) => ({ relay, path, url: relayWs(relay!, path!) })),
  }
}

export async function buildVectors(): Promise<Record<string, unknown>> {
  return {
    identity: identityVectors(),
    noise: noiseVectors(),
    channel: channelVectors(),
    code: await codeVectors(),
    pair: pairVectors(),
    pkarr: pkarrVectors(),
    relay: relayVectors(),
  }
}

export const FIXTURES = new URL('../../../fixtures/link/', import.meta.url)
export const serialize = (v: unknown) => JSON.stringify(v, null, 2) + '\n'

if (import.meta.main) {
  mkdirSync(FIXTURES, { recursive: true })
  for (const [name, v] of Object.entries(await buildVectors())) writeFileSync(new URL(`${name}.json`, FIXTURES), serialize(v))
  console.log(`wrote ${FIXTURES.pathname}`)
}
