import type { ClientMsg, ServerMsg } from '@tether/protocol'
import { wsUrl } from './hub.ts'
import { isPhone, PhoneSocket } from './phone.ts'

type Listener = (msg: ServerMsg) => void

/**
 * One WebSocket to the hub, shared by the whole app. Reconnects with backoff and replays
 * subscriptions, so views only declare what they want to watch.
 */
class Socket {
  private ws?: WebSocket | PhoneSocket
  private listeners = new Set<Listener>()
  private statusListeners = new Set<(up: boolean) => void>()
  private chats = new Map<string, { host: string; pane: string; refs: number }>()
  private overview = false
  private retry = 0
  private timer?: ReturnType<typeof setTimeout>
  private pingTimer?: ReturnType<typeof setInterval>
  private started = false
  /** when the hub last said anything; a socket that went quiet is dead even if it looks open */
  private heard = 0
  up = false

  start() {
    if (this.started) return
    this.started = true
    this.connect()
    // once, however often it's stopped and started again
    if (this.listening) return
    this.listening = true
    document.addEventListener('visibilitychange', this.revive)
    window.addEventListener('online', this.revive)
  }

  // phones suspend sockets in the background and drop them when the network changes (say from
  // NetBird to Tailscale): reconnect right away on return instead of waiting for the backoff
  private listening = false
  private revive = () => {
    if (!this.started || document.visibilityState !== 'visible' || this.ws?.readyState === WebSocket.CONNECTING) return
    // the phone's core runs in this page and can't have dropped: rebuilding it would close open
    // terminals and resend every chat, so only check on it
    if (this.up && (isPhone() || Date.now() - this.heard < 30000)) return this.raw({ t: 'ping' })
    clearTimeout(this.timer)
    this.retry = 0
    this.connect()
  }

  /** Connects again now instead of waiting for the backoff. */
  reconnect() {
    if (!this.started || this.ws?.readyState === WebSocket.CONNECTING) return
    clearTimeout(this.timer)
    this.retry = 0
    this.connect()
  }

  stop() {
    this.started = false
    clearTimeout(this.timer)
    this.ws?.close()
  }

  private connect() {
    if (!this.started) return
    // one connection at a time: a second one would deliver every message twice
    const old = this.ws
    if (old && old.readyState !== WebSocket.CLOSED) {
      old.onclose = old.onmessage = old.onopen = null
      old.close()
    }
    clearInterval(this.pingTimer)
    if (this.up) this.setUp(false)
    // the phone app talks to the core running inside it
    const ws = isPhone() ? new PhoneSocket() : new WebSocket(wsUrl())
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.retry = 0
      this.setUp(true)
      if (this.overview) this.raw({ t: 'sub.overview' })
      for (const c of this.chats.values()) this.raw({ t: 'sub.chat', host: c.host, pane: c.pane })
      this.heard = Date.now()
      clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => {
        // two pings without an answer: the connection is gone
        if (Date.now() - this.heard > 55000) return this.connect()
        this.raw({ t: 'ping' })
      }, 25000)
    }
    ws.onmessage = (e: { data: string }) => {
      if (this.ws !== ws) return
      this.heard = Date.now()
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
      if (isPhone()) return
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

  watching(key: string) {
    return this.chats.has(key)
  }

  private closedListeners = new Set<(key: string) => void>()
  /** A chat nobody watches any more (its messages can be let go; they reload on return). */
  onChatClosed(fn: (key: string) => void) {
    this.closedListeners.add(fn)
    return () => void this.closedListeners.delete(fn)
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
        for (const fn of this.closedListeners) fn(key)
      }
    }
  }
}

export const socket = new Socket()
