import type { AgentStatus, ChatItem } from '@inyon/protocol'
import { Host, shq } from '../hosts/host.ts'
import { statusFromCodex } from './status.ts'
import type { TranscriptMeta } from '../claude/transcript.ts'

type Draft = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'seq'> : never) : never

export interface CodexProc {
  pid: number
  cwd?: string
  startedAt: number
  resume?: string
  /** the pane's title as Codex set it ("<thread name> | <folder>") */
  title?: string
}

export interface CodexRollout {
  path: string
  id?: string
  cwd?: string
  /** seconds: when the thread was created (session_meta) and last written */
  created: number
  mtime: number
}

/**
 * Codex keeps one rollout file per thread under ~/.codex/sessions/YYYY/MM/DD/, all written by its
 * shared app-server daemon, so no process holds "its" file open. The thread is found by, in order:
 * the id it was resumed with; the thread name Codex put in the terminal title; else creation time.
 * A thread belongs to the newest Codex process in that folder that had started when the thread was
 * made, so two sessions in one folder don't both claim the latest file, while /new in the older one
 * still lands on its own new thread once nothing newer was started.
 */
export function pickCodexRollout(rows: CodexRollout[], proc: CodexProc, others: CodexProc[], names: Map<string, string>): string | undefined {
  if (proc.resume) {
    const hit = rows.filter((r) => r.id === proc.resume || r.path.includes(proc.resume!)).sort((a, b) => b.mtime - a.mtime)[0]
    if (hit) return hit.path
  }
  const here = rows.filter((r) => !proc.cwd || r.cwd === proc.cwd)
  const mine = here.filter((r) => r.created >= proc.startedAt - 5)
  // a thread picked with /resume was made before the process started, but is written since; only
  // its name (Codex names every thread) tells it from one a Codex outside tmux is writing
  const touched = here.filter((r) => r.created >= proc.startedAt - 5 || r.mtime >= proc.startedAt - 5)
  const name = proc.title ? codexTitle(proc.title, proc.cwd) : ''
  if (name) {
    const named = touched.filter((r) => r.id && names.get(r.id) === name)
    if (named.length === 1) return named[0].path
    const fresh = named.filter((r) => r.created >= proc.startedAt - 5)
    if (fresh.length === 1) return fresh[0].path
  }
  const rivals = others.filter((o) => o.pid !== proc.pid && o.cwd === proc.cwd && o.startedAt > proc.startedAt)
  const owned = mine.filter((r) => !rivals.some((o) => o.startedAt - 5 <= r.created))
  return owned.sort((a, b) => b.mtime - a.mtime)[0]?.path
}

export async function guessCodexRollout(host: Host, home: string, proc: CodexProc, others: CodexProc[] = []): Promise<string | undefined> {
  const oldest = Math.min(proc.startedAt, ...others.map((o) => o.startedAt))
  const ageMin = Math.max(5, Math.ceil((Date.now() / 1000 - oldest) / 60) + 2)
  const cmd =
    `find ${shq(home + '/.codex/sessions')} -name 'rollout-*.jsonl' -mmin -${ageMin} 2>/dev/null | while read -r f; do printf '%s\\t%s\\t%s\\n' "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")" "$f" "$(head -c 4000 "$f" | head -n 1)"; done; ` +
    `echo '---'; tail -n 400 ${shq(home + '/.codex/session_index.jsonl')} 2>/dev/null`
  const r = await host.exec(cmd)
  const [list, index = ''] = r.stdout.split('\n---\n')
  const rows = list.split('\n').filter(Boolean).map((l) => {
    const m = l.match(/^(\d+)\t([^\t]+)\t(.*)$/)
    if (!m) return null
    // read the fields straight from the text: since 0.162 the first line is ~20 kB, so the head we
    // read is cut off and not valid JSON
    const field = (k: string) => {
      const v = m[3].match(new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)"`))?.[1]
      try {
        return v === undefined ? undefined : (JSON.parse(`"${v}"`) as string)
      } catch {
        return v
      }
    }
    const created = Date.parse(field('timestamp') ?? '') / 1000 || +m[1]
    return { mtime: +m[1], path: m[2], cwd: field('cwd'), id: field('id'), created }
  }).filter(Boolean) as CodexRollout[]
  // the latest name per thread (/rename appends a line)
  const names = new Map<string, string>()
  for (const l of index.split('\n')) {
    try {
      const e = JSON.parse(l)
      if (e.id && e.thread_name) names.set(e.id, e.thread_name)
    } catch {}
  }
  return pickCodexRollout(rows, proc, others, names)
}

