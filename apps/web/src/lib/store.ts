import { create } from 'zustand'
import type { ChatInfo, ChatItem, HostState, LiveItem, ScreenState, ServerMsg } from '@inyon/protocol'
import { socket, type Tagged } from './socket.ts'
import { splitHostId, tellApart } from './hubs.ts'
import { haptic } from './haptics.ts'
import { clearNativeNotification, isNative, nativeNotify } from './native.ts'
import { appHref, publicFile, routeOf } from './base.ts'

import { settle, PENDING_MS, type PendingMessage } from './pending.ts'
import { reuse } from './reuse.ts'
import { clearSnapshots, loadChat, loadOverview, saveChat, saveOverview } from './snapshot.ts'
export { norm, msgKey, PENDING_MS, type PendingMessage } from './pending.ts'

export interface ChatState {
  info?: ChatInfo
  items: ChatItem[]
  hasMore: boolean
  loaded: boolean
  screen?: ScreenState
  /** what the agent is writing right now, shown until its record has it */
  live?: LiveItem[]
  /** when earlier messages last came back (with or without any), so a wait for them can end */
  moreAt?: number
  /** catching up on what was said while away, as a fraction read; cleared by the next reset */
  catchingUp?: number
  /** sent from this device, not yet seen in the transcript */
  pending: PendingMessage[]
  /** the unsent message, shared with other devices and the terminal's input box */
  draft?: { text: string; source: 'app' | 'terminal'; at: number }
  /** drawn from the copy kept on this device; the hub's first page replaces it */
  stale?: boolean
}

export interface Toast {
  id: number
  title: string
  body?: string
  tone: 'info' | 'success' | 'warn' | 'error'
  href?: string
  agent?: string
}

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  agentSkins: boolean
  replyFont: 'auto' | 'serif' | 'sans' | 'mono'
  density: 'comfortable' | 'compact'
  termFontSize: number
  notifyDone: boolean
  sidePanel: boolean
  haptics: boolean
  /** chat: every tool call and background job as its own row ('all'), or long runs folded ('compact') */
  toolDetail: 'all' | 'compact'
}

const SETTINGS_KEY = 'inyon.settings.v2'
const defaults: Settings = {
  theme: 'system',
  agentSkins: true,
  replyFont: 'auto',
  density: 'comfortable',
  termFontSize: 13,
  notifyDone: true,
  sidePanel: true,
  haptics: true,
  toolDetail: 'all',
}

function loadSettings(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }
  } catch {
    return defaults
  }
}

export interface ActivityEvent {
  id: number
  at: number
  host: string
  pane: string
  kind: 'waiting' | 'done'
  title: string
  body: string
  agent?: string
}

interface Store {
  activity: ActivityEvent[]
  authed: boolean | null
  connected: boolean
  hosts: HostState[]
  hostsLoaded: boolean
  /** the overview is the copy kept on this device, not yet confirmed by the hub */
  hostsStale: boolean
  chats: Record<string, ChatState>
  toasts: Toast[]
  settings: Settings
  resolvedTheme: 'light' | 'dark'
  setAuthed(v: boolean): void
  toast(t: Omit<Toast, 'id'>): void
  dismiss(id: number): void
  setSettings(p: Partial<Settings>): void
}

let toastId = 0

// the last overview this device saw paints first; the hub's replaces it in place
const remembered = loadOverview()

