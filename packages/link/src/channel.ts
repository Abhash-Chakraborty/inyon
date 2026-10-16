import { Initiator, Responder, type KeyPair, type Transport } from './noise.ts'

/**
 * An encrypted JSON channel between the phone and a machine, over anything that carries whole
 * binary messages in order: a WebSocket straight to the machine, through a tunnel, or through a
 * relay. The relay and the tunnel see only ciphertext.
 */

/** A message transport: one `send` arrives as one `onmessage`, in order. */
export interface Wire {
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  onmessage?: (data: Uint8Array) => void
  onclose?: (code: number, reason: string) => void
}

// A wire id from when Inyon was called Tether. Both ends must agree on it, so it stays: changing it
// would cut every paired phone off from every machine until both had updated.
const PROLOGUE = new TextEncoder().encode('tether-link 1')
const HANDSHAKE_MS = 15000
// Noise caps a message at 65535 bytes; larger JSON goes in pieces
const CHUNK = 60000
// the most a peer can make this end hold while a message is still arriving in pieces
const MAX_MESSAGE = 16 * 1024 * 1024
const NONE = new Uint8Array(0)
const enc = new TextEncoder()
const dec = new TextDecoder()

export class LinkError extends Error {
  constructor(public code: 'NOT_PAIRED' | 'BAD_KEY' | 'TIMEOUT' | 'CLOSED' | 'REFUSED', message: string) {
    super(message)
  }
}

export class Channel {
  onmessage?: (msg: any) => void
  onclose?: (code: number, reason: string) => void
  private parts: Uint8Array[] = []
  private buffered = 0
  closed = false

  constructor(private wire: Wire, private t: Transport) {
    wire.onmessage = (data) => {
      if (this.closed) return
      let plain: Uint8Array
      try {
        plain = t.recv.decrypt(NONE, data)
      } catch {
        // a forged or out-of-order message: the session can't be trusted any more
        return this.close(4400, 'bad message')
      }
      this.parts.push(plain.subarray(1))
      this.buffered += plain.length - 1
      if (this.buffered > MAX_MESSAGE) {
        this.parts = []
        return this.close(4413, 'message too large')
      }
      if (plain[0] !== 1) return
      const whole = this.parts.length === 1 ? this.parts[0]! : join(this.parts)
      this.parts = []
      this.buffered = 0
      let msg: unknown
      try {
        msg = JSON.parse(dec.decode(whole))
      } catch {
        return
      }
      this.onmessage?.(msg)
    }
    wire.onclose = (code, reason) => {
      if (this.closed) return
      this.closed = true
      this.onclose?.(code, reason)
    }
  }

  /** The handshake hash, the same on both ends. */
  get binding() {
    return this.t.hash
  }

  send(msg: unknown) {
    if (this.closed) return
    const body = enc.encode(JSON.stringify(msg))
    for (let at = 0; at < body.length || at === 0; at += CHUNK) {
      const piece = body.subarray(at, at + CHUNK)
      const plain = new Uint8Array(piece.length + 1)
      plain[0] = at + CHUNK >= body.length ? 1 : 0
      plain.set(piece, 1)
      this.wire.send(this.t.send.encrypt(NONE, plain))
      if (body.length === 0) break
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    this.closed = true
    this.wire.close(code, reason)
    this.onclose?.(code, reason)
  }
}

function join(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const first = (wire: Wire) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => {
      wire.close(4408, 'handshake timeout')
      reject(new LinkError('TIMEOUT', "The machine didn't answer in time"))
    }, HANDSHAKE_MS)
    wire.onmessage = (d) => {
      clearTimeout(timer)
      resolve(d)
    }
    wire.onclose = (code, reason) => {
      clearTimeout(timer)
      reject(new LinkError('CLOSED', reason || `Connection closed (${code})`))
    }
  })

/**
 * The phone's side. `machineKey` is the machine's Noise key from pairing; `hello` goes to the
 * machine encrypted (a pairing secret, the phone's name). Resolves with the machine's welcome.
 */
export async function connect(wire: Wire, o: { noise: KeyPair; machineKey: Uint8Array; hello: unknown }) {
  const hs = new Initiator(o.noise, o.machineKey, PROLOGUE)
  const reply = first(wire)
  wire.send(hs.writeMessage1(enc.encode(JSON.stringify(o.hello))))
  let payload: Uint8Array
  let transport: Transport
  try {
    ;({ payload, transport } = hs.readMessage2(await reply))
  } catch (err) {
    if (err instanceof LinkError) throw err
    wire.close(4401, 'bad handshake')
    throw new LinkError('BAD_KEY', "The machine didn't prove it's the one you paired with")
  }
  const welcome = JSON.parse(dec.decode(payload)) as { ok?: boolean; error?: string; code?: string } & Record<string, unknown>
  if (!welcome.ok) {
    wire.close(4403, 'refused')
    throw new LinkError(welcome.code === 'NOT_PAIRED' ? 'NOT_PAIRED' : 'REFUSED', welcome.error ?? 'The machine refused the connection')
  }
  return { channel: new Channel(wire, transport), welcome }
}

/**
 * The machine's side. `check` sees who is calling (their static key) and what they sent, and
 * returns the welcome, or throws a LinkError to refuse them (they're told why, encrypted).
 */
export async function accept(wire: Wire, o: { noise: KeyPair; check: (remoteStatic: Uint8Array, hello: any) => Promise<Record<string, unknown>> | Record<string, unknown> }) {
  const hs = new Responder(o.noise, PROLOGUE)
  let hello: any
  try {
    hello = JSON.parse(dec.decode(hs.readMessage1(await first(wire))))
  } catch (err) {
    wire.close(4401, 'bad handshake')
    throw err
  }
  const remoteStatic = hs.remoteStatic!
  let welcome: Record<string, unknown>
  try {
    welcome = { ok: true, ...(await o.check(remoteStatic, hello)) }
  } catch (err) {
    const e = err as LinkError
    const { message } = hs.writeMessage2(enc.encode(JSON.stringify({ ok: false, code: e.code ?? 'REFUSED', error: e.message })))
    wire.send(message)
    setTimeout(() => wire.close(4403, 'refused'), 200)
    throw err
  }
  const { message, transport } = hs.writeMessage2(enc.encode(JSON.stringify(welcome)))
  const channel = new Channel(wire, transport)
  wire.send(message)
  return { channel, remoteStatic, hello }
}

/** A Wire over a WebSocket (browser, Bun or React Native shapes). */
export function wsWire(ws: WebSocket): Wire {
  ws.binaryType = 'arraybuffer'
  // the handshake starts before the socket has opened: hold what's sent until it does
  let early: Uint8Array[] | undefined = ws.readyState === 0 ? [] : undefined
  ws.onopen = () => {
    for (const d of early ?? []) ws.send(d as Uint8Array<ArrayBuffer>)
    early = undefined
  }
  const wire: Wire = {
    send: (d) => (early ? early.push(d) : ws.readyState === 1 && ws.send(d as Uint8Array<ArrayBuffer>)),
    close: (code, reason) => {
      try {
        ws.close(code, reason)
      } catch {
        ws.close()
      }
    },
  }
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') wire.onmessage?.(new Uint8Array(e.data as ArrayBuffer))
  }
  ws.onclose = (e) => wire.onclose?.(e.code, e.reason)
  return wire
}