/**
 * After a rewind (or with paginated history) Codex starts a new segment file for the thread,
 * "rollout-…-<thread>_<segment>.jsonl", whose session_meta says where the kept history ends:
 * history_base {thread_id, end_byte_offset}. Returns the earlier lines to replay before the
 * segment, following bases of bases, oldest first.
 */
export async function codexHistory(host: Host, path: string, depth = 0): Promise<string[]> {
  if (depth > 6) return []
  const head = await host.exec(`head -c 200000 ${shq(path)} 2>/dev/null | head -n 1`)
  const base = head.stdout.match(/"history_base":\{"thread_id":"([0-9a-f-]{36})"[^}]*?"end_byte_offset":(\d+)/)
  if (!base) return []
  const [, id, offset] = base
  const dir = path.replace(/\/sessions\/.*$/, '/sessions')
  // the id names the file this one continues: the thread's first file ends "-<thread>.jsonl", a
  // later segment "<thread>_<segment>.jsonl"
  const r = await host.exec(`find ${shq(dir)} -name ${shq(`rollout-*${id}.jsonl`)} ! -path ${shq(path)} 2>/dev/null | head -n 1`)
  const prev = r.stdout.trim()
  if (!prev) return []
  const body = await host.exec(`head -c ${Number(offset)} ${shq(prev)} 2>/dev/null`, { timeoutMs: 30000 })
  return [...(await codexHistory(host, prev, depth + 1)), ...body.stdout.split('\n').filter(Boolean)]
}

/**
 * Latest token usage and rate limits from the end of a rollout file. A compaction after the last
 * token count makes its context size wrong, and a newer sign-in (auth.json rewritten) makes its
 * limits someone else's; both come back with the next turn.
 */
/**
 * The permission preset from a settings event or turn context: "full-access" (no sandbox, never
 * asks), "auto-review" (a reviewer approves for you), "read-only" (no folder to write), else "default".
 */
export function codexPermission(p: any): string | undefined {
  const t = p?.thread_settings ?? p
  if (!t || typeof t !== 'object') return undefined
  const profile = t.permission_profile
  if (profile?.type === 'disabled' || t.sandbox_policy?.type === 'danger-full-access') return 'full-access'
  if (t.approvals_reviewer === 'auto_review') return 'auto-review'
  const entries = profile?.file_system?.entries
  if (Array.isArray(entries) ? !entries.some((e: any) => e?.access === 'write') : t.sandbox_policy?.type === 'read-only') return 'read-only'
  return profile || t.sandbox_policy ? 'default' : undefined
}

