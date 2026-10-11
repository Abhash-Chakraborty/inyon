import { kv } from '../platform/store.ts'

/**
 * Names you gave agent sessions in Tether, keyed by machine and conversation id, so a name
 * follows the conversation through resumes and pane changes. `was` keeps the agent's own title
 * from before the first rename, since renaming also renames the conversation inside the agent.
 *
 * Agents that keep their own title (Claude, Codex, agy) are the record: a rename waits here as
 * `pending` until the agent has taken it, and from then on the agent's title is what shows, on
 * this hub, in the phone app and in the agent's resume picker alike. A rename made elsewhere
 * (another app, /rename at the keyboard) wins the same way. Other agents keep the name here.
 */
type Entry = { name: string; was?: string; pending?: boolean; clear?: boolean }
const names = new Map<string, Entry>(Object.entries(kv.get<Record<string, string | Entry>>('names') ?? {}).map(([k, v]) => [k, typeof v === 'string' ? { name: v } : v]))

const k = (host: string, session: string) => `${host} ${session}`
const save = () => kv.set('names', Object.fromEntries(names))

/** Agents with a title of their own that /rename sets. */
export const ownsTitle = (kind?: string) => kind === 'claude' || kind === 'codex' || kind === 'antigravity'

/** The name to show over the agent's own title, if any. */
export function sessionName(host: string, session?: string, kind?: string) {
  const e = session ? names.get(k(host, session)) : undefined
  if (!e) return undefined
  return !ownsTitle(kind) || e.pending ? e.name : undefined
}

/** The agent's own title from before Tether renamed it, if Tether did. */
export function originalTitle(host: string, session: string) {
  return names.get(k(host, session))?.was
}

/** A rename the agent hasn't taken yet. */
export function pendingName(host: string, session?: string) {
  const e = session ? names.get(k(host, session)) : undefined
  return e?.pending ? e : undefined
}

/**
 * Names a session. For an agent with its own title the name waits until the agent has it; an
 * empty name goes back to the title the agent had made up (`was`), and is then forgotten.
 */
export function setSessionName(host: string, session: string, name: string, was?: string, kind?: string) {
  const prev = names.get(k(host, session))
  const before = prev?.was ?? was
  if (ownsTitle(kind)) {
    if (name) names.set(k(host, session), { name, was: before, pending: true })
    else if (before) names.set(k(host, session), { name: before, was: before, pending: true, clear: true })
    else names.delete(k(host, session))
  } else if (name) names.set(k(host, session), { name, was: before })
  else names.delete(k(host, session))
  save()
}

/** The agent now shows the pending name: its title is the record from here on. */
export function nameTaken(host: string, session: string) {
  const e = names.get(k(host, session))
  if (!e?.pending) return
  if (e.clear) names.delete(k(host, session))
  else names.set(k(host, session), { name: e.name, was: e.was })
  save()
}

/** The title an agent shows, without the activity mark Claude puts in front ("✳ ", "⠂ "). */
export const bareTitle = (title?: string) => (title ?? '').replace(/^[^\p{L}\p{N}"'(]+\s/u, '').trim()
