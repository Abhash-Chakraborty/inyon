/**
 * How sessions travel through a relay. A machine keeps one WebSocket to the relay at
 * /m/<id>; each phone opens its own at /p/<id>. On the machine's socket, binary frames carry a
 * 4-byte session number before the bytes, and text frames are control messages. The relay
 * never sees anything but Noise ciphertext.
 */

export type RelayToMachine =
  | { t: 'challenge'; nonce: string }
  | { t: 'ready' }
  | { t: 'open'; sid: number }
  | { t: 'close'; sid: number }

export type MachineToRelay = { t: 'auth'; id: string; sig: string } | { t: 'close'; sid: number }

/** What the machine signs to prove to the relay it owns its id (a wire id from before the rename to Inyon). */
export const authMessage = (nonce: string) => new TextEncoder().encode(`tether-relay-auth:${nonce}`)

export function frame(sid: number, data: Uint8Array) {
  const out = new Uint8Array(4 + data.length)
  new DataView(out.buffer).setUint32(0, sid)
  out.set(data, 4)
  return out
}

export function unframe(buf: Uint8Array): { sid: number; data: Uint8Array } {
  return { sid: new DataView(buf.buffer, buf.byteOffset).getUint32(0), data: buf.subarray(4) }
}

export const machinePath = (id: string) => `/m/${id}`
export const phonePath = (id: string) => `/p/${id}`

/** "https://relay.example.com" → its WebSocket URL for a path. */
export const relayWs = (relay: string, path: string) => relay.replace(/^http/, 'ws').replace(/\/+$/, '') + path
