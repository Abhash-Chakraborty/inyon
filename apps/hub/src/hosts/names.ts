import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.ts'

/**
 * Names you gave agent sessions in Tether, keyed by machine and conversation id, so a name
 * follows the conversation through resumes and pane changes. `was` keeps the agent's own title
 * from before the first rename, since renaming also renames the conversation inside the agent.
 */
const FILE = path.join(DATA_DIR, 'names.json')
type Entry = { name: string; was?: string }
const names = new Map<string, Entry>(Object.entries(read()).map(([k, v]) => [k, typeof v === 'string' ? { name: v } : v]))

function read(): Record<string, string | Entry> {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    return {}
  }
}

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
  fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(names), null, 2), { mode: 0o600 })
}
