import { sign, verify, type Identity } from './identity.ts'

/**
 * Where a machine can be reached right now, published under its own key with pkarr (signed DNS
 * records on the Mainline DHT, reached through public HTTP relays). A laptop's tunnel address
 * changes whenever the tunnel restarts; the phone looks it up by the machine id it paired with,
 * and checks the signature, so neither the relays nor the DHT can point it somewhere else.
 */

export const PKARR_RELAYS = ['https://relay.pkarr.org', 'https://dns.iroh.link/pkarr']

/** What a machine publishes: its current addresses, best first. */
export interface Published {
  /** wss:// or ws:// URLs that reach the machine's link listener (tunnel, LAN) */
  urls: string[]
  /** relays it keeps a connection to */
  relays: string[]
  /** microseconds since the epoch; newer wins */
  seq: number
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** The bytes pkarr signs (BEP 44's bencoded seq and value). */
const signable = (seq: bigint, v: Uint8Array) => {
  const head = enc.encode(`3:seqi${seq}e1:v${v.length}:`)
  const out = new Uint8Array(head.length + v.length)
  out.set(head)
  out.set(v, head.length)
  return out
}

function name(labels: string[]) {
  const parts = labels.flatMap((l) => {
    const b = enc.encode(l)
    if (b.length > 63) throw new Error('DNS label too long')
    return [b.length, ...b]
  })
  return [...parts, 0]
}

/** One TXT record "_tether.<id>" holding "u=<url>" and "r=<relay>" strings. */
function dnsPacket(id: string, p: Omit<Published, 'seq'>): Uint8Array {
  const strings = [...p.urls.map((u) => `u=${u}`), ...p.relays.map((r) => `r=${r}`)].map((s) => {
    const b = enc.encode(s)
    if (b.length > 255) throw new Error('Address too long to publish')
    return [b.length, ...b]
  })
  const rdata = strings.flat()
  const bytes = [
    // id 0, flags: response + authoritative, 0 questions, 1 answer
    0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0,
    ...name(['_tether', id]),
    0, 16, // TXT
    0, 1, // IN
    0, 0, 1, 44, // TTL 300
    rdata.length >> 8, rdata.length & 255,
    ...rdata,
  ]
  if (bytes.length >= 1000) throw new Error('Too many addresses to publish')
  return Uint8Array.from(bytes)
}

/** Reads the TXT strings of every "_tether..." answer in a DNS packet. */
function readPacket(v: Uint8Array): string[] {
  const view = new DataView(v.buffer, v.byteOffset, v.byteLength)
  const readName = (at: number): [string[], number] => {
    const labels: string[] = []
    let end = -1
    for (let hops = 0; hops < 32; hops++) {
      const len = v[at]!
      if (len === 0) return [labels, end < 0 ? at + 1 : end]
      if ((len & 0xc0) === 0xc0) {
        // a compression pointer
        if (end < 0) end = at + 2
        at = view.getUint16(at) & 0x3fff
        continue
      }
      labels.push(dec.decode(v.subarray(at + 1, at + 1 + len)))
      at += 1 + len
    }
    throw new Error('Bad DNS name')
  }
  const questions = view.getUint16(4)
  const answers = view.getUint16(6)
  let at = 12
  for (let i = 0; i < questions; i++) at = readName(at)[1] + 4
  const out: string[] = []
  for (let i = 0; i < answers; i++) {
    const [labels, next] = readName(at)
    const type = view.getUint16(next)
    const len = view.getUint16(next + 8)
    const rdata = v.subarray(next + 10, next + 10 + len)
    at = next + 10 + len
    if (type !== 16 || labels[0] !== '_tether') continue
    for (let j = 0; j < rdata.length; j += 1 + rdata[j]!) out.push(dec.decode(rdata.subarray(j + 1, j + 1 + rdata[j]!)))
  }
  return out
}

/** The body a pkarr relay takes: signature, seq (big-endian), DNS packet. */
export function encodePublished(identity: Identity, p: Omit<Published, 'seq'>, seq = Date.now() * 1000): Uint8Array {
  const v = dnsPacket(identity.id, p)
  const s = BigInt(seq)
  const sig = sign(identity, signable(s, v))
  const body = new Uint8Array(64 + 8 + v.length)
  body.set(sig)
  new DataView(body.buffer).setBigUint64(64, s)
  body.set(v, 72)
  return body
}

/** Checks a relay's answer against the machine id; undefined if it isn't signed by that machine. */
export function decodePublished(id: string, body: Uint8Array): Published | undefined {
  if (body.length < 72 + 12) return
  const sig = body.subarray(0, 64)
  const seq = new DataView(body.buffer, body.byteOffset).getBigUint64(64)
  const v = body.subarray(72)
  if (!verify(id, signable(seq, v), sig)) return
  try {
    const strings = readPacket(v)
    return {
      urls: strings.filter((s) => s.startsWith('u=')).map((s) => s.slice(2)),
      relays: strings.filter((s) => s.startsWith('r=')).map((s) => s.slice(2)),
      seq: Number(seq),
    }
  } catch {
    return
  }
}

/** Publishes to every relay; resolves once one of them took it. */
export async function publish(identity: Identity, p: Omit<Published, 'seq'>, relays = PKARR_RELAYS, fetcher: typeof fetch = fetch) {
  const body = encodePublished(identity, p)
  const results = await Promise.allSettled(
    relays.map(async (r) => {
      const res = await fetcher(`${r}/${identity.id}`, { method: 'PUT', body: body as Uint8Array<ArrayBuffer>, signal: AbortSignal.timeout(40000) })
      if (!res.ok) throw new Error(`${r}: ${res.status}`)
    }),
  )
  if (!results.some((r) => r.status === 'fulfilled')) {
    throw new Error(`Couldn't publish the address: ${results.map((r) => (r as PromiseRejectedResult).reason?.message).join('; ')}`)
  }
}

/** The newest correctly signed record any relay has. */
export async function resolve(id: string, relays = PKARR_RELAYS, fetcher: typeof fetch = fetch): Promise<Published | undefined> {
  const found = await Promise.allSettled(
    relays.map(async (r) => {
      const res = await fetcher(`${r}/${id}`, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) return undefined
      return decodePublished(id, new Uint8Array(await res.arrayBuffer()))
    }),
  )
  return found
    .flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
    .sort((a, b) => b.seq - a.seq)[0]
}
