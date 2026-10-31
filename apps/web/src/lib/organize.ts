import type { Organize, SessionMark } from '@inyon/protocol'
import { matchesQuery, searchText } from './groups.ts'
import type { PaneRef } from './overview.ts'

/**
 * How sessions are organised (from 0.24): pins, parking, snoozes, tags and notes. The hub keeps it
 * (each hub its own), so the phone, the browser and the desktop app show the same order; this is
 * the app's side of it. The same rules as inyon-chat-core's organize.rs.
 */

export const NO_ORGANIZE: Organize = { v: 0, sessions: [], projects: [], groups: [], spaces: [] }

/** A paired hub's marks and project folders, with its machines renamed to carry the hub's id. */
export function renameOrganize(o: Organize, name: (id: string) => string): Organize {
  return {
    ...o,
    sessions: (o.sessions ?? []).map((m) => ({ ...m, host: name(m.host) })),
    projects: (o.projects ?? []).map((p) => ({ ...p, roots: (p.roots ?? []).map((r) => ({ ...r, host: name(r.host) })) })),
  }
}

/** Every hub's, as one: the main hub's first, then each paired hub's. */
export function mergeOrganize(list: (Organize | undefined)[]): Organize {
  const all = list.filter((o): o is Organize => !!o)
  if (all.length === 1) return all[0]!
  return {
    v: Math.max(0, ...all.map((o) => o.v ?? 0)),
    sessions: all.flatMap((o) => o.sessions ?? []),
    projects: all.flatMap((o) => o.projects ?? []),
    groups: all.flatMap((o) => o.groups ?? []),
    spaces: all.flatMap((o) => o.spaces ?? []),
  }
}

/** The mark on a pane: only one the hub matched to it now, as a pane id can be handed out again. */
export function markFor(org: Organize, host: string, pane: string): SessionMark | undefined {
  return org.sessions?.find((m) => m.live && m.host === host && m.pane === pane)
}

/** Snoozed until a time still ahead (the hub clears it once it's past, within a few seconds). */
export const isSnoozed = (m: SessionMark | undefined, now = Date.now()) => !!m?.snoozedUntil && m.snoozedUntil > now

export type Place = 'pinned' | 'sessions' | 'snoozed' | 'parked'

/** Where a session shows: a snoozed one is out of the way even when pinned or parked as well. */
export function placeOf(m: SessionMark | undefined, now = Date.now()): Place {
  if (isSnoozed(m, now)) return 'snoozed'
  if (m?.parked) return 'parked'
  if (m?.pinned !== undefined) return 'pinned'
  return 'sessions'
}

/** The next snooze to end, so a screen can show the session again right then. */
export function nextWake(org: Organize, now = Date.now()): number | undefined {
  const times = (org.sessions ?? []).filter((m) => m.live && isSnoozed(m, now)).map((m) => m.snoozedUntil!)
  return times.length ? Math.min(...times) : undefined
}

/** A search finds a session by its tags and note too. */
export const organizedSearchText = (r: PaneRef, m: SessionMark | undefined) => [searchText(r), ...(m?.tags ?? []).map((t) => `#${t} ${t}`), m?.note ?? ''].join(' ')

export interface Sorted {
  /** in the order they were pinned in */
  pinned: PaneRef[]
  /** everything else, in the order given */
  sessions: PaneRef[]
  /** parked and snoozed, folded away: the snoozed first, the soonest to wake first */
  folded: PaneRef[]
}

/** Panes in the overview's sections. `query` matches as the search box does, tags and note included. */
export function sortPanes(refs: PaneRef[], org: Organize, o: { now?: number; query?: string } = {}): Sorted {
  const now = o.now ?? Date.now()
  const out: Sorted = { pinned: [], sessions: [], folded: [] }
  const marks = new Map<PaneRef, SessionMark | undefined>()
  for (const r of refs) {
    const m = markFor(org, r.host.config.id, r.pane.id)
    if (o.query && !matchesQuery(organizedSearchText(r, m), o.query)) continue
    marks.set(r, m)
    const at = placeOf(m, now)
    if (at === 'pinned') out.pinned.push(r)
    else if (at === 'sessions') out.sessions.push(r)
    else out.folded.push(r)
  }
  out.pinned.sort((a, b) => marks.get(a)!.pinned! - marks.get(b)!.pinned!)
  const wake = (r: PaneRef) => (isSnoozed(marks.get(r), now) ? marks.get(r)!.snoozedUntil! : Infinity)
  out.folded.sort((a, b) => wake(a) - wake(b))
  return out
}

export type SnoozeFor = 'hour' | 'threeHours' | 'tomorrow' | 'nextWeek'

export const SNOOZE_CHOICES: { v: SnoozeFor; label: string }[] = [
  { v: 'hour', label: 'For an hour' },
  { v: 'threeHours', label: 'For three hours' },
  { v: 'tomorrow', label: 'Until tomorrow morning' },
  { v: 'nextWeek', label: 'Until next week' },
]

/** When a snooze ends, by this device's clock: mornings are 9:00 here, a week starts on Monday. */
export function snoozeUntil(p: SnoozeFor, now = new Date()): number {
  if (p === 'hour') return now.getTime() + 3600_000
  if (p === 'threeHours') return now.getTime() + 3 * 3600_000
  const d = new Date(now)
  d.setHours(9, 0, 0, 0)
  // Monday is 1; from a Monday, the next one
  const days = p === 'tomorrow' ? 1 : ((8 - d.getDay()) % 7) || 7
  d.setDate(d.getDate() + days)
  return d.getTime()
}

/** "until 9:00", or with the day when it isn't today: "until Mon 9:00". */
export function wakeText(at: number, now = new Date()) {
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === now.toDateString() ? `until ${time}` : `until ${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** Tags as typed in one box ("review, #needs docs"), each as the hub keeps it. */
export function parseTags(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(',')) {
    const t = raw.trim().replace(/^#+/, '').replace(/\s+/g, ' ').toLowerCase()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}
