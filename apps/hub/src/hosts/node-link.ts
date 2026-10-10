import type { ServerWebSocket } from 'bun'

/**
 * Machines running `tether-node` keep one outbound WebSocket to the hub. Commands travel over it
 * as JSON frames, so the machine never has to accept incoming connections.
 *
 *   hub → node   { id, op: 'exec' | 'stream' | 'pty' | 'write' | 'resize' | 'kill', ... }
 *   node → hub   { id, type: 'exit' | 'line' | 'data' | 'error', ... }
 */
export interface NodeSocketData {
  hostId: string
}

type Handler = (msg: any) => void

class NodeLinks {
  private sockets = new Map<string, ServerWebSocket<NodeSocketData>>()
  private handlers = new Map<string, Handler>()
  private seq = 0
  private listeners = new Set<(hostId: string, up: boolean) => void>()
  info = new Map<string, { version?: string; os?: string; connectedAt: number }>()

  onChange(fn: (hostId: string, up: boolean) => void) {
    this.listeners.add(fn)
  }

  attach(hostId: string, ws: ServerWebSocket<NodeSocketData>) {
    this.sockets.get(hostId)?.close(4000, 'replaced by a newer connection')
    this.sockets.set(hostId, ws)
    this.info.set(hostId, { connectedAt: Date.now() })
    for (const l of this.listeners) l(hostId, true)
  }

  detach(hostId: string, ws: ServerWebSocket<NodeSocketData>) {
    if (this.sockets.get(hostId) !== ws) return
    this.sockets.delete(hostId)
    // fail everything still waiting on this machine
    for (const [id, h] of this.handlers) if (id.startsWith(`${hostId}:`)) h({ type: 'error', error: 'The machine disconnected' })
    for (const l of this.listeners) l(hostId, false)
  }

  isUp(hostId: string) {
    return this.sockets.has(hostId)
  }

  disconnect(hostId: string) {
    this.sockets.get(hostId)?.close(4001, 'removed from Tether')
  }

  message(hostId: string, raw: string) {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.type === 'hello') {
      this.info.set(hostId, { version: msg.version, os: msg.os, connectedAt: Date.now() })
      return
    }
    this.handlers.get(`${hostId}:${msg.id}`)?.(msg)
  }

  /** Starts an operation; `onMsg` receives its frames until you call the returned `done`. */
  start(hostId: string, op: Record<string, unknown>, onMsg: Handler) {
    const ws = this.sockets.get(hostId)
    if (!ws) throw new Error('This machine is not connected. Is tether-node running on it?')
    const id = String(++this.seq)
    const key = `${hostId}:${id}`
    this.handlers.set(key, onMsg)
    ws.send(JSON.stringify({ ...op, id }))
    return {
      id,
      send: (extra: Record<string, unknown>) => this.sockets.get(hostId)?.send(JSON.stringify({ ...extra, id })),
      done: () => this.handlers.delete(key),
    }
  }
}

export const nodeLinks = new NodeLinks()
