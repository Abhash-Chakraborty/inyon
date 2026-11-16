import { useEffect, useRef, useState } from 'react'
import type { ConversationHit, ConversationSearch, ConversationSearchMachine } from '@inyon/protocol'
import { api } from './api.ts'
import { hubHostId, listHubs, type PairedHub } from './hubs.ts'

/**
 * Searching saved conversations on every machine (from 0.28), for Quick access. The hub searches
 * its own machines; each paired hub is asked for its own, and the answers are put together here.
 */

/** Fewer characters than this aren't searched (the hub refuses them too). */
export const MIN_QUERY = 3
/** Typing settles for this long before a search goes out. */
export const SETTLE_MS = 350

/** One conversation found, with the machine it's on. */
export type FoundConversation = ConversationHit & { host: string; machine: string }

/** What the palette shows for the words typed so far. */
export type SearchState =
  | { status: 'idle'; q: string }
  /** too short to search */
  | { status: 'short'; q: string }
  /** `machines` keeps the last answer on screen while the next one comes */
  | { status: 'searching'; q: string; seq: number; machines?: ConversationSearchMachine[] }
  | { status: 'done'; q: string; seq: number; machines: ConversationSearchMachine[] }
  | { status: 'failed'; q: string; seq: number; error: string }

export const idle: SearchState = { status: 'idle', q: '' }

/** The words typed: a search goes out (`seq` names it), or nothing does. */
export function typed(state: SearchState, raw: string, seq: number): SearchState {
  const q = raw.trim().replace(/\s+/g, ' ')
  if (!q) return idle
  if ([...q].length < MIN_QUERY) return { status: 'short', q }
  const shown = state.status === 'done' ? state.machines : state.status === 'searching' ? state.machines : undefined
  return { status: 'searching', q, seq, machines: shown }
}

/** An answer arrived; one for words since changed is dropped. */
export function answered(state: SearchState, seq: number, r: { machines: ConversationSearchMachine[] } | { error: string }): SearchState {
  if (state.status !== 'searching' || state.seq !== seq) return state
  return 'error' in r ? { status: 'failed', q: state.q, seq, error: r.error } : { status: 'done', q: state.q, seq, machines: r.machines }
}

const newest = (m: ConversationSearchMachine) => m.hits[0]?.at ?? 0
const rank = (m: ConversationSearchMachine) => (m.skipped ? 3 : m.error ? 2 : m.hits.length ? 0 : 1)

/** Machines with the newest matches first, then those with none, then failed and skipped ones (as the hub orders them). */
export function mergeMachines(lists: ConversationSearchMachine[][]): ConversationSearchMachine[] {
  return lists
    .flat()
    .map((m) => ({ ...m, hits: [...m.hits].sort((a, b) => b.at - a.at) }))
    .sort((a, b) => rank(a) - rank(b) || newest(b) - newest(a) || a.name.localeCompare(b.name))
}

/** A paired hub's machines carry its id in front of theirs, so a pick goes back through that hub. */
export function fromHub(hub: PairedHub, r: ConversationSearch): ConversationSearchMachine[] {
  return r.machines.map((m) => ({ ...m, host: hubHostId(hub.id, m.host) }))
}

/** This hub's machines and every paired hub's; a hub that can't answer shows as one failed row. */
export async function searchEverywhere(q: string, hubs: PairedHub[] = listHubs()): Promise<ConversationSearchMachine[]> {
  const asks = [api.searchConversations(q).then((r) => r.machines), ...hubs.map((hub) => api.searchConversations(q, hub).then((r) => fromHub(hub, r)))]
  const all = await Promise.allSettled(asks)
  const failed = all.filter((r) => r.status === 'rejected')
  // nothing answered: say why rather than show an empty list
  if (failed.length === all.length) throw (failed[0] as PromiseRejectedResult).reason
  const lists = all.map((r, i): ConversationSearchMachine[] => {
    if (r.status === 'fulfilled') return r.value
    const hub = hubs[i - 1]
    return hub ? [{ host: hubHostId(hub.id, ''), name: hub.name, hits: [], error: (r.reason as Error).message }] : []
  })
  return mergeMachines(lists)
}

/** Every match in machine order, for moving through them with the arrow keys. */
export function flatHits(machines: ConversationSearchMachine[]): FoundConversation[] {
  return machines.flatMap((m) => m.hits.map((h) => ({ ...h, host: m.host, machine: m.name })))
}

/** The snippet in pieces, the searched-for words marked wherever they appear, in any case. */
export function highlight(text: string, q: string): { text: string; mark: boolean }[] {
  const words = q.trim()
  if (!words) return text ? [{ text, mark: false }] : []
  const lower = text.toLowerCase()
  const find = words.toLowerCase()
  const out: { text: string; mark: boolean }[] = []
  let at = 0
  // lowercasing can change a string's length (İ), so only mark where the lengths agree
  const same = lower.length === text.length
  while (same) {
    const i = lower.indexOf(find, at)
    if (i < 0) break
    if (i > at) out.push({ text: text.slice(at, i), mark: false })
    out.push({ text: text.slice(i, i + find.length), mark: true })
    at = i + find.length
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false })
  return out
}

/** Whether a found conversation can be opened again: the agent needs the folder it ran in. */
export const canResume = (h: ConversationHit) => !!h.cwd

/** Starts the agent on the conversation in a new session in its folder; the new pane's id. */
export async function resumeHit(h: FoundConversation): Promise<string> {
  const { pane } = await api.launch(h.host, { agent: h.agent, cwd: h.cwd, resume: h.id })
  return pane
}

/** A terminal in the conversation's folder; the new pane's id. */
export async function openFolder(h: FoundConversation): Promise<string> {
  const { pane } = await api.launch(h.host, { agent: 'shell', cwd: h.cwd })
  return pane
}

/**
 * The search for what's typed while `active`: it waits for typing to settle, keeps the last
 * answer on screen while the next one comes, and drops answers for words since changed.
 * `now` searches at once (Enter).
 */
export function useConversationSearch(q: string, active: boolean, search: (q: string) => Promise<ConversationSearchMachine[]> = searchEverywhere) {
  const [state, setState] = useState<SearchState>(idle)
  const seq = useRef(0)
  const waiting = useRef<ReturnType<typeof setTimeout>>(undefined)
  const run = useRef<(now: boolean) => void>(() => {})
  run.current = (now) => {
    clearTimeout(waiting.current)
    const n = ++seq.current
    const next = typed(state, q, n)
    setState(next)
    if (next.status !== 'searching') return
    waiting.current = setTimeout(
      () =>
        void search(next.q).then(
          (machines) => setState((s) => answered(s, n, { machines })),
          (e: Error) => setState((s) => answered(s, n, { error: e.message })),
        ),
      now ? 0 : SETTLE_MS,
    )
  }
  useEffect(() => {
    if (!active) return
    run.current(false)
    return () => clearTimeout(waiting.current)
  }, [q, active])
  return { state, now: () => run.current(true) }
}
