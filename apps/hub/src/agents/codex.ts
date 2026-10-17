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

/** Codex's faster service tiers, as its settings name them; "default" is the normal speed. */
const FAST_TIERS = new Set(['fast', 'priority'])

/**
 * Latest token usage and rate limits from the end of a rollout file. A compaction after the last
 * token count makes its context size wrong, and a newer sign-in (auth.json rewritten) makes its
 * limits someone else's; both come back with the next turn.
 */
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
  let tier: string | undefined
  for (const line of lines) {
    try {
      const e = JSON.parse(line)
      const ts = Date.parse(e.timestamp) || Date.now()
      if (e.type === 'turn_context' || e.payload?.type === 'thread_settings_applied') permission = codexPermission(e.payload) ?? permission
      if (e.payload?.type === 'thread_settings_applied' && typeof e.payload.thread_settings?.service_tier === 'string') tier = e.payload.thread_settings.service_tier
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
    if (tier) status.fast = FAST_TIERS.has(tier)
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
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

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

/** The text of the `{…}` object literal starting at src[at], brackets and strings balanced. */
function jsObject(src: string, at: number): string | undefined {
  if (src[at] !== '{') return undefined
  let depth = 0
  for (let i = at; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const s = jsString(src, i)
      if (s === undefined) return undefined
      // step over the literal: its raw length isn't the decoded length, so scan for the closing quote
      let j = i + 1
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1
      i = j
      continue
    }
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') {
      depth--
      if (depth === 0) return src.slice(at, i + 1)
    }
  }
  return undefined
}

/** A string literal, or the value of the `const x = "…"` it names. */
function stringArg(code: string, at: number): string | undefined {
  const direct = jsString(code, at)
  if (direct !== undefined) return direct
  const id = code.slice(at).match(/^\w+/)?.[0]
  const def = id && code.match(new RegExp(`(?:const|let|var)\\s+${id}\\s*=\\s*`))
  return def ? jsString(code, def.index! + def[0].length) : undefined
}

/** The string under `key:` in an object literal's text. */
function objectField(obj: string, key: string): string | undefined {
  const m = obj.match(new RegExp(`(?:^|[{,\\s])["']?${key}["']?\\s*:\\s*`))
  return m ? jsString(obj, m.index! + m[0].length) : undefined
}

/** One call a Codex exec script makes: the tool and the argument that matters for it. */
export interface ScriptStep {
  tool: string
  /** the command, the patch, the path or the text typed, whichever the tool takes */
  arg?: string
}

/** The fields that say what a call does, per tool, in the order to try them. */
const STEP_FIELDS: Record<string, string[]> = {
  exec_command: ['cmd', 'command'],
  write_stdin: ['chars', 'input'],
  view_image: ['path'],
  read_file: ['path', 'file_path'],
  write_file: ['path', 'file_path'],
  list_dir: ['path'],
  grep_files: ['pattern', 'query'],
  spawn_agent: ['task_name', 'message'],
  send_message: ['message'],
  followup_task: ['message'],
}