export async function codexStatus(host: Host, path: string): Promise<{ status?: AgentStatus; permission?: string }> {
  const r = await host.exec(
    `stat -c %Y "\${CODEX_HOME:-$HOME/.codex}/auth.json" 2>/dev/null || stat -f %m "\${CODEX_HOME:-$HOME/.codex}/auth.json" 2>/dev/null || echo 0; ` +
      // the latest settings may be far back in a long turn, so look for them through the whole file
      `grep -E '"type":"turn_context"|"thread_settings_applied"' ${shq(path)} 2>/dev/null | tail -n 1; ` +
      `tail -c 400000 ${shq(path)} 2>/dev/null | grep -E '"token_count"|"turn_context"|"thread_settings_applied"|"type":"compacted"|"type":"(context_)?compaction"' | tail -n 12`,
  )
  const [authLine, ...lines] = r.stdout.split('\n')
  const authAt = Number(authLine) * 1000 || 0
  let ctx: { model?: string; effort?: string } = {}
  let status: AgentStatus | undefined
  let permission: string | undefined
  for (const line of lines) {
    try {
      const e = JSON.parse(line)
      const ts = Date.parse(e.timestamp) || Date.now()
      if (e.type === 'turn_context' || e.payload?.type === 'thread_settings_applied') permission = codexPermission(e.payload) ?? permission
      if (e.type === 'turn_context') ctx = { model: e.payload?.model, effort: codexEffort(e.payload) }
      else if (e.payload?.type === 'token_count') status = statusFromCodex(e.payload, ctx, ts)
      else if (status && (e.type === 'compacted' || /compaction$/.test(e.payload?.type ?? ''))) {
        status.contextPct = status.contextUsed = undefined
        status.stale = { ...status.stale, context: 'compacted' }
      }
    } catch {}
  }
  if (status) {
    status.modelId = ctx.model ?? status.modelId
    status.effort = ctx.effort ?? status.effort
  }
  if (status && authAt > status.updatedAt && (status.fiveHour || status.sevenDay || status.credits)) {
    status.fiveHour = status.sevenDay = status.credits = status.plan = undefined
    status.stale = { ...status.stale, limits: 'account' }
  }
  return { status, permission }
}

/** The last token count described the context before compacting; it's unknown until the next one. */
function compacted(meta: TranscriptMeta, ts: string) {
  meta.stats.compactions++
  meta.stats.compactedAt = meta.stats.contextAt = Date.parse(ts) || Date.now()
  meta.stats.contextTokens = undefined
  if (meta.status) meta.status = { ...meta.status, contextPct: undefined, contextUsed: undefined, stale: { ...meta.status.stale, context: 'compacted' } }
}

const clip = (s: string, max = 24_000) => (s.length > max ? s.slice(0, max) : s)

function textOf(content: any): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content.map((c: any) => c?.text ?? '').filter(Boolean).join('\n')
}

function parseJson(s: any): any {
  if (typeof s !== 'string') return s
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

/** Shell argv like ["bash","-lc","cmd"] → "cmd". */
function shellCommand(cmd: any): string {
  if (!Array.isArray(cmd)) return String(cmd ?? '')
  if (cmd.length >= 3 && /(^|\/)(ba|z)?sh$/.test(cmd[0]) && /^-l?c$/.test(cmd[1])) return cmd.slice(2).join(' ')
  return cmd.join(' ')
}

/** The JS string literal ("…", '…' or `…`) starting at src[at]. */
function jsString(src: string, at: number): string | undefined {
  const q = src[at]
  if (q !== '"' && q !== "'" && q !== '`') return undefined
  let out = ''
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i]
    if (c === q) return out
    if (c !== '\\') {
      out += c
      continue
    }
    const n = src[++i]
    if (n === 'u') {
      out += String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16))
      i += 4
    } else out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
  }
  return undefined
}

/**
 * Since 0.16x Codex runs its tools from a small JS script (the "exec" tool):
 * `const r = await tools.exec_command({cmd:"ls"}); text(r.output)` or `tools.apply_patch(p)`.
 * A script that makes one kind of call reads as that tool; anything else shows as the script.
 */
