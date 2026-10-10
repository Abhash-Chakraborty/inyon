import { kv } from '../platform/store.ts'

/**
 * Names you gave agent sessions in Tether, keyed by machine and conversation id, so a name
 * follows the conversation through resumes and pane changes. `was` keeps the agent's own title
 * from before the first rename, since renaming also renames the conversation inside the agent.
 */
type Entry = { name: string; was?: string }
const names = new Map<string, Entry>(Object.entries(kv.get<Record<string, string | Entry>>('names') ?? {}).map(([k, v]) => [k, typeof v === 'string' ? { name: v } : v]))

const k = (host: string, session: string) => `${host} ${session}`

export function sessionName(host: string, session?: string) {
  return session ? names.get(k(host, session))?.name : undefined
}

/** The agent's own title from before Tether renamed it, if Tether did. */
export function originalTitle(host: string, session: string) {
  return names.get(k(host, session))?.was
}

export function setSessionName(host: string, session: string, name: string, was?: string) {
  const prev = names.get(k(host, session))
  if (name) names.set(k(host, session), { name, was: prev?.was ?? was })
  else names.delete(k(host, session))
  kv.set('names', Object.fromEntries(names))
}