/** Every `tools.<name>(…)` call in a script, with the argument that describes it. */
export function scriptSteps(code: string): ScriptStep[] {
  const steps: ScriptStep[] = []
  for (const m of code.matchAll(/tools\.(\w+)\(\s*/g)) {
    const tool = m[1]
    const at = m.index! + m[0].length
    const obj = jsObject(code, at)
    let arg: string | undefined
    if (obj !== undefined) {
      for (const key of STEP_FIELDS[tool] ?? ['cmd', 'command', 'path', 'patch', 'message', 'text']) {
        arg = objectField(obj, key)
        if (arg !== undefined) break
      }
    } else arg = stringArg(code, at)
    steps.push(arg === undefined ? { tool } : { tool, arg })
  }
  return steps
}

/**
 * Since 0.16x Codex runs its tools from a small JS script (the "exec" tool):
 * `const r = await tools.exec_command({cmd:"ls"}); text(r.output)` or `tools.apply_patch(p)`.
 * A script that only runs commands reads as a command, one that only applies a patch as the patch;
 * anything else reads as a script with its steps listed, so a mix of a patch and a test run still
 * says what it did.
 */
export function codexScript(code: string): { name: string; input: Record<string, unknown> } {
  const steps = scriptSteps(code)
  if (steps.length && steps.every((s) => s.tool === 'exec_command')) {
    const cmds = steps.map((s) => s.arg).filter((s): s is string => s !== undefined)
    if (cmds.length) return { name: 'Bash', input: { command: cmds.join('\n') } }
  }
  if (steps.length === 1 && steps[0].tool === 'apply_patch' && steps[0].arg) return { name: 'ApplyPatch', input: { patch: steps[0].arg } }
  return { name: 'Script', input: { code, steps } }
}

/** "Script completed\nWall time 0.2 seconds\nOutput:\n…\nexit_code=1" → the output and whether it failed. */
function scriptOutput(raw: any): { text: string; failed: boolean; running?: string } {
  let text = Array.isArray(raw) ? raw.map((c: any) => c?.text ?? '').join('') : typeof raw === 'string' ? raw : String(raw?.output ?? '')
  // a script still going (waiting on an approval, a long command): its cell is read later with wait
  const running = text.match(/^Script running with cell ID (\w+)/)?.[1]
  const failed = /^Script (failed|error)/i.test(text)
  text = text.replace(/^Script \w+(?: with cell ID \w+)?\nWall time [\d.]+ seconds\nOutput:\n/, '')
  const exit = text.match(/(?:^|\n)exit_code=(\d+)\s*$/)
  if (exit) text = text.slice(0, exit.index)
  return { text: text.replace(/\s+$/, ''), failed: failed || (!!exit && exit[1] !== '0'), running }
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

/** Bookkeeping per conversation that isn't part of its summary. */
interface Scratch {
  /** diffs Codex reported since the last script output (FileChange items land between a call and its output) */
  hunks: Hunk[]
  /** file changes already counted into the session's line totals */
  counted: Set<string>
  /** scripts still running, by the cell id Codex reads them back with */
  cells: Map<string, string>
  /** `wait` calls, by call id, and the script call each one reads */
  waits: Map<string, string>
}
const scratch = new WeakMap<TranscriptMeta, Scratch>()
const pad = (meta: TranscriptMeta): Scratch => {
  let s = scratch.get(meta)
  if (!s) scratch.set(meta, (s = { hunks: [], counted: new Set(), cells: new Map(), waits: new Map() }))
  return s
}

/** A null effort means Codex is using the model's default, rather than an unknown setting. */
export function codexEffort(p: any): string {
  return p?.effort ?? p?.reasoning_effort ?? p?.collaboration_mode?.settings?.reasoning_effort ?? 'default'
}

function fileChange(item: any, meta: TranscriptMeta) {
  if (item.status && item.status !== 'completed') return
  const s = pad(meta)
  if (item.id && s.counted.has(item.id)) return
  if (item.id) s.counted.add(item.id)
  const hunks: Hunk[] = []
  for (const c of Object.values(item?.changes ?? {}) as any[]) {
    if (typeof c?.unified_diff === 'string') hunks.push(...unifiedHunks(c.unified_diff))
    else if (typeof c?.content === 'string') {
      const lines = c.content.replace(/\n$/, '').split('\n')
      hunks.push({ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l: string) => `+${l}`) })
    }
  }
  if (hunks.length) {
    s.hunks.push(...hunks)
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

/** The sub-agent's name as the TUI shows it: its path under the root agent. */
const agentName = (path: unknown) => String(path ?? 'Sub-agent').replace(/^\/root\/?/, '') || 'Sub-agent'

/** A sub-agent started or finished (item_completed of type SubAgentActivity). */
function subAgentActivity(item: any, meta: TranscriptMeta, ts: string) {
  const id = item.agent_thread_id
  if (!id) return
  const cur = meta.subagents.get(id)
  if (item.kind === 'started') {
    meta.subagents.set(id, { toolUseId: id, type: 'codex', description: agentName(item.agent_path), status: 'running', startedAt: cur?.startedAt ?? ts })
  } else if (cur) cur.status = item.kind === 'completed' ? 'done' : item.kind === 'interrupted' ? 'error' : cur.status
}

/** Messages between Codex agents ("Message Type: FINAL_ANSWER … Payload:\n…") → what was said, by whom. */
function agentMessage(p: any, base: { uuid: string; ts: string }): Draft[] {
  const text = textOf(p.content)
  const payload = (text.match(/\nPayload:\n([\s\S]*)$/)?.[1] ?? text).trim()
  if (!payload) return []
  return [{ kind: 'notice', ...base, level: 'info', subtype: 'task', text: `${agentName(p.author)}: ${clip(payload, 600)}` }]
}

/** The questions Codex asked with request_user_input, in the shape the question card shows. */
function questions(args: any) {
  const list = Array.isArray(args?.questions) ? args.questions : []
  return list.map((q: any) => ({
    id: q?.id,
    header: q?.header,
    question: String(q?.question ?? q?.title ?? ''),
    options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => (typeof o === 'string' ? { label: o } : { label: String(o?.label ?? ''), description: o?.description })),
    isOther: q?.isOther ?? q?.is_other,
  }))
}

const QUESTION_REPLY = /<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/

/**
 * Your answer to an async question comes back as a user message that only names the question
 * ("questionItemId": ["request_user_input_async", "<call id>", 0]); it becomes the answer on
 * that question's card instead of a bubble.
 */
function questionReply(text: string, base: { uuid: string; ts: string }): Draft[] | undefined {
  const m = text.match(QUESTION_REPLY)
  if (!m) return undefined
  const list = parseJson(m[1])
  if (!Array.isArray(list)) return []
  const byCall = new Map<string, Record<string, string>>()
  for (const a of list) {
    const ref = parseJson(a?.questionItemId)
    const callId = Array.isArray(ref) ? ref[1] : undefined
    if (typeof callId !== 'string') continue
    const answers = byCall.get(callId) ?? {}
    answers[String(a.question ?? '')] = String(a.answer ?? '')
    byCall.set(callId, answers)
  }
  return [...byCall].map(([callId, answers]) => ({
    kind: 'tool_result', ...base, uuid: `${base.uuid}:${callId}`, toolUseId: callId, isError: false,
    text: Object.entries(answers).map(([q, a]) => `${q}: ${a}`).join('\n'), meta: { answers },
  }))
}

/** Tools Codex uses for its own bookkeeping while it waits: nothing to show for them. */
const SILENT_TOOLS = new Set(['sleep', 'wait', 'get_goal', 'update_goal'])
/** The multi-agent tools (namespace "collaboration"), whose messages are encrypted in the record. */
const ENCRYPTED = /^gAAAA[A-Za-z0-9_-]{24,}=*$/

/** Tool arguments as they can be shown: an encrypted message says so instead of showing noise. */
function scrub(args: any): any {
  if (!args || typeof args !== 'object') return args
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' && ENCRYPTED.test(v) ? '[encrypted]' : v
  return out
}

/** A script's output (or a later read of its cell) → the tool result, with the diffs Codex reported since the call. */
function scriptResult(callId: string, raw: any, meta: TranscriptMeta, base: { uuid: string; ts: string }): Draft[] {
  const s = pad(meta)
  const { text, failed, running } = scriptOutput(raw)
  if (running) {
    s.cells.set(running, callId)
    return []
  }
  if (/^\{"goal":/.test(text)) return codexGoal(parseJson(text)?.goal, meta, base)
  const patch = s.hunks.length ? s.hunks : undefined
  s.hunks = []
  return [{ kind: 'tool_result', ...base, toolUseId: callId, isError: failed, text: clip(text), meta: patch ? { patch } : { stdout: clip(text) } }]
}

/** One Codex rollout line → chat items (the same shapes Claude transcripts produce). */
export function normalizeCodex(e: any, meta: TranscriptMeta): Draft[] {
  const p = e?.payload
  if (!p) return []
  const ts = e.timestamp ?? ''
  // the record's own id where it has one: the live copy of a reply (streamed before it's written
  // down) carries the same id, so the app can tell the two apart
  const uuid = typeof p.id === 'string' && p.id ? p.id : `${ts}:${p.call_id ?? p.type}:${Math.random().toString(36).slice(2, 7)}`
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
    if (p.type === 'task_started') {
      meta.turn = { id: p.turn_id, startedAt: num(p.started_at) ? p.started_at * 1000 : Date.parse(ts) || Date.now() }
      return []
    }
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
    if (p.type === 'item_completed' && p.item?.type === 'SubAgentActivity') {
      subAgentActivity(p.item, meta, ts)
      return []
    }
    if (p.type === 'turn_aborted') {
      meta.turn = undefined
      return [{ kind: 'notice', ...base, level: 'warn', subtype: 'interrupted', text: 'Interrupted' }]
    }
    if (p.type === 'task_complete') {
      meta.stats.turns++
      meta.turn = undefined
      const out: Draft[] = []
      const error = typeof p.error === 'string' ? p.error : p.error?.message
      if (error) out.push({ kind: 'notice', ...base, uuid: `${uuid}:error`, level: 'error', subtype: 'api_error', text: String(error) })
      out.push({ kind: 'turn_end', ...base, durationMs: num(p.duration_ms) ?? 0 })
      return out
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
        const reply = questionReply(text, base)
        if (reply) return reply
        return [{ kind: 'user', ...base, text: clip(text), images: Array.isArray(p.content) ? p.content.filter((c: any) => c?.type === 'input_image').length : 0 }]
      }
      if (p.role === 'assistant') {
        // in Plan mode the plan is a message wrapped in a tag; it shows as a plan card
        const plan = text.match(/^\s*<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>\s*$/)
        if (plan) return [{ kind: 'assistant', ...base, msgId: uuid, model: meta.model, block: { type: 'tool_use', id: uuid, name: 'ExitPlanMode', input: { plan: clip(plan[1]) } } }]
        return [{ kind: 'assistant', ...base, msgId: uuid, model: meta.model, block: { type: 'text', text: clip(text) } }]
      }
      return []
    }
    case 'agent_message':
      return agentMessage(p, base)
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
      const callId = p.call_id ?? uuid
      const tool = (name: string, input: any): Draft => ({ kind: 'assistant', ...base, msgId: uuid, block: { type: 'tool_use', id: callId, name, input } })
      if (p.name === 'update_plan') {
        const todos = (args.plan ?? []).map((s: any) => ({ content: s.step, activeForm: s.step, status: s.status }))
        return [tool('TodoWrite', { todos })]
      }
      if (p.name === 'request_user_input' || p.name === 'request_user_input_async') {
        const input = { questions: questions(args) }
        meta.tools.set(callId, { name: 'AskUserQuestion', input })
        return [tool('AskUserQuestion', input)]
      }
      // reading a running script's cell back: its output belongs to the script
      if (p.name === 'wait' && args.cell_id !== undefined) {
        const script = pad(meta).cells.get(String(args.cell_id))
        if (script) pad(meta).waits.set(callId, script)
        meta.tools.set(callId, { name: 'wait', input: {} })
        return []
      }
      if (SILENT_TOOLS.has(p.name)) {
        meta.tools.set(callId, { name: p.name, input: {} })
        return []
      }
      if (p.name === 'shell' || p.name === 'exec_command' || p.type === 'local_shell_call' || args.command || args.cmd) {
        return [tool('Bash', { command: shellCommand(args.command ?? args.cmd), workdir: args.workdir })]
      }
      if (p.name === 'apply_patch') return [tool('ApplyPatch', { patch: args.input ?? args.patch ?? '' })]
      return [tool(p.name ?? 'tool', scrub(args))]
    }
    case 'custom_tool_call': {
      if (p.name === 'exec') {
        // the goal bookkeeping shows as goal rows instead (from its output)
        if (/^(?:text\()?\s*(?:await\s+)?tools\.(update_goal|get_goal)\(/.test(String(p.input ?? '').trim())) return []
        const { name, input } = codexScript(String(p.input ?? ''))
        if (p.call_id) meta.tools.set(p.call_id, { name, input: { steps: (input as any).steps } })
        // diffs reported for an earlier script that never answered don't belong to this one
        pad(meta).hunks = []
        return [{ kind: 'assistant', ...base, msgId: uuid, block: { type: 'tool_use', id: p.call_id ?? uuid, name, input } }]
      }
      return [{ kind: 'assistant', ...base, msgId: uuid, block: { type: 'tool_use', id: p.call_id ?? uuid, name: p.name === 'apply_patch' ? 'ApplyPatch' : p.name, input: { patch: p.input } } }]
    }
    case 'custom_tool_call_output':
      if (Array.isArray(p.output) || /^Script \w+/.test(String(p.output ?? ''))) return scriptResult(p.call_id, p.output, meta, base)
    // falls through
    case 'function_call_output': {
      const call = meta.tools.get(p.call_id)
      if (call?.name === 'wait') {
        // the cell's output, read back later: it answers the script, if this wait was for one
        const script = pad(meta).waits.get(p.call_id)
        pad(meta).waits.delete(p.call_id)
        return script ? scriptResult(script, p.output, meta, base) : []
      }
      if (call && SILENT_TOOLS.has(call.name)) return []
      const out = parseJson(p.output)
      if (call?.name === 'AskUserQuestion') {
        // the async form only acknowledges here; the answer comes as a message later
        if (out && typeof out === 'object' && !out.answers) return []
        const answers: Record<string, string> = {}
        const asked = Array.isArray(call.input?.questions) ? call.input.questions : []
        for (const [id, a] of Object.entries(out?.answers ?? {})) {
          const q = asked.find((x: any) => x.id === id)
          answers[q?.question ?? id] = (Array.isArray((a as any)?.answers) ? (a as any).answers : [a]).map(String).join(', ')
        }
        return [{ kind: 'tool_result', ...base, toolUseId: p.call_id, isError: false, text: Object.entries(answers).map(([q, a]) => `${q}: ${a}`).join('\n'), meta: { answers } }]
      }
      const text = typeof out === 'string' ? out : String(out?.output ?? (out && typeof out === 'object' ? JSON.stringify(out) : ''))
      const exit = out?.metadata?.exit_code
      return [{
        kind: 'tool_result', ...base, toolUseId: p.call_id, isError: typeof exit === 'number' && exit !== 0,
        text: clip(text), meta: typeof exit === 'number' ? { stdout: clip(text) } : undefined,
      }]
    }
  }
  return []
}
