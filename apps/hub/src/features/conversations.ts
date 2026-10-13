import { AGENTS, type AgentKind, type PastConversation } from '@inyon/protocol'
import { shq, type Host } from '../hosts/host.ts'
import { HttpError, registry } from '../hosts/registry.ts'
import { sessionName } from '../hosts/names.ts'
import { claudeSlug } from '../tmux/tmux.ts'
import { ocdbSessions } from '../agents/opencode-db.ts'
import { exitAgent, isSessionId, shellReady, typeStart } from '../claude/actions.ts'

/**
 * Past conversations of an agent in one folder, for the app's own picker: the agents' /resume
 * menus only work in their terminal. Everything is read on the machine through `host.exec`, so it
 * works the same for this machine, an SSH server, a joined machine or a phone's direct link.
 * Transcripts run to hundreds of megabytes, so only file times, the first lines and the last
 * stretch of each file are read, never a whole transcript.
 */

/** Agents whose conversations Inyon can list and reopen by id. */
export const listsConversations = (kind?: AgentKind): boolean => !!kind && !!AGENTS[kind]?.conversations?.length

const LIMIT = 50
const TITLE = 200
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

/**
 * A JSON string's text from `start` (just past its opening quote) to its closing quote, or to the
 * end of `s` when the line was cut short on the machine.
 */
export function jsonStringAt(s: string, start: number) {
  let out = ''
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (c === '"') return out
    if (c !== '\\') {
      out += c
      continue
    }
    const n = s[++i]
    if (n === undefined) break
    if (n === 'u') {
      const hex = s.slice(i + 1, i + 5)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break
      out += String.fromCharCode(parseInt(hex, 16))
      i += 4
    } else out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[n] ?? n
  }
  return out
}

/** The value of the first `"key":"…"` in a line of JSON, which may be cut short. */
export function field(line: string, key: string) {
  const at = line.indexOf(`"${key}":"`)
  return at < 0 ? undefined : jsonStringAt(line, at + key.length + 4)
}

/** A prompt as a one-line title: no tags the agent wrapped around it, no runs of spaces. */
export function oneLine(text: string) {
  return text
    .replace(/<(system-reminder|local-command-caveat)>[\s\S]*?(<\/\1>|$)/g, ' ')
    .replace(/<\/?[a-z][\w-]*(\s[^>]*)?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE)
}

const mtimeOf = (f: string) => `"$(stat -c %Y ${f} 2>/dev/null || stat -f %m ${f} 2>/dev/null)"`

// ---------- Claude Code ----------

/**
 * ~/.claude/projects/<folder>/<id>.jsonl. A /rename is written as a "custom-title" line and Claude
 * names each conversation itself ("ai-title"); both are repeated as it goes on, so the last part
 * of the file has the latest. The first prompt is near the top, after a few bookkeeping lines.
 */
export function claudeScript(cwd: string) {
  return `cd "$HOME/.claude/projects/"${shq(claudeSlug(cwd))} 2>/dev/null || exit 0
ls -t -- *.jsonl 2>/dev/null | head -n 80 | while IFS= read -r f; do
  printf '\\036%s\\t%s\\n' ${mtimeOf('"$f"')} "$f"
  echo '@@T'; tail -c 262144 "$f" 2>/dev/null | grep -E '"type":"(custom-title|ai-title)"' | tail -n 12 | cut -c1-1200
  echo '@@U'; head -c 131072 "$f" 2>/dev/null | grep -F '"type":"user"' | head -n 8 | cut -c1-2400
done`
}

