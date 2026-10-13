/** What the hub answers a claim with (packages/protocol has the hub's copy). */
interface PhoneClaimResult {
  token: string
  hub: { id: string; name: string; version?: string }
}

/**
 * Hubs the phone app has paired with. The phone keeps reaching its own computers itself; a hub
 * brings its machines along, and they show in the same lists. A hub's machines carry its id in
 * front of theirs (`hub:<hubId>/<id>`), so every request and message finds its way back.
 */
export interface PairedHub {
  id: string
  name: string
  /** the hub's origin, https://hub.example or http://box:4777 */
  url: string
  token: string
  version?: string
  pairedAt: number
}

const KEY = 'inyon.hubs.v1'
const PREFIX = 'hub:'

export function listHubs(): PairedHub[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((h) => h && typeof h.id === 'string' && typeof h.url === 'string' && typeof h.token === 'string') : []
  } catch {
    return []
  }
}

const listeners = new Set<(hubs: PairedHub[]) => void>()
function save(hubs: PairedHub[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(hubs))
  } catch {}
  for (const fn of listeners) fn(hubs)
}
/** Called whenever the list changes (the sockets follow it). */
export function onHubs(fn: (hubs: PairedHub[]) => void) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

export const hubById = (id: string) => listHubs().find((h) => h.id === id)

export function forgetHub(id: string) {
  save(listHubs().filter((h) => h.id !== id))
}

/** A hub's machine as this app names it, and back. */
export const hubHostId = (hubId: string, id: string) => `${PREFIX}${hubId}/${id}`
export function splitHostId(id: string): { hub?: PairedHub; id: string } {
  if (!id.startsWith(PREFIX)) return { id }
  const slash = id.indexOf('/', PREFIX.length)
  if (slash < 0) return { id }
  const hub = hubById(id.slice(PREFIX.length, slash))
  return hub ? { hub, id: id.slice(slash + 1) } : { id }
}
export const isHubHost = (id: string) => id.startsWith(PREFIX)

/** The link a hub shows in its QR code: inyon://hub?u=<origin>&c=<id:code>&n=<name>, or the download page with it after the #. */
export function parseHubLink(text: string): { url: string; code: string; name?: string } | undefined {
  const t = text.trim()
  const m = t.match(/^(?:inyon:\/\/hub\?|https?:\/\/[^#\s]+#hub\?)(.+)$/)
  if (!m) return
  const q = new URLSearchParams(m[1])
  const url = q.get('u') ?? ''
  const code = q.get('c') ?? ''
  if (!/^https?:\/\/[^/\s]+$/.test(url) || !/^[0-9A-Za-z]{8}:\d{6}$/.test(code)) return
  return { url, code, name: q.get('n') ?? undefined }
}
export const looksLikeHubLink = (text: string) => !!parseHubLink(text)

/** "K7Q4-MX2T 493812", "K7Q4MX2T:493812" and the like, as the code the hub expects. */
export function normalizeHubCode(typed: string): string | undefined {
  const m = typed.toUpperCase().replace(/[\s-]/g, '').match(/^([0-9A-Z]{8}):?(\d{6})$/)
  return m ? `${m[1]}:${m[2]}` : undefined
}

/** A hub's address as typed: a host, host:port or full origin becomes an origin. */
export function hubOriginOf(typed: string): string | undefined {
  let t = typed.trim()
  if (!t) return
  if (!/^https?:\/\//.test(t)) t = `${/^(localhost|127\.|\[::1\]|[^.:]+)(:\d+)?$/.test(t) ? 'http' : 'https'}://${t}`
  try {
    const u = new URL(t)
    if (u.pathname !== '/' && u.pathname !== '') return
    return u.origin
  } catch {
    return
  }
}

/** Trades a code for a token at the hub and remembers the hub. */
export async function claimHub(url: string, code: string, name: string): Promise<PairedHub> {
  const res = await fetch(`${url}/api/phones/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name }),
    credentials: 'omit',
    signal: AbortSignal.timeout(15_000),
  })
  const data = (await res.json().catch(() => ({}))) as Partial<PhoneClaimResult> & { error?: string }
  if (!res.ok || !data.token || !data.hub) throw new Error(data.error ?? `The hub answered ${res.status}`)
  const hub: PairedHub = { id: data.hub.id, name: data.hub.name, url, token: data.token, version: data.hub.version, pairedAt: Date.now() }
  save([...listHubs().filter((h) => h.id !== hub.id), hub])
  return hub
}

/** A short-lived ticket for the hub's WebSocket, which can't carry the token itself. */
export async function hubTicket(hub: PairedHub): Promise<string> {
  const res = await fetch(`${hub.url}/api/phones/ticket`, { method: 'POST', headers: { authorization: `Bearer ${hub.token}` }, credentials: 'omit', signal: AbortSignal.timeout(10_000) })
  if (res.status === 401 || res.status === 403) throw new HubRevoked(hub)
  if (!res.ok) throw new Error(`The hub answered ${res.status}`)
  const { ticket } = (await res.json()) as { ticket: string }
  return ticket
}

/** The hub no longer knows this phone (it was forgotten on the hub). */
export class HubRevoked extends Error {
  constructor(public hub: PairedHub) {
    super(`${hub.name} no longer knows this phone`)
  }
}

export const hubWsUrl = (hub: PairedHub, ticket: string) => `${hub.url.replace(/^http/, 'ws')}/ws?ticket=${encodeURIComponent(ticket)}`
