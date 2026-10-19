import { create } from 'zustand'
import type { PageEntry, PageOpen } from '@inyon/protocol'
import { api, ApiError } from './api.ts'
import { hubHostId, isHubHost, listHubs, splitHostId, type PairedHub } from './hubs.ts'
import { isPhone } from './phone.ts'

/**
 * Pages: sites an agent made (plans, mockups) that the hub serves under a token link, shown in a
 * sandboxed frame. The list comes from GET /api/pages on the hub this app runs on, or, in the
 * phone app, from every paired hub with the phone's token. The phone itself can't serve a page.
 */

/** A page as the app lists it: its entry, with the hub's machine id as this app names it. */
export interface Page extends PageEntry {
  /** `<host>/<slug>` */
  id: string
}

export const pageId = (host: string, slug: string) => `${host}/${slug}`
export const pageHref = (host: string, slug: string) => `/pages/${encodeURIComponent(host)}/${slug}`

/** The last folder of a project path, as the list names it. */
export const projectName = (project: string) => project.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || project

/** When a page last changed, as far as the app can tell: its progress, or when it was added. */
export function changedAt(p: PageEntry): number {
  const t = p.progress?.updated ? Date.parse(p.progress.updated) : NaN
  return Number.isFinite(t) ? Math.max(t, p.added) : p.added
}

/** A hub's own machine: "local" here, or "hub:<id>/local" for a paired hub's. */
export const isHubMachine = (host: string) => (isHubHost(host) ? host.slice(host.indexOf('/') + 1) : host) === 'local'

/** A machine's projects and their pages, the newest change first. */
export interface PageGroup {
  host: string
  projects: { name: string; key: string; pages: Page[] }[]
}

/**
 * Machine, then project, then page. The hub's own machine comes first, then the others by name;
 * projects by name; inside a project the page that changed last is on top.
 */
export function groupPages(pages: Page[], hostName: (host: string) => string): PageGroup[] {
  const byHost = new Map<string, Map<string, Page[]>>()
  for (const p of pages) {
    const projects = byHost.get(p.host) ?? byHost.set(p.host, new Map()).get(p.host)!
    const name = projectName(p.project)
    ;(projects.get(name) ?? projects.set(name, []).get(name)!).push(p)
  }
  const hosts = [...byHost.keys()].sort((a, b) => Number(isHubMachine(b)) - Number(isHubMachine(a)) || hostName(a).localeCompare(hostName(b)))
  return hosts.map((host) => ({
    host,
    projects: [...byHost.get(host)!.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, list]) => ({ name, key: `${host}/${name}`, pages: [...list].sort((a, b) => changedAt(b) - changedAt(a)) })),
  }))
}

/** Whether a page matches what's typed in the filter: its name, project or machine. */
export function matchesPage(p: Page, machine: string, q: string) {
  const t = q.trim().toLowerCase()
  return !t || [p.name, projectName(p.project), machine].some((s) => s.toLowerCase().includes(t))
}

// ---------- changed since you last opened it ----------

const SEEN_KEY = 'inyon.pages.seen.v1'

function loadSeen(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

/** A page counts as changed until it is opened, and again whenever it changes after that. */
export const isChanged = (p: Page, seen: Record<string, number>) => !(p.id in seen) || changedAt(p) > seen[p.id]!

// ---------- links ----------

/** A link is minted again when less than this is left of it (on open, and when the app comes back into view). */
export const RENEW_BEFORE_MS = 60 * 60 * 1000
export const shouldRenew = (expires: number, now: number) => expires - now < RENEW_BEFORE_MS

/** Where a page's hub is: '' for the hub this app came from, else the paired hub's address. */
export const pageBase = (host: string) => splitHostId(host).hub?.url ?? ''

/** A page link as the browser outside the app needs it, with the hub's address in front. */
export const absoluteLink = (host: string, url: string) => `${pageBase(host) || location.origin}${url}`

/** The parts of a Blueprint site the viewer can jump to. */
export type Part = 'plan' | 'mockups' | 'matrix'
export const PART_PATH: Record<Part, string> = { plan: '', mockups: 'mockups/', matrix: 'matrix.html' }
export const PART_LABEL: Record<Part, string> = { plan: 'Plan', mockups: 'Mockups', matrix: 'Matrix' }

/**
 * The frame's address: the token path (it ends in a slash, so the query survives without a
 * redirect), the part, and the app's theme for the page to start in.
 */
export const frameSrc = (base: string, url: string, part: Part, theme: 'light' | 'dark') => `${base}${url}${PART_PATH[part]}?theme=${theme}`

/** Messages a page may send the app. Anything else, or from anywhere but the frame, is ignored. */
export type FrameMessage = { type: 'theme?' }
const FRAME_TYPES = new Set<string>(['theme?'])

/** The message, when it came from the page's own frame and is a kind the app knows; null otherwise. */
export function frameMessage(e: { source: unknown; data: unknown }, frame: Window | null | undefined): FrameMessage | null {
  if (!frame || e.source !== frame) return null
  const d = e.data as { type?: unknown } | null
  if (!d || typeof d !== 'object' || typeof d.type !== 'string' || !FRAME_TYPES.has(d.type)) return null
  return { type: d.type as FrameMessage['type'] }
}

/**
 * The Preview tab frames what it shows with same-origin rights, so it must never show Inyon itself:
 * that page would run as you. Returns why it won't, or null.
 */
export function previewRefusal(url: string, appOrigins: string[]): string | null {
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return null
  }
  return appOrigins.includes(origin) ? 'That address is Inyon itself, and a preview of it could act as you. Pages an agent made open under Pages.' : null
}