/** The user's own words in a Claude "user" line, or nothing for a command, a tool result or the like. */
function claudePrompt(line: string) {
  if (!/"type":"user"/.test(line) || /"isMeta":true|"isSidechain":true/.test(line)) return
  const at = line.indexOf('"content":', line.indexOf('"message":'))
  if (at < 0) return
  const rest = line.slice(at + 10)
  let text: string | undefined
  if (rest.startsWith('"')) text = jsonStringAt(rest, 1)
  else if (/^\[\{"type":"text"/.test(rest)) text = field(rest, 'text')
  if (!text || /<(command-name|local-command-stdout|local-command-stderr)>|^\s*Caveat:/.test(text)) return
  return oneLine(text) || undefined
}

export function parseClaude(stdout: string): PastConversation[] {
  const out: PastConversation[] = []
  for (const block of stdout.split('\x1e').slice(1)) {
    const [head, ...lines] = block.split('\n')
    const [t, file] = head.split('\t')
    const id = file?.replace(/\.jsonl$/, '')
    if (!id || !UUID.test(id)) continue
    let section = ''
    let custom: string | undefined
    let ai: string | undefined
    let prompt: string | undefined
    for (const l of lines) {
      if (l === '@@T' || l === '@@U') section = l
      else if (section === '@@T') {
        if (/^\{"type":"custom-title"/.test(l)) custom = field(l, 'customTitle') ?? custom
        else if (/^\{"type":"ai-title"/.test(l)) ai = field(l, 'aiTitle') ?? ai
      } else if (section === '@@U' && !prompt) prompt = claudePrompt(l)
    }
    // nothing was said: Claude's own picker leaves these out, and they can't be resumed
    const title = oneLine(custom ?? '') || oneLine(ai ?? '') || prompt
    if (title) out.push({ id, title, at: Number(t) * 1000 || 0 })
  }
  return out
}

// ---------- Codex ----------

/**
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl, whose first line (session_meta)
 * names the folder; newest first, until enough are in this folder. Only threads Codex's own picker
 * shows (started in its terminal or editor, not `codex exec` or a subagent). Names are in
 * session_index.jsonl, the latest line for a thread winning.
 */
export function codexScript(cwd: string) {
  const pat = `"cwd":${JSON.stringify(cwd)}`
  return `r="\${CODEX_HOME:-$HOME/.codex}"; s="$r/sessions"
[ -d "$s" ] || exit 0
p=${shq(pat)}
if find "$s" -maxdepth 0 -printf '' >/dev/null 2>&1; then find "$s" -name 'rollout-*.jsonl' -printf '%T@\\t%p\\n' 2>/dev/null
else find "$s" -name 'rollout-*.jsonl' 2>/dev/null | while IFS= read -r f; do printf '%s\\t%s\\n' ${mtimeOf('"$f"')} "$f"; done; fi | sort -rn | head -n 2000 | {
n=0
while IFS='	' read -r t f; do
  h=$(head -c 4000 "$f" 2>/dev/null | head -n 1)
  case "$h" in *"$p"*) ;; *) continue;; esac
  case "$h" in *'"source":"cli"'*|*'"source":"vscode"'*) ;; *'"source":'*) continue;; esac
  printf '\\036%s\\t%s\\n' "\${t%.*}" "$f"
  head -c 262144 "$f" 2>/dev/null | grep -F '"role":"user"' | grep -v -E '"text":"[[:space:]]*<(environment_context|user_instructions|user_shell_command|codex_internal_context)' | head -n 1 | cut -c1-2400
  n=$((n+1)); [ $n -ge 80 ] && break
done; }
printf '\\036@@INDEX\\n'; tail -n 4000 "$r/session_index.jsonl" 2>/dev/null`
}

export function parseCodex(stdout: string): PastConversation[] {
  const blocks = stdout.split('\x1e').slice(1)
  const names = new Map<string, string>()
  const index = blocks.find((b) => b.startsWith('@@INDEX'))
  for (const l of index?.split('\n') ?? []) {
    try {
      const e = JSON.parse(l)
      if (e.id && e.thread_name) names.set(e.id, e.thread_name)
    } catch {}
  }
  const seen = new Map<string, PastConversation>()
  for (const block of blocks) {
    if (block.startsWith('@@INDEX')) continue
    const [head, line = ''] = block.split('\n')
    const [t, path] = head.split('\t')
    // "rollout-<time>-<thread>.jsonl", or "…-<thread>_<segment>.jsonl" after a rewind
    const m = path?.split('/').pop()?.match(new RegExp(`-(${UUID.source})(_${UUID.source})?\\.jsonl$`))
    if (!m) continue
    const id = m[1]
    const prompt = oneLine(field(line, 'text') ?? '')
    const was = seen.get(id)
    const at = Number(t) * 1000 || 0
    // a segment starts partway through: the thread's first file has the prompt it began with
    if (was) {
      was.at = Math.max(was.at, at)
      if (prompt && (!was.title || !m[2])) was.title = prompt
    } else seen.set(id, { id, title: prompt, at })
  }
  return [...seen.values()]
    .map((c) => ({ ...c, title: oneLine(names.get(c.id) ?? '') || c.title }))
    .filter((c) => c.title)
}

// ---------- GitHub Copilot ----------

/**
 * ~/.copilot/session-state/<id>/: workspace.yaml has the folder and the session's name (Copilot
 * names it from the first prompt, or /rename does); events.jsonl is written as it goes, so its
 * time is the last activity. Without a workspace.yaml, the first event names the folder.
 */
export function copilotScript() {
  return `s="$HOME/.copilot/session-state"
[ -d "$s" ] || exit 0
ls -t -- "$s"/*/events.jsonl 2>/dev/null | head -n 400 | while IFS= read -r f; do
  d=\${f%/events.jsonl}
  printf '\\036%s\\t%s\\n' ${mtimeOf('"$f"')} "\${d##*/}"
  if [ -f "$d/workspace.yaml" ]; then grep -E '^(cwd|name):' "$d/workspace.yaml" | cut -c1-1200; else head -c 4000 "$f" | head -n 1; fi
  grep -qs '^name:' "$d/workspace.yaml" || head -c 131072 "$f" 2>/dev/null | grep -F '"type":"user.message"' | head -n 1 | cut -c1-2400
done`
}

/** A one-line YAML scalar: plain, 'single' or "double" quoted. */
export function yamlScalar(v: string) {
  const s = v.trim()
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s) as string
    } catch {
      return jsonStringAt(s, 1)
    }
  }
  if (s.startsWith("'")) return s.slice(1, s.endsWith("'") && s.length > 1 ? -1 : undefined).replace(/''/g, "'")
  return s.replace(/\s+#.*$/, '')
}

export function parseCopilot(stdout: string, cwd: string): PastConversation[] {
  const out: PastConversation[] = []
  for (const block of stdout.split('\x1e').slice(1)) {
    const [head, ...lines] = block.split('\n')
    const [t, id] = head.split('\t')
    if (!id || !UUID.test(id)) continue
    let dir: string | undefined
    let name: string | undefined
    let prompt: string | undefined
    for (const l of lines) {
      if (l.startsWith('cwd:')) dir = yamlScalar(l.slice(4))
      else if (l.startsWith('name:')) name = yamlScalar(l.slice(5))
      else if (l.includes('"type":"session.start"')) dir = field(l, 'cwd')
      else if (l.includes('"type":"user.message"')) prompt ??= field(l, 'content')
    }
    if (dir !== cwd) continue
    const title = oneLine(name ?? '') || oneLine(prompt ?? '')
    if (title) out.push({ id, title, at: Number(t) * 1000 || 0 })
  }
  return out
}

// ---------- SQLite (OpenCode, Antigravity) ----------

/** Rows of a read-only query on a database on the machine: sqlite3, else Python's sqlite3. */
export async function sqliteRows(host: Host, db: string, sql: string): Promise<any[]> {
  const r = await host.exec(
    `db=${db}; Q=${shq(sql)}
[ -f "$db" ] || exit 0
if command -v sqlite3 >/dev/null 2>&1 && out=$(sqlite3 -readonly -json "$db" "$Q" 2>/dev/null); then printf '%s' "$out"
elif command -v python3 >/dev/null 2>&1; then python3 -c 'import sqlite3,json,sys
c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)
c.row_factory=sqlite3.Row
print(json.dumps([dict(r) for r in c.execute(sys.argv[2])]))' "$db" "$Q"; fi`,
    { timeoutMs: 15_000 },
  )
  try {
    const rows = JSON.parse(r.stdout.trim() || '[]')
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`

/** "2026-10-11 08:22:33.43735957+00:00", as agy's database writes times. */
export const agyTime = (s: unknown) => Date.parse(String(s ?? '').replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1')) || 0

/**
 * agy keeps a summary of each conversation (title, first prompt as "preview", the folders it
 * worked in) in ~/.gemini/antigravity-cli/conversation_summaries.db. Subagents' conversations
 * are left out.
 */
export async function agyConversations(host: Host, cwd: string, limit = LIMIT): Promise<PastConversation[]> {
  const uris = [...new Set([`file://${cwd}`, `file://${encodeURI(cwd)}`])]
  const match = uris.map((u) => `instr(workspace_uris, ${sqlText(JSON.stringify(u))}) > 0`).join(' or ')
  const rows = await sqliteRows(
    host,
    '"$HOME/.gemini/antigravity-cli/conversation_summaries.db"',
    `select conversation_id as id, title, preview, last_modified_time as t, workspace_uris as w from conversation_summaries where parent_conversation_id = '' and nesting_depth = 0 and (${match}) order by last_modified_time desc limit ${limit}`,
  )
  return rows.flatMap((r) => {
    let dirs: string[] = []
    try {
      dirs = (JSON.parse(r.w) as string[]).map((u) => decodeURI(u.replace(/^file:\/\//, '')))
    } catch {}
    const id = String(r.id ?? '')
    const title = oneLine(String(r.title || r.preview || ''))
    return dirs.includes(cwd) && isSessionId(id, 'antigravity') && title ? [{ id, title, at: agyTime(r.t) }] : []
  })
}

async function opencodeConversations(host: Host, cwd: string, limit = LIMIT): Promise<PastConversation[]> {
  const rows = await ocdbSessions(host, cwd, limit)
  return rows.flatMap((r) => (isSessionId(r.id, 'opencode') && r.id ? [{ id: r.id, title: oneLine(r.title ?? '') || 'Untitled', at: Number(r.time_updated) || 0 }] : []))
}

// ---------- all agents ----------

/** The agent's past conversations in `cwd` on the machine, newest first. */
export async function listConversations(host: Host, kind: AgentKind, cwd: string, limit = LIMIT): Promise<PastConversation[]> {
  let list: PastConversation[]
  if (kind === 'claude') list = parseClaude((await host.exec(claudeScript(cwd), { timeoutMs: 30_000 })).stdout)
  else if (kind === 'codex') list = parseCodex((await host.exec(codexScript(cwd), { timeoutMs: 30_000 })).stdout)
  else if (kind === 'copilot') list = parseCopilot((await host.exec(copilotScript(), { timeoutMs: 30_000 })).stdout, cwd)
  else if (kind === 'opencode') list = await opencodeConversations(host, cwd, limit)
  else if (kind === 'antigravity') list = await agyConversations(host, cwd, limit)
  else throw new HttpError(400, `Inyon can't list ${AGENTS[kind as AgentKind]?.name ?? 'this agent'}'s conversations`)
  return list.filter((c) => isSessionId(c.id, kind) && c.id).sort((a, b) => b.at - a.at).slice(0, limit)
}

/** Which agent a pane's conversations are for: the one running there, else the one asked for. */
function paneAgent(hostId: string, paneId: string, asked?: unknown) {
  const found = registry.findPane(hostId, paneId)
  if (!found) throw new HttpError(404, 'Pane not found')
  const running = found.pane.agent?.kind
  if (asked !== undefined && asked !== '' && (typeof asked !== 'string' || !Object.hasOwn(AGENTS, asked))) throw new HttpError(400, 'Unknown agent')
  const kind = running ?? (asked as AgentKind | undefined)
  if (!kind) throw new HttpError(400, 'Say which agent to list conversations for')
  if (!listsConversations(kind)) throw new HttpError(400, `Inyon can't list ${AGENTS[kind].name}'s conversations yet. Use its own command in the terminal.`)
  return { found, kind }
}

/** Past conversations in the pane's working folder, with the open one marked. */
export async function paneConversations(hostId: string, paneId: string, asked?: unknown) {
  const { found, kind } = paneAgent(hostId, paneId, asked)
  const cwd = registry.agentProc(hostId, paneId)?.cwd ?? found.pane.cwd
  if (!cwd) throw new HttpError(409, "The pane's working folder isn't known yet")
  const list = await listConversations(registry.host(hostId), kind, cwd)
  const current = found.pane.agent?.kind === kind ? found.pane.agent.sessionId : undefined
  return {
    agent: kind,
    cwd,
    conversations: list.map((c) => ({ ...c, title: sessionName(hostId, c.id, kind) ?? c.title, ...(c.id === current && { current: true }) })),
  }
}

const switching = new Set<string>()

/** What a switch does, swapped out in tests. */
export const switchSteps = { exit: exitAgent, ready: shellReady, start: typeStart }

/**
 * Opens another conversation in the pane. A running agent is asked to exit the way /exit would
 * (a running turn is stopped first, so the conversation it leaves is saved) and the pane stays
 * open; then the agent starts again with that conversation.
 */
export async function switchConversation(hostId: string, paneId: string, asked: unknown, id: unknown) {
  const { found, kind } = paneAgent(hostId, paneId, asked)
  if (!id || typeof id !== 'string' || !isSessionId(id, kind)) throw new HttpError(400, 'Bad conversation id')
  const running = found.pane.agent
  if (running && asked && asked !== running.kind) throw new HttpError(409, `${AGENTS[running.kind].name} is running here, not ${AGENTS[asked as AgentKind].name}`)
  if (running?.sessionId === id) return { switched: false }
  const key = JSON.stringify([hostId, paneId])
  if (switching.has(key)) throw new HttpError(409, 'Already switching conversations in this session')
  switching.add(key)
  try {
    if (running) {
      await switchSteps.exit(hostId, paneId)
      await switchSteps.ready(registry.host(hostId), paneId)
    }
    await switchSteps.start(hostId, paneId, kind, id)
  } finally {
    switching.delete(key)
  }
  return { switched: true }
}
