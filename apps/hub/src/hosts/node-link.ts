import { HttpError } from './http-error.ts'

/**
 * Machines running `inyon` keep one outbound WebSocket to the hub. Commands travel over it
 * as JSON frames, so the machine never has to accept incoming connections.
 *
 *   hub → node   { id, op: 'exec' | 'stream' | 'pty' | 'write' | 'resize' | 'kill', ... }
 *   node → hub   { id, type: 'exit' | 'line' | 'data' | 'error', ... }
 */
export interface NodeSocketData {
  hostId: string
}

/** The hub's WebSocket from a node, or the phone's encrypted channel to a laptop. */
export interface NodeSocket {
  send(data: string): unknown
  close(code?: number, reason?: string): unknown
}

type Handler = (msg: any) => void
/** An operation stays with the socket it started on; a newer connection doesn't inherit it. */
type Op = { ws: NodeSocket; onMsg: Handler }

class NodeLinks {
  private sockets = new Map<string, NodeSocket>()
  private errors = new Map<string, string>()
  private handlers = new Map<string, Op>()
  private seq = 0
  private listeners = new Set<(hostId: string, up: boolean) => void>()
  /** what each machine said in its hello; `warning`: plain http to a hub it was added to before 0.20 */
  info = new Map<string, { version?: string; os?: string; warning?: string; connectedAt: number }>()

  onChange(fn: (hostId: string, up: boolean) => void) {
    this.listeners.add(fn)
  }

  attach(hostId: string, ws: NodeSocket) {
    this.errors.delete(hostId)
    const old = this.sockets.get(hostId)
    if (old && old !== ws) {
      // its close callback comes later and finds the new socket in place, so end its work now
      this.failOps(hostId, old)
      old.close(4000, 'replaced by a newer connection')
    }
    this.sockets.set(hostId, ws)
    this.info.set(hostId, { connectedAt: Date.now() })
    for (const l of this.listeners) l(hostId, true)
  }

  detach(hostId: string, ws: NodeSocket) {
    if (this.sockets.get(hostId) !== ws) return
    this.sockets.delete(hostId)
    this.failOps(hostId, ws)
    for (const l of this.listeners) l(hostId, false)
  }

  /** Fails everything still waiting on this socket. */
  private failOps(hostId: string, ws: NodeSocket) {
    for (const [key, op] of [...this.handlers]) {
      if (op.ws !== ws || !key.startsWith(`${hostId}:`)) continue
      this.handlers.delete(key)
      op.onMsg({ type: 'error', error: 'The machine disconnected' })
    }
  }

  /** Couldn't connect (the phone's side): say why until it does. */
  fail(hostId: string, error: string) {
    if (this.sockets.has(hostId) || this.errors.get(hostId) === error) return
    this.errors.set(hostId, error)
    for (const l of this.listeners) l(hostId, false)
  }

  clearError(hostId: string) {
    this.errors.delete(hostId)
  }

  /** Why the machine isn't connected, when something more specific than "waiting" is known. */
  why(hostId: string) {
    return this.errors.get(hostId)
  }

  isUp(hostId: string) {
    return this.sockets.has(hostId)
  }

  disconnect(hostId: string) {
    this.sockets.get(hostId)?.close(4001, 'removed from Inyon')
  }

  message(hostId: string, raw: string) {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    this.receive(hostId, msg)
  }

  receive(hostId: string, msg: any) {
    if (msg?.type === 'hello') {
      this.info.set(hostId, { version: msg.version, os: msg.os, ...(typeof msg.warning === 'string' && msg.warning ? { warning: msg.warning } : {}), connectedAt: Date.now() })
      return
    }
    this.handlers.get(`${hostId}:${msg.id}`)?.onMsg(msg)
  }

  /** Starts an operation; `onMsg` receives its frames until you call the returned `done`. */
  start(hostId: string, op: Record<string, unknown>, onMsg: Handler) {
    const ws = this.sockets.get(hostId)
    // the hub is fine, the machine isn't there: 503, which the app shows and may retry
    if (!ws) throw new HttpError(503, 'This machine is not connected. Is inyon running on it?')
    const id = String(++this.seq)
    const key = `${hostId}:${id}`
    this.handlers.set(key, { ws, onMsg })
    ws.send(JSON.stringify({ ...op, id }))
    return {
      id,
      // only to the socket it started on, and only while that one is still the machine's
      send: (extra: Record<string, unknown>) => (this.sockets.get(hostId) === ws ? ws.send(JSON.stringify({ ...extra, id })) : undefined),
      done: () => this.handlers.delete(key),
    }
  }
}

export const nodeLinks = new NodeLinks()