export function codexScript(code: string): { name: string; input: Record<string, unknown> } {
  const calls = [...code.matchAll(/tools\.(\w+)\(/g)].map((m) => m[1])
  if (calls.length && calls.every((c) => c === 'exec_command')) {
    const cmds = [...code.matchAll(/tools\.exec_command\(\{\s*cmd\s*:\s*/g)].map((m) => jsString(code, m.index! + m[0].length)).filter(Boolean)
    if (cmds.length) return { name: 'Bash', input: { command: cmds.join('\n') } }
  }
  if (calls.length === 1 && calls[0] === 'apply_patch') {
    const m = code.match(/tools\.apply_patch\(\s*/)!
    const at = m.index! + m[0].length
    let patch = jsString(code, at)
    if (patch === undefined) {
      const id = code.slice(at).match(/^\w+/)?.[0]
      const def = id && code.match(new RegExp(`(?:const|let|var)\\s+${id}\\s*=\\s*`))
      if (def) patch = jsString(code, def.index! + def[0].length)
    }
    if (patch) return { name: 'ApplyPatch', input: { patch } }
  }
  return { name: 'Script', input: { code } }
}

/** "Script completed\nWall time 0.2 seconds\nOutput:\n…\nexit_code=1" → the output and whether it failed. */
function scriptOutput(raw: any): { text: string; failed: boolean } {
  let text = Array.isArray(raw) ? raw.map((c: any) => c?.text ?? '').join('') : typeof raw === 'string' ? raw : String(raw?.output ?? '')
  const failed = /^Script (failed|error)/i.test(text)
  text = text.replace(/^Script \w+\nWall time [\d.]+ seconds\nOutput:\n/, '')
  const exit = text.match(/(?:^|\n)exit_code=(\d+)\s*$/)
  if (exit) text = text.slice(0, exit.index)
  return { text: text.replace(/\s+$/, ''), failed: failed || (!!exit && exit[1] !== '0') }
}

/**
 * Codex titles the terminal "[spinner] [Action Required | ]<thread name> | <folder>"; keep the name.
 * Before the thread has a name it's "codex" or the folder alone, which is no name.
 */
export function codexTitle(title: string, cwd?: string) {
  const folder = cwd?.split('/').filter(Boolean).pop()
  const parts = title.replace(/^[^\w\s]+\s*/u, '').split(' | ').map((s) => s.trim()).filter(Boolean)
  while (parts.length > 1 && /^(Action Required|Working|Thinking|Ready|Waiting|Done|Error|Interrupted)$/i.test(parts[0])) parts.shift()
  if (parts.length > 1 && (parts[parts.length - 1] === folder || parts[parts.length - 1] === 'codex')) parts.pop()
  const name = parts.join(' | ')
  return !name || name === folder || /^codex$/i.test(name) ? '' : name
}

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

/** "@@ -2 +2,5 @@\n ctx\n+new" → hunks with their line numbers. */
export function unifiedHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  for (const line of diff.split('\n')) {
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (h) hunks.push({ oldStart: +h[1], oldLines: h[2] === undefined ? 1 : +h[2], newStart: +h[3], newLines: h[4] === undefined ? 1 : +h[4], lines: [] })
    else if (hunks.length && /^[ +-]/.test(line)) hunks[hunks.length - 1].lines.push(line)
  }
  return hunks
}

/** The diff Codex reported for its last patch (a FileChange item lands between the call and its output). */
const lastPatch = new WeakMap<TranscriptMeta, Hunk[]>()
const countedChanges = new WeakMap<TranscriptMeta, Set<string>>()

/** A null effort means Codex is using the model's default, rather than an unknown setting. */
export function codexEffort(p: any): string {
  return p?.effort ?? p?.reasoning_effort ?? p?.collaboration_mode?.settings?.reasoning_effort ?? 'default'
}

function fileChange(item: any, meta: TranscriptMeta) {
  if (item.status && item.status !== 'completed') return
  let seen = countedChanges.get(meta)
  if (!seen) countedChanges.set(meta, seen = new Set())
  if (item.id && seen.has(item.id)) return
  if (item.id) seen.add(item.id)
  const hunks: Hunk[] = []
  for (const c of Object.values(item?.changes ?? {}) as any[]) {
    if (typeof c?.unified_diff === 'string') hunks.push(...unifiedHunks(c.unified_diff))
    else if (typeof c?.content === 'string') {
      const lines = c.content.replace(/\n$/, '').split('\n')
      hunks.push({ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l: string) => `+${l}`) })
    }
  }
  if (hunks.length) {
    lastPatch.set(meta, hunks)
    meta.stats.linesAdded = (meta.stats.linesAdded ?? 0) + hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith('+')).length, 0)
    meta.stats.linesRemoved = (meta.stats.linesRemoved ?? 0) + hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith('-')).length, 0)
  }
}

