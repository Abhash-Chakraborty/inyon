import { attemptAfter, backoff, type ClientMsg, type HostState, type ServerMsg } from '@inyon/protocol'
import { wsUrl } from './hub.ts'
import { isPhone, PhoneSocket } from './phone.ts'
import { forgetHub, hubHostId, HubRevoked, hubTicket, hubWsUrl, isHubHost, listHubs, onHubs, PlainRefused, splitHostId, type PairedHub } from './hubs.ts'
import { loadOverview } from './snapshot.ts'

/** A hub message as this app sees it: the hub's machines carry the hub's id, and the message says where it came from. */
export type Tagged = ServerMsg & { source?: string }
type Listener = (msg: Tagged) => void

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
  /** when the open connection came up: the backoff only starts over once it stayed up a while */
  private openedAt?: number
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
    this.startHubs()
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
    if (!this.started || document.visibilityState !== 'visible') return
    for (const h of this.hubs.values()) h.revive()
    if (this.ws?.readyState === WebSocket.CONNECTING) return
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
    for (const h of this.hubs.values()) h.stop()
    this.hubs.clear()
  }

  // ---------- paired hubs (the phone app) ----------

  private hubs = new Map<string, HubConn>()
  private following = false
  /** One connection per paired hub, following the list as hubs are added and forgotten. */
  private startHubs() {
    const sync = (hubs: PairedHub[]) => {
      if (!this.started) return
      for (const [id, h] of this.hubs) if (!hubs.some((x) => x.id === id)) {
        h.stop()
        this.hubs.delete(id)
        // its machines leave the lists
        for (const l of this.listeners) l({ t: 'overview', hosts: [], source: `hub:${id}` })
      }
      for (const hub of hubs) if (!this.hubs.has(hub.id)) {
        const conn = new HubConn(hub, (m) => { for (const l of this.listeners) l(m) }, () => this.overview, () => [...this.chats.values()])
        this.hubs.set(hub.id, conn)
        conn.connect()
      }
    }
    sync(listHubs())
    if (!this.following) {
      this.following = true
      onHubs(sync)
    }
  }
  /** The hub a message is about, by its host or by the terminal it opened. */
  private hubFor(msg: ClientMsg): HubConn | undefined {
    if ('host' in msg && isHubHost(msg.host)) {
      const { hub } = splitHostId(msg.host)
      return hub && this.hubs.get(hub.id)
    }
    if ('id' in msg && msg.t.startsWith('term.')) for (const h of this.hubs.values()) if (h.owns(msg.id)) return h
    return undefined
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
      this.openedAt = Date.now()
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
      this.retry = attemptAfter(this.retry, this.openedAt)
      this.openedAt = undefined
      const delay = backoff(this.retry++, 400, 8000)
      this.timer = setTimeout(() => this.connect(), delay)
      // the hub rejects the upgrade when the session expired
      if (isPhone()) return
      fetch('/api/session').then((r) => r.json()).then((s) => {
        if (!s.authed) window.dispatchEvent(new Event('inyon:signed-out'))
      }).catch(() => {})
    }
  }

  private setUp(up: boolean) {
    this.up = up
    for (const l of this.statusListeners) l(up)
  }

  private raw(msg: ClientMsg) {
    const hub = this.hubFor(msg)
    if (hub) return hub.send(msg)
    if (msg.t === 'sub.overview') for (const h of this.hubs.values()) h.send(msg)
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

/**
 * One paired hub's WebSocket. Everything in has the hub's machines renamed to carry the hub's id;
 * everything out has them renamed back. A hub that is out of reach shows its machines as
 * connecting until it answers again; one that has forgotten this phone is forgotten here too.
 */
export class HubConn {
  private ws?: WebSocket
  private retry = 0
  private openedAt?: number
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  /** the hub's machines as last heard, starting from the copy this device kept of them */
  private last: HostState[]
  private terms = new Set<string>()
  private heard = 0
  private pingTimer?: ReturnType<typeof setInterval>
  private attempts = 0

  constructor(
    readonly hub: PairedHub,
    private emit: (m: Tagged) => void,
    private wantOverview: () => boolean,
    private chats: () => { host: string; pane: string }[],
  ) {
    // the app may open while the hub is out of reach (the phone off its VPN, say): its machines
    // still have to show, as connecting, so they start from what this device remembers of them
    this.last = (loadOverview() ?? []).filter((h) => splitHostId(h.config.id).hub?.id === hub.id)
  }

  get source() {
    return `hub:${this.hub.id}`
  }
  owns(termId: string) {
    return this.terms.has(termId)
  }

  async connect() {
    if (this.stopped) return
    clearTimeout(this.timer)
    // a newer call (a resume while the ticket was on its way) wins; this one stops where it is
    const attempt = ++this.attempts
    let ticket: string
    try {
      ticket = await hubTicket(this.hub)
    } catch (err) {
      if (attempt !== this.attempts) return
      if (err instanceof HubRevoked) return this.revoked()
      // a hub that can't be reached at all is as gone as one whose connection dropped; one the
      // app won't use plain http with says why on its machines
      this.offline(err instanceof PlainRefused ? err.message : undefined)
      return this.later()
    }
    if (this.stopped || attempt !== this.attempts) return
    // one connection at a time: one left open would keep the hub sending to it, unheard
    this.drop()
    const ws = new WebSocket(hubWsUrl(this.hub, ticket))
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.openedAt = Date.now()
      this.heard = Date.now()
      if (this.wantOverview()) this.sendRaw({ t: 'sub.overview' })
      for (const c of this.chats()) {
        const { hub, id } = splitHostId(c.host)
        if (hub?.id === this.hub.id) this.sendRaw({ t: 'sub.chat', host: id, pane: c.pane })
      }
      clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.heard > 55000) return this.connect()
        this.sendRaw({ t: 'ping' })
      }, 25000)
    }
    ws.onmessage = (e) => {
      if (this.ws !== ws) return
      this.heard = Date.now()
      let msg: ServerMsg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      this.emit(this.inbound(msg))
    }
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      clearInterval(this.pingTimer)
      if (e.code === 4001) return this.revoked()
      this.retry = attemptAfter(this.retry, this.openedAt)
      this.openedAt = undefined
      this.offline()
      this.later()
    }
    ws.onerror = () => {}
  }

  private later() {
    if (this.stopped) return
    const delay = backoff(this.retry++, 1000, 30_000)
    this.timer = setTimeout(() => this.connect(), delay)
  }

  revive() {
    if (this.stopped || this.ws?.readyState === WebSocket.CONNECTING) return
    if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.heard < 30000) return this.sendRaw({ t: 'ping' })
    clearTimeout(this.timer)
    this.retry = 0
    this.connect()
  }

  /** The hub's machines, as last seen, shown as connecting while the hub itself is out of reach. */
  private offline(why?: string) {
    if (!this.last.length) return
    const error = why ?? (this.heard ? `Reconnecting to ${this.hub.name}` : `Connecting to ${this.hub.name}…`)
    this.emit({ t: 'overview', hosts: this.last.map((h) => ({ ...h, status: 'connecting', error })), source: this.source })
  }

  private revoked() {
    this.stop()
    this.emit({ t: 'overview', hosts: [], source: this.source })
    forgetHub(this.hub.id)
    window.dispatchEvent(new CustomEvent('inyon:hub-forgot', { detail: this.hub }))
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    clearInterval(this.pingTimer)
    this.drop()
  }

  /** Closes the current connection without reacting to its close. */
  private drop() {
    const ws = this.ws
    this.ws = undefined
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = null
      ws.close()
    }
  }

  /** A message for this hub, with its machine ids as the hub knows them. */
  send(msg: ClientMsg) {
    if ('host' in msg) msg = { ...msg, host: splitHostId(msg.host).id }
    if (msg.t === 'term.open') this.terms.add(msg.id)
    if (msg.t === 'term.close') this.terms.delete(msg.id)
    this.sendRaw(msg)
  }
  private sendRaw(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  /**
   * A message from this hub, with its machines renamed to carry the hub's id. Only the machine list
   * is tagged with where it came from: a draft has a `source` of its own (the app or the terminal).
   */
  private inbound(m: ServerMsg): Tagged {
    const name = (id: string) => hubHostId(this.hub.id, id)
    // every chat message carries `key`, the machine and pane joined by a colon
    const key = (k: string) => k.replace(/^([^:]+):/, (_, host: string) => `${name(host)}:`)
    switch (m.t) {
      case 'overview': {
        // a server reached through one of the hub's computers names that computer
        const hosts = m.hosts.map((h) => ({ ...h, config: { ...h.config, id: name(h.config.id), ...(h.config.via ? { via: name(h.config.via) } : {}) } }))
        this.last = hosts
        return { ...m, hosts, source: this.source }
      }
      case 'notify':
        return { ...m, host: name(m.host) }
      case 'term.exit':
        this.terms.delete(m.id)
        return m
      case 'term.data':
      case 'pong':
        return m
      case 'chat.reset':
      case 'chat.info':
        return { ...m, key: key(m.key), info: { ...m.info, hostId: name(m.info.hostId) } }
      default:
        return { ...m, key: key(m.key) }
    }
  }
}