/** This app's own address and every paired hub's, which the Preview tab refuses. */
export const appOrigins = () => [location.origin, ...listHubs().flatMap((h) => { try { return [new URL(h.url).origin] } catch { return [] } })]

// ---------- words ----------

/** "just now", "3 min ago", "2 h ago", "4 d ago", or a date. */
export function agoText(t: number, now = Date.now()) {
  const s = Math.max(0, (now - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 14 * 86400) return `${Math.round(s / 86400)} d ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** "11 h 52 m" until a link runs out. */
export function leftText(expires: number, now = Date.now()) {
  const m = Math.max(0, Math.floor((expires - now) / 60000))
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} m`
}

/** The device sizes the desktop viewer offers; Fit fills the pane. */
export type Device = 'fit' | 'phone' | 'tablet' | 'desktop'
export const DEVICES: Record<Exclude<Device, 'fit'>, { name: string; w: number; h: number }> = {
  phone: { name: 'Phone', w: 390, h: 844 },
  tablet: { name: 'Tablet', w: 820, h: 1180 },
  desktop: { name: 'Desktop', w: 1440, h: 900 },
}
/** How much a device frame shrinks to fit the stage, never grown past its real size. */
export const fitScale = (w: number, h: number, stageW: number, stageH: number, pad = 24) => Math.max(0.1, Math.min(1, (stageW - pad) / w, (stageH - pad) / h))

// ---------- the list ----------

interface PagesState {
  /** null until the first answer */
  pages: Page[] | null
  /** the phone app with no hub paired: pages open through a hub, so there is nothing to list */
  hubless: boolean
  error?: string
  seen: Record<string, number>
}

export const usePages = create<PagesState>(() => ({ pages: null, hubless: false, seen: loadSeen() }))

const asPages = (entries: PageEntry[] | undefined, host: (h: string) => string = (h) => h): Page[] =>
  (Array.isArray(entries) ? entries : []).map((e) => ({ ...e, host: host(e.host), id: pageId(host(e.host), e.slug) }))

async function fromHub(hub: PairedHub): Promise<Page[]> {
  try {
    const r = await api.hubPages(hub)
    return asPages(r?.pages, (h) => hubHostId(hub.id, h))
  } catch (e) {
    // a hub from before Pages has no such route: it simply has none
    if (e instanceof ApiError && e.status === 404) return []
    throw e
  }
}

let loading: Promise<void> | undefined
/** Asks for the list again (at most one request at a time). */
export function loadPages(): Promise<void> {
  if (loading) return loading
  // cleared once it settles: a finally inside could run before the promise is even stored
  const p = fetchPages().finally(() => {
    if (loading === p) loading = undefined
  })
  return (loading = p)
}

async function fetchPages(): Promise<void> {
  try {
    if (!isPhone()) {
      const r = await api.pages()
      usePages.setState({ pages: asPages(r?.pages), hubless: false, error: undefined })
      return
    }
    const hubs = listHubs()
    if (!hubs.length) return usePages.setState({ pages: [], hubless: true, error: undefined })
    const got = await Promise.allSettled(hubs.map(fromHub))
    const ok = got.flatMap((g) => (g.status === 'fulfilled' ? g.value : []))
    const failed = got.find((g): g is PromiseRejectedResult => g.status === 'rejected')
    // one hub out of reach keeps the others' pages; all of them out of reach is an error
    usePages.setState({ pages: ok, hubless: false, error: failed && !got.some((g) => g.status === 'fulfilled') ? (failed.reason as Error).message : undefined })
  } catch (e) {
    usePages.setState((s) => ({ pages: s.pages ?? [], error: (e as Error).message }))
  }
}

/** Remembers that a page was looked at now, so its changed mark goes. */
export function markSeen(p: Page, now = Date.now()) {
  const seen = { ...usePages.getState().seen, [p.id]: Math.max(now, changedAt(p)) }
  usePages.setState({ seen })
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {}
}

/** Takes a page off the list here at once (the hub is asked separately). */
export const dropPage = (id: string) => usePages.setState((s) => ({ pages: s.pages?.filter((p) => p.id !== id) ?? null }))

/** Mints a link for a page on its hub. */
export const openLink = (p: Pick<Page, 'host' | 'slug'>): Promise<PageOpen> => api.openPage(p.host, p.slug)

/** The machines a folder can be added on: each hub's own machine (other machines come later). */
export function pageHosts(): string[] {
  if (!isPhone()) return ['local']
  return listHubs().map((h) => hubHostId(h.id, 'local'))
}
