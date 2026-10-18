import { Host, shq } from '../hosts/host.ts'

/**
 * OpenCode started without --port has no HTTP server: its TUI talks to its engine in-process.
 * What it does still lands in its SQLite database (session, message, part, todo), as the same
 * JSON its server API returns, so Inyon reads that. Read-only, and only those tables: the same
 * file holds account tokens, which are never queried.
 *
 * Every query asks SQLite for its rows as one JSON array (json_group_array), printed as is:
 * sqlite3's own JSON output mode took minutes on a message holding a megabyte of diff, and the
 * reader gave up at its 15 s limit, so the chat stayed empty. sqlite3 answers in a few ms;
 * Python's sqlite3 module is the fallback, `opencode db` (2-3 s per call) the last resort.
 */
/** where OpenCode installs itself (the hub's own PATH is minimal) */
export const OC_PATH = 'export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"'

const SCRIPT = `
db="\${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db"
[ -f "$db" ] || { echo '@@NODB'; exit 0; }
if command -v sqlite3 >/dev/null 2>&1 && out=$(sqlite3 -readonly -noheader -list "$db" "$Q" 2>/dev/null); then printf '%s' "$out"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c 'import sqlite3,sys
c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)
print(c.execute(sys.argv[2]).fetchone()[0])' "$db" "$Q"
else ${OC_PATH}; opencode db "$Q" --format json 2>/dev/null; fi
`

/** The rows of `from` as one JSON array built by SQLite, with these columns. */
export const jsonRows = (columns: string[], from: string) =>
  `select json_group_array(json_object(${columns.map((c) => `'${c}', ${c}`).join(', ')})) as rows from (${from})`

export const OCDB = 'opencode-db:'
const SESSION_ID = /^ses_[A-Za-z0-9]+$/
export const isOcdb = (uri?: string) => !!uri?.startsWith(OCDB)
export const ocdbSession = (uri: string) => {
  const id = uri.slice(OCDB.length)
  return SESSION_ID.test(id) ? id : undefined
}