export const useStore = create<Store>((set, get) => ({
  activity: [],
  // with a picture to show, the app draws it before the hub confirms the sign-in; a session that
  // ran out turns into the sign-in page a moment later
  authed: remembered ? true : null,
  connected: false,
  hosts: remembered ?? [],
  hostsLoaded: !!remembered,
  hostsStale: !!remembered,
  chats: {},
  toasts: [],
  settings: loadSettings(),
  resolvedTheme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  setAuthed: (authed) => set({ authed }),
  toast: (t) => {
    const id = ++toastId
    // one per session: a newer notice about the same conversation replaces the older one
    set({ toasts: [...get().toasts.filter((x) => !t.href || x.href !== t.href).slice(-2), { ...t, id }] })
    setTimeout(() => get().dismiss(id), t.tone === 'error' ? 6000 : 4500)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setSettings: (p) => {
    const settings = { ...get().settings, ...p }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {}
    set({ settings })
  },
}))

export const toast = (t: Omit<Toast, 'id'>) => useStore.getState().toast(t)

const pendingStorageKey = (key: string) => `inyon.pending.${key}`
function recoveredPending(key: string): PendingMessage[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(pendingStorageKey(key)) ?? '[]')
    if (!Array.isArray(saved)) return []
    // after a reload: a send that was still in flight may or may not have arrived, so say so; a
    // failure keeps its reason, and anything older than the pending window is dropped
    return saved
      .filter((p) => p && typeof p.id === 'string' && typeof p.text === 'string' && typeof p.at === 'number' && Date.now() - p.at < PENDING_MS)
      .map((p) => (p.status === 'sending' ? { ...p, status: 'failed', error: 'Delivery was interrupted. Check the terminal before retrying.' } : p))
  } catch { return [] }
}
const emptyChat = (key: string): ChatState => ({ items: [], hasMore: false, loaded: false, pending: recoveredPending(key) })

export function patchChat(key: string, fn: (c: ChatState) => Partial<ChatState>) {
  const chats = useStore.getState().chats
  const cur = chats[key] ?? emptyChat(key)
  const next = { ...cur, ...fn(cur) }
  try {
    if (next.pending.length) sessionStorage.setItem(pendingStorageKey(key), JSON.stringify(next.pending))
    else sessionStorage.removeItem(pendingStorageKey(key))
  } catch {}
  useStore.setState({ chats: { ...chats, [key]: next } })
  if (next.loaded && !next.stale && next.items.length) saveChat(key, next)
}

/** Shows the page of this chat kept on the device, until the hub sends the real one. */
export function hydrateChat(key: string) {
  if (useStore.getState().chats[key]?.loaded) return
  const kept = loadChat(key)
  if (kept) patchChat(key, () => ({ ...kept, loaded: true, stale: true }))
}


/**
 * Panes ended from here: gone from every list at once, and kept out of the updates that still list
 * them for a moment while tmux closes them.
 */
const ended = new Map<string, number>()
const endedKey = (host: string, pane: string) => `${host}\u0000${pane}`

export function withoutEnded(hosts: HostState[], now = Date.now()): HostState[] {
  for (const [k, until] of ended) if (until < now) ended.delete(k)
  if (!ended.size) return hosts
  return hosts.map((h) => {
    if (![...ended.keys()].some((k) => k.startsWith(`${h.config.id}\u0000`))) return h
    const sessions = h.sessions
      .map((s) => ({ ...s, windows: s.windows.map((w) => ({ ...w, panes: w.panes.filter((p) => !ended.has(endedKey(h.config.id, p.id))) })).filter((w) => w.panes.length) }))
      .filter((s) => s.windows.length)
    return { ...h, sessions }
  })
}

/** Forgets every hidden pane (tests start clean). */
export const forgetEnded = () => ended.clear()

/** Hides a pane being ended; `false` brings it back (the end failed). */
export function hidePane(host: string, pane: string, hide = true) {
  if (hide) ended.set(endedKey(host, pane), Date.now() + 15_000)
  else ended.delete(endedKey(host, pane))
  if (hide) useStore.setState((s) => ({ hosts: withoutEnded(s.hosts) }))
}

/**
 * The machines by where they come from: the hub this page is served by (or the phone's own
 * core), then each paired hub in the order they were paired. One list for the screens.
 */
const sources = new Map<string, HostState[]>()
const allHosts = () => tellApart([...sources.values()].flat())

/**
 * The remembered machines go back to where they came from, so the first live overview (on a
 * phone, its own core's, which answers at once) replaces only its own part: a paired hub that
 * hasn't answered yet keeps its machines on the list instead of leaving a blank page.
 */
export function rememberSources(hosts: HostState[]) {
  sources.clear()
  for (const h of hosts) {
    const hub = splitHostId(h.config.id).hub
    const key = hub ? `hub:${hub.id}` : 'main'
    sources.set(key, [...(sources.get(key) ?? []), h])
  }
}
if (remembered) rememberSources(remembered)

