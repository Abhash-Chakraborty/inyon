import type { ClientMsg, ServerMsg } from '@tether/protocol'

type Listener = (msg: ServerMsg) => void

/**
 * One WebSocket to the hub, shared by the whole app. Reconnects with backoff and replays
 * subscriptions, so views only declare what they want to watch.
 */
class Socket {
  private ws?: WebSocket
  private listeners = new Set<Listener>()
  private statusListeners = new Set<(up: boolean) => void>()
  private chats = new Map<string, { host: string; pane: string; refs: number }>()
  private overview = false
  private retry = 0
  private timer?: ReturnType<typeof setTimeout>
  private pingTimer?: ReturnType<typeof setInterval>
  private started = false
  up = false

  start() {
    if (this.started) return
    this.started = true
    this.connect()
    document.addEventListener('visibilitychange', () => {
      // phones suspend sockets in the background; reconnect right away on return
      if (document.visibilityState === 'visible' && !this.up) {
        clearTimeout(this.timer)
        this.connect()
      }
    })
  }

  stop() {
    this.started = false
    clearTimeout(this.timer)
    this.ws?.close()
  }

  private connect() {
    if (!this.started) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.setUp(true)
      if (this.overview) this.raw({ t: 'sub.overview' })
      for (const c of this.chats.values()) this.raw({ t: 'sub.chat', host: c.host, pane: c.pane })
      clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => this.raw({ t: 'ping' }), 25000)
    }
    ws.onmessage = (e) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      for (const l of this.listeners) l(msg)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      clearInterval(this.pingTimer)
      this.setUp(false)
      const delay = Math.min(8000, 400 * 2 ** this.retry++)
      this.timer = setTimeout(() => this.connect(), delay)
      // the hub rejects the upgrade when the session expired
      fetch('/api/session').then((r) => r.json()).then((s) => {
        if (!s.authed) window.dispatchEvent(new Event('tether:signed-out'))
      }).catch(() => {})
    }
  }

  private setUp(up: boolean) {
    this.up = up
    for (const l of this.statusListeners) l(up)
  }

  private raw(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  send(msg: ClientMsg) {
    this.raw(msg)
  }

  on(fn: Listener) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  onStatus(fn: (up: boolean) => void) {
    this.statusListeners.add(fn)
    return () => void this.statusListeners.delete(fn)
  }

  subscribeOverview() {
    this.overview = true
    this.raw({ t: 'sub.overview' })
  }

  /** Reference-counted chat subscription; returns an unsubscribe function. */
  subscribeChat(host: string, pane: string) {
    const key = `${host}:${pane}`
    const cur = this.chats.get(key)
    if (cur) cur.refs++
    else {
      this.chats.set(key, { host, pane, refs: 1 })
      this.raw({ t: 'sub.chat', host, pane })
    }
    return () => {
      const c = this.chats.get(key)
      if (!c) return
      if (--c.refs <= 0) {
        this.chats.delete(key)
        this.raw({ t: 'unsub.chat', host, pane })
      }
    }
  }
}

export const socket = new Socket()