/** A goal set, met or cleared ("/goal …", or Codex marking it complete) → a goal row and ChatInfo.goal. */
function codexGoal(g: any, meta: TranscriptMeta, base: { uuid: string; ts: string }): Draft[] {
  if (!g || typeof g !== 'object' || !g.objective) {
    if (!meta.goal || meta.goal.met) return []
    meta.goal = undefined
    return [{ kind: 'notice', ...base, level: 'info', subtype: 'goal', text: 'Goal cleared' }]
  }
  const condition = String(g.objective)
  const met = g.status === 'complete'
  if (meta.goal?.condition === condition && meta.goal.met === met) return []
  meta.goal = { condition, met, ts: base.ts, ...(g.status === 'paused' && { reason: 'Paused' }) }
  return [{ kind: 'goal', ...base, condition, met }]
}

/** One Codex rollout line → chat items (the same shapes Claude transcripts produce). */
export function normalizeCodex(e: any, meta: TranscriptMeta): Draft[] {
  const p = e?.payload
  if (!p) return []
  const ts = e.timestamp ?? ''
  const uuid = `${ts}:${p.call_id ?? p.type}:${Math.random().toString(36).slice(2, 7)}`
  const base = { uuid, ts }
  if (e.type === 'session_meta') {
    meta.cwd = p.cwd
    meta.version = p.cli_version
    return []
  }
  if (e.type === 'turn_context') {
    if (p.model) meta.model = p.model
    meta.effort = codexEffort(p)
    if (p.cwd) meta.cwd = p.cwd
    return []
  }
  if (e.type === 'event_msg') {
    if (p.type === 'token_count') {
      meta.status = statusFromCodex(p, { model: meta.model, effort: meta.effort }, Date.parse(ts) || Date.now())
      meta.stats.contextTokens = meta.status.contextUsed
      meta.stats.contextAt = meta.status.updatedAt
      return []
    }
    if (p.type === 'thread_goal_updated') return codexGoal(p.goal, meta, base)
    if (p.type === 'item_completed' && p.item?.type === 'CommandExecution' && p.item.source === 'user_shell') {
      const command = shellCommand(p.item.command)
      return [
        { kind: 'user', ...base, text: command, images: 0, shell: true },
        { kind: 'command', ...base, uuid: `${uuid}:output`, name: '!', args: '', output: clip(p.item.aggregated_output ?? '') },
      ]
    }
    if (p.type === 'item_completed' && p.item?.type === 'FileChange') {
      fileChange(p.item, meta)
      return []
    }
    if (p.type === 'turn_aborted') return [{ kind: 'notice', ...base, level: 'warn', subtype: 'interrupted', text: 'Interrupted' }]
    if (p.type === 'task_complete') {
      meta.stats.turns++
      return [{ kind: 'turn_end', ...base, durationMs: 0 }]
    }
    if (p.type === 'error' && p.message) return [{ kind: 'notice', ...base, level: 'error', subtype: 'api_error', text: String(p.message) }]
    return []
  }
  if (e.type === 'compacted') {
    compacted(meta, ts)
    return [{ kind: 'notice', ...base, level: 'info', subtype: 'compact', text: 'Conversation compacted' }]
  }
  if (e.type !== 'response_item') return []

  switch (p.type) {
    case 'message': {
      const text = textOf(p.content)
      if (!text.trim()) return []
      if (p.role === 'user') {
        // Codex injects environment and instruction blocks as user messages
        if (/^\s*<(environment_context|user_instructions|user_shell_command|codex_internal_context)[\s>]/.test(text)) return []
        return [{ kind: 'user', ...base, text: clip(text), images: Array.isArray(p.content) ? p.content.filter((c: any) => c?.type === 'input_image').length : 0 }]
      }
      if (p.role === 'assistant') {
        return [{ kind: 'assistant', ...base, msgId: uuid, model: meta.model, block: { type: 'text', text: clip(text) } }]
      }
      return []
    }
    case 'agent_message':
      return [] // messages between Codex agents
    case 'compaction':
    case 'context_compaction':
      compacted(meta, ts)
      return [{ kind: 'notice', ...base, level: 'info', subtype: 'compact', text: 'Context compacted' }]
    case 'web_search_call': {
      const q = p.action?.query ?? p.query ?? ''
      return [{ kind: 'assistant', ...base, msgId: uuid, block: { type: 'tool_use', id: p.id ?? uuid, name: 'WebSearch', input: { query: q } } }]
    }
    case 'image_generation_call':
      return [{ kind: 'assistant', ...base, msgId: uuid, block: { type: 'tool_use', id: p.id ?? uuid, name: 'ImageGeneration', input: { prompt: p.revised_prompt ?? '' } } }]
    case 'reasoning': {
      const text = (p.summary ?? []).map((s: any) => s?.text ?? '').join('\n').trim()
      return text ? [{ kind: 'assistant', ...base, msgId: uuid, block: { type: 'thinking', text: clip(text) } }] : []
    }
    case 'function_call':
    case 'local_shell_call': {
      const args = parseJson(p.arguments) ?? p.action ?? {}
      if (p.name === 'update_plan') {
        const todos = (args.plan ?? []).map((s: any) => ({ content: s.step, activeForm: s.step, status: s.status }))
        return [{ kind: 'assistant', ...base, msgId: uuid, block: { type: 'tool_use', id: p.call_id ?? uuid, name: 'TodoWrite', input: { todos } } }]
      }
      if (p.name === 'shell' || p.name === 'exec_command' || p.type === 'local_shell_call' || args.command || args.cmd) {
        return [{ kind: 'assistant', ...base, msgId: uuid, block: { type: 'tool_use', id: p.call_id ?? uuid, name: 'Bash', input: { command: shellCommand(args.command ?? args.cmd), workdir: args.workdir } } }]
      }
      return [{ kind: 'assistant', ...base, msgId: uuid, block: { type: 'tool_use', id: p.call_id ?? uuid, name: p.name ?? 'tool', input: args } }]
    }
    case 'custom_tool_call': {
      if (p.name === 'exec') {
        // the goal bookkeeping shows as goal rows instead (from its output)
        if (/^(?:text\()?\s*(?:await\s+)?tools\.(update_goal|get_goal)\(/.test(String(p.input ?? '').trim())) return []
        const { name, input } = codexScript(String(p.input ?? ''))
        if (name === 'ApplyPatch' && p.call_id) {
          meta.tools.set(p.call_id, { name, input })
          lastPatch.delete(meta)
        }
        return [{ kind: 'assistant', ...base, msgId: uuid, block: { type: 'tool_use', id: p.call_id ?? uuid, name, input } }]
      }
      return [{ kind: 'assistant', ...base, msgId: uuid, block: { type: 'tool_use', id: p.call_id ?? uuid, name: p.name === 'apply_patch' ? 'ApplyPatch' : p.name, input: { patch: p.input } } }]
    }
    case 'custom_tool_call_output':
      if (Array.isArray(p.output) || /^Script \w+\nWall time/.test(String(p.output ?? ''))) {
        const { text, failed } = scriptOutput(p.output)
        if (/^\{"goal":/.test(text)) return codexGoal(parseJson(text)?.goal, meta, base)
        const patch = meta.tools.get(p.call_id)?.name === 'ApplyPatch' ? lastPatch.get(meta) : undefined
        if (patch) lastPatch.delete(meta)
        return [{ kind: 'tool_result', ...base, toolUseId: p.call_id, isError: failed, text: clip(text), meta: patch ? { patch } : { stdout: clip(text) } }]
      }
    // falls through
    case 'function_call_output': {
      const out = parseJson(p.output)
      const text = typeof out === 'string' ? out : String(out?.output ?? '')
      const exit = out?.metadata?.exit_code
      return [{
        kind: 'tool_result', ...base, toolUseId: p.call_id, isError: typeof exit === 'number' && exit !== 0,
        text: clip(text), meta: typeof exit === 'number' ? { stdout: clip(text) } : undefined,
      }]
    }
  }
  return []
}