function onMessage(m: Tagged) {
  switch (m.t) {
    case 'overview': {
      sources.set(m.source ?? 'main', m.hosts)
      const hosts = allHosts()
      // a card whose pane didn't change keeps its objects, so only the changed ones render again
      useStore.setState((s) => ({ hosts: reuse(s.hosts, withoutEnded(hosts)), hostsLoaded: true, hostsStale: false }))
      saveOverview(hosts)
      clearAnswered(hosts)
      break
    }
    case 'chat.reset':
      patchChat(m.key, (c) => {
        // Gemini, Antigravity and OpenCode resend their latest page on every step: keep the earlier
        // messages this screen already loaded, or someone reading back jumps on each update
        const head = m.items[0]
        const keep = !!head && m.hasMore && c.items.some((i) => i.seq === head.seq && i.uuid === head.uuid)
        const items = keep ? [...c.items.filter((i) => i.seq < head.seq), ...m.items] : m.items
        return { info: m.info, items, hasMore: keep ? c.hasMore : m.hasMore, loaded: true, stale: undefined, catchingUp: undefined, pending: settle(c.pending, m.items, m.info.sends), live: withoutRecorded(c.live, m.items) }
      })
      break
    case 'chat.live':
      patchChat(m.key, (c) => ({ live: withoutRecorded(m.items, c.items) }))
      break
    case 'chat.progress':
      patchChat(m.key, () => ({ catchingUp: m.total > 0 ? Math.min(1, m.done / m.total) : undefined }))
      break
    case 'chat.append':
      patchChat(m.key, (c) => {
        const last = c.items[c.items.length - 1]?.seq ?? -1
        const fresh = m.items.filter((i) => i.seq > last)
        return { items: [...c.items, ...fresh], pending: settle(c.pending, fresh, c.info?.sends), live: withoutRecorded(c.live, fresh) }
      })
      break
    case 'chat.more':
      patchChat(m.key, (c) => {
        const first = c.items[0]?.seq ?? Infinity
        return { items: [...m.items.filter((i) => i.seq < first), ...c.items], hasMore: m.hasMore, moreAt: Date.now() }
      })
      break
    case 'chat.info':
      patchChat(m.key, (c) => ({ info: m.info, loaded: c.loaded || !m.info.transcriptPath }))
      break
    case 'chat.screen':
      patchChat(m.key, () => ({ screen: m.screen }))
      break
    case 'chat.draft':
      patchChat(m.key, () => ({ draft: { text: m.text, source: m.source, at: m.at } }))
      break
    case 'notify':
      notify(m)
      break
  }
}

/**
 * Live text whose finished record is among `items` goes: the record (same id) takes its place in
 * the same render, so the reply never shows twice and never blinks out between the two.
 */
export function withoutRecorded(live: LiveItem[] | undefined, items: ChatItem[]): LiveItem[] | undefined {
  if (!live?.length || !items.length) return live
  const ids = new Set<string>()
  for (const i of items) {
    ids.add(i.uuid)
    if (i.kind === 'assistant') ids.add(i.msgId)
    if (i.kind === 'assistant' && i.block.type === 'tool_use') ids.add(i.block.id)
    if (i.kind === 'tool_result') ids.add(i.toolUseId)
  }
  const kept = live.filter((l) => !ids.has(l.id))
  return kept.length === live.length ? live : kept
}

/** Sessions with a "needs you" notification up, by tag. */
const asking = new Map<string, { host: string; pane: string }>()
/** The browser's notifications (outside the phone app), by the same tags, so they can be taken back. */
const shown = new Map<string, Notification>()

function closeShown(tag: string) {
  shown.get(tag)?.close()
  shown.delete(tag)
}

/**
 * A question answered somewhere else (on the computer, say) takes its notification with it, so
 * what's left in the shade still needs you.
 */
function clearAnswered(hosts: HostState[]) {
  for (const [tag, { host, pane }] of asking) {
    const h = hosts.find((x) => x.config.id === host)
    // a machine that went quiet says nothing about the question
    if (!h || h.status !== 'online') continue
    const p = h.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes)).find((x) => x.id === pane)
    if (p?.agent?.state === 'waiting') continue
    asking.delete(tag)
    clearNativeNotification(tag)
    closeShown(tag)
  }
}