/** Runs a `jsonRows` query and returns its rows. */
export async function ocdbQuery(host: Host, sql: string): Promise<any[]> {
  const r = await host.exec(`Q=${shq(sql)}\n${SCRIPT}`, { timeoutMs: 15_000 })
  const out = r.stdout.trim()
  if (!out || out === '@@NODB') return []
  try {
    let rows = JSON.parse(out)
    // `opencode db` prints the query's result set: one row whose `rows` column holds the array
    if (Array.isArray(rows) && rows.length === 1 && typeof rows[0]?.rows === 'string') rows = JSON.parse(rows[0].rows)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`

export interface OcdbSessionRow {
  id: string
  title: string
  directory: string
  parent_id: string | null
  time_created: number
  time_updated: number
  agent: string | null
  model: string | null
}

/** Top-level conversations in a folder, newest activity first. */
export async function ocdbSessions(host: Host, directory: string, limit = 30): Promise<OcdbSessionRow[]> {
  const rows: OcdbSessionRow[] = await ocdbQuery(host, jsonRows(['id', 'title', 'directory', 'parent_id', 'time_created', 'time_updated', 'agent', 'model'], `select id, title, directory, parent_id, time_created, time_updated, agent, model from session where directory = ${quote(directory)} and parent_id is null and time_archived is null order by time_updated desc limit ${limit}`))
  return rows.sort((a, b) => b.time_updated - a.time_updated)
}

/**
 * The conversation an OpenCode TUI shows. Its terminal title names it, `-s <id>` too; otherwise it's the folder's
 * conversation whose title is on screen (the TUI prints it), else the one that has moved since
 * the process started. A TUI that hasn't sent anything yet has none: "opencode-db:" alone.
 */
export async function guessOpenCodeSession(host: Host, proc: { cwd?: string; startedAt: number; args?: string }, screen?: string[], paneTitle?: string): Promise<string | undefined> {
  if (!proc.cwd) return undefined
  const args = proc.args ?? ''
  // the TUI sets the terminal title to "OC | <conversation title>", or "OpenCode" on its home screen
  if (paneTitle?.trim() === 'OpenCode') return OCDB
  const rows = await ocdbSessions(host, proc.cwd)
  const shown = paneTitle?.match(/^OC \| (.+)$/)?.[1]?.trim()
  const named = shown ? rows.filter((r) => r.title === shown) : []
  if (named.length) return OCDB + named[0].id
  const explicit = args.match(/(?:^|\s)(?:-s|--session)[=\s](ses_[A-Za-z0-9]+)/)?.[1]
  if (explicit) return OCDB + explicit
  const text = screen?.join('\n') ?? ''
  const titled = rows.filter((r) => r.title && r.title.length >= 6 && !/^New session - /.test(r.title) && text.includes(r.title.slice(0, 40)))
  if (titled.length === 1) return OCDB + titled[0].id
  const since = rows.filter((r) => r.time_updated >= proc.startedAt * 1000 - 5000)
  if (since.length) return OCDB + since[0].id
  // `-c` continues the folder's latest conversation
  if (/(?:^|\s)(?:-c|--continue)(?:\s|$)/.test(args) && rows[0]) return OCDB + rows[0].id
  return OCDB
}

/** Change marker: the newest write to the conversation's messages or parts. */
export async function ocdbStamp(host: Host, session: string): Promise<number> {
  if (!SESSION_ID.test(session)) return 0
  const rows = await ocdbQuery(host, jsonRows(['t'], `select max(t) as t from (select max(time_updated) as t from message where session_id = ${quote(session)} union all select max(time_updated) from part where session_id = ${quote(session)} union all select time_updated from session where id = ${quote(session)})`))
  return Number(rows[0]?.t) || 0
}

/**
 * A message's `summary` is the turn's whole diff (megabytes after a lock file changed), and
 * nothing here shows it: it stays in the database.
 */
const DATA = `case when json_valid(data) then json_remove(data, '$.summary') else data end as data`

/**
 * Messages in the server API's shape ({info, parts}[]). `since` fetches only rows written after
 * it; callers merge them into what they already hold.
 */
export async function ocdbRows(host: Host, session: string, since = 0) {
  if (!SESSION_ID.test(session)) return { messages: [] as any[], parts: [] as any[] }
  const s = quote(session)
  const [messages, parts] = await Promise.all([
    ocdbQuery(host, jsonRows(['id', 'time_created', 'time_updated', 'data'], `select id, time_created, time_updated, ${DATA} from message where session_id = ${s} and time_updated >= ${Math.floor(since)} order by time_created, id`)),
    ocdbQuery(host, jsonRows(['id', 'message_id', 'time_created', 'time_updated', 'data'], `select id, message_id, time_created, time_updated, data from part where session_id = ${s} and time_updated >= ${Math.floor(since)} order by time_created, id`)),
  ])
  return { messages, parts }
}

/**
 * What's still in the conversation: the message ids, and where /undo moved it back to (messages
 * from that one on are hidden until /redo, and deleted once a new message is sent).
 */
export async function ocdbShape(host: Host, session: string): Promise<{ ids: Set<string>; revert?: string }> {
  if (!SESSION_ID.test(session)) return { ids: new Set() }
  const [ids, [row]] = await Promise.all([
    ocdbQuery(host, jsonRows(['id'], `select id from message where session_id = ${quote(session)}`)),
    ocdbQuery(host, jsonRows(['revert'], `select revert from session where id = ${quote(session)}`)),
  ])
  let revert: string | undefined
  try { revert = row?.revert ? JSON.parse(row.revert)?.messageID : undefined } catch {}
  return { ids: new Set(ids.map((r) => r.id)), revert }
}

/** What the session row says about the conversation as a whole: its title, cost, lines changed and share link. */
export interface OcdbSessionInfo {
  title?: string
  cost?: number
  additions?: number
  deletions?: number
  files?: number
  share?: string
}

export async function ocdbSessionInfo(host: Host, session: string): Promise<OcdbSessionInfo | undefined> {
  if (!SESSION_ID.test(session)) return undefined
  const [r] = await ocdbQuery(host, jsonRows(['title', 'cost', 'summary_additions', 'summary_deletions', 'summary_files', 'share_url'], `select title, cost, summary_additions, summary_deletions, summary_files, share_url from session where id = ${quote(session)}`))
  return r ? { title: r.title ?? undefined, cost: typeof r.cost === 'number' ? r.cost : undefined, additions: r.summary_additions ?? undefined, deletions: r.summary_deletions ?? undefined, files: r.summary_files ?? undefined, share: r.share_url ?? undefined } : undefined
}

/** Keeps a conversation's rows by id and rebuilds the API-shaped list after each merge. */
export class OcdbCache {
  private messages = new Map<string, any>()
  private parts = new Map<string, any>()
  /** newest time_updated merged so far (a row without one leaves it as it was) */
  stamp = 0
  merge(rows: { messages: any[]; parts: any[] }) {
    for (const m of rows.messages) {
      try { this.messages.set(m.id, { ...JSON.parse(m.data), id: m.id, time: { created: m.time_created, ...JSON.parse(m.data).time } }) } catch {}
      if (typeof m.time_updated === 'number') this.stamp = Math.max(this.stamp, m.time_updated)
    }
    for (const p of rows.parts) {
      try { this.parts.set(p.id, { ...JSON.parse(p.data), id: p.id, messageID: p.message_id, _t: p.time_created }) } catch {}
      if (typeof p.time_updated === 'number') this.stamp = Math.max(this.stamp, p.time_updated)
    }
  }
  /** drops rows whose message is gone */
  retain(ids: Set<string>) {
    for (const id of this.messages.keys()) if (!ids.has(id)) this.messages.delete(id)
    for (const [id, p] of this.parts) if (!ids.has(p.messageID)) this.parts.delete(id)
  }
  list(revert?: string) {
    const byMsg = new Map<string, any[]>()
    for (const p of this.parts.values()) {
      const arr = byMsg.get(p.messageID) ?? []
      arr.push(p)
      byMsg.set(p.messageID, arr)
    }
    return [...this.messages.values()]
      .filter((m) => !revert || String(m.id) < revert)
      .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0) || String(a.id).localeCompare(String(b.id)))
      .map((info) => ({ info, parts: (byMsg.get(info.id) ?? []).sort((a, b) => a._t - b._t || String(a.id).localeCompare(String(b.id))) }))
  }
}