/** The same prompt reported again within a few seconds doesn't buzz twice. */
const buzzed = new Map<string, number>()
function buzzOnce(tag: string, kind: string) {
  const k = `${tag}:${kind}`
  const now = Date.now()
  if ((buzzed.get(k) ?? 0) > now - 10_000) return false
  buzzed.set(k, now)
  return true
}

/** One notification per session (or machine): the next one replaces it, opening it clears it. */
export const notifyTag = (host: string, pane?: string) => (pane ? `${host}:${pane}` : `machine:${host}`)

function notify(m: Extract<ServerMsg, { t: 'notify' }>) {
  const { settings } = useStore.getState()
  const machine = m.kind === 'offline' || m.kind === 'online'
  const href = machine ? `/machines/${encodeURIComponent(m.host)}` : `/m/${encodeURIComponent(m.host)}/p/${m.pane.replace(/^%/, '')}`
  if (!machine) {
    const kind = m.kind as ActivityEvent['kind']
    useStore.setState({ activity: [{ id: Date.now(), at: Date.now(), host: m.host, pane: m.pane, kind, title: m.title, body: m.body, agent: m.agent }, ...useStore.getState().activity].slice(0, 30) })
  }
  if (m.kind === 'done' && !settings.notifyDone) return
  // don't toast about the conversation you're looking at
  const here = routeOf(location.pathname) === href && document.visibilityState === 'visible'
  if (!here) toast({ title: m.title, body: m.body, tone: m.kind === 'waiting' || m.kind === 'offline' ? 'warn' : 'success', href, agent: m.agent })
  const tag = notifyTag(m.host, machine ? undefined : m.pane)
  // two short pulses when an agent needs you or finishes, once per prompt; a buzz for a lost machine
  if (document.visibilityState === 'visible') {
    if ((m.kind === 'waiting' || m.kind === 'done') && buzzOnce(tag, m.kind)) haptic('success')
    else if (m.kind === 'offline' && !here) haptic('warning')
  }
  if (document.visibilityState === 'hidden' && isNative()) {
    if (m.kind === 'waiting') asking.set(tag, { host: m.host, pane: m.pane })
    else asking.delete(tag)
    void nativeNotify(m.title, m.body, href, tag, m.kind)
    return
  }
  if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      closeShown(tag)
      const n = new Notification(m.title, { body: m.body, tag, icon: publicFile('icon-192.png'), badge: publicFile('badge-96.png') })
      shown.set(tag, n)
      if (m.kind === 'waiting') asking.set(tag, { host: m.host, pane: m.pane })
      else asking.delete(tag)
      n.onclose = () => shown.get(tag) === n && shown.delete(tag)
      n.onclick = () => {
        closeShown(tag)
        window.focus()
        window.history.pushState({}, '', appHref(href))
        window.dispatchEvent(new PopStateEvent('popstate'))
      }
    } catch {}
  }
}

socket.on(onMessage)
// a chat you left keeps its draft and unsent messages; its history reloads when you come back,
// so the app doesn't hold every conversation you ever opened. A short delay keeps quick
// back-and-forth navigation instant.
const forget = new Map<string, ReturnType<typeof setTimeout>>()
socket.onChatClosed((key) => {
  clearTimeout(forget.get(key))
  forget.set(key, setTimeout(() => {
    forget.delete(key)
    const c = useStore.getState().chats[key]
    // its title and model can show while it reloads; a goal or queue may be long gone by then
    if (c && !socket.watching(key)) patchChat(key, () => ({ items: [], hasMore: false, loaded: false, screen: undefined, ...(c.info && { info: { ...c.info, goal: undefined, queue: [] } }) }))
  }, 60_000))
})
socket.onStatus((connected) => useStore.setState({ connected }))
// signing out takes the device's copies with it
window.addEventListener('inyon:signed-out', () => {
  clearSnapshots()
  sources.clear()
  useStore.setState({ hosts: [], hostsLoaded: false, hostsStale: false, chats: {} })
})
// a hub that forgot this phone: its machines are gone from the lists, and the person should know
window.addEventListener('inyon:hub-forgot', (e) => {
  const hub = (e as CustomEvent<{ name: string }>).detail
  toast({ title: `${hub.name} forgot this phone`, body: 'Pair it again from the hub to see its machines here.', tone: 'warn' })
})
