import type { AgentStatus, ChatItem, RateWindow } from '@inyon/protocol'
import type { TranscriptMeta } from '../claude/transcript.ts'

type Draft = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'seq'> : never) : never

/**
 * Antigravity CLI (`agy`) keeps each conversation under
 * ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl: one line per
 * step, with a step_index. A model step (PLANNER_RESPONSE) carries its text, thinking and tool
 * calls (each argument value JSON-encoded on its own); the steps that follow hold the tools'
 * results, in order. Which conversation a process has open comes from the presence lock it holds
 * (see the probe), so no guessing by folder is needed.
 */
export const agyTranscript = (home: string, id: string) => `${home}/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`

const decode = (v: unknown) => {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

/** Antigravity tool names → the names Inyon's tool rows know. */
export function mapAgyTool(name: string, raw: Record<string, unknown> = {}): { name: string; input: any } {
  const a: any = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decode(v)]))
  const description = a.toolSummary ?? a.Description
  switch (name) {
    case 'run_command':
      return { name: 'Bash', input: { command: a.CommandLine, description, cwd: a.Cwd } }
    case 'view_file':
      return { name: 'Read', input: { file_path: a.AbsolutePath ?? a.TargetFile } }
    case 'write_to_file':
      return { name: 'Write', input: { file_path: a.TargetFile, content: typeof a.CodeContent === 'string' ? a.CodeContent : undefined } }
    case 'replace_file_content':
      return { name: 'Edit', input: { file_path: a.TargetFile ?? a.AbsolutePath, old_string: a.TargetContent, new_string: a.ReplacementContent, description } }
    case 'multi_replace_file_content':
      return {
        name: 'MultiEdit',
        input: {
          file_path: a.TargetFile ?? a.AbsolutePath,
          edits: (Array.isArray(a.ReplacementChunks) ? a.ReplacementChunks : []).map((c: any) => ({ old_string: c?.TargetContent, new_string: c?.ReplacementContent })),
        },
      }
    case 'grep_search':
      return { name: 'Grep', input: { pattern: a.Query ?? a.SearchPattern ?? a.Pattern, path: a.SearchPath ?? a.SearchDirectory } }
    case 'find_by_name':
      return { name: 'Glob', input: { pattern: a.Pattern ?? a.SearchPattern ?? a.Query, path: a.SearchDirectory ?? a.SearchPath } }
    case 'list_dir':
      return { name: 'LS', input: { path: a.DirectoryPath ?? a.AbsolutePath } }
    case 'search_web':
      return { name: 'WebSearch', input: { query: a.query ?? a.Query } }
    case 'read_url_content':
      return { name: 'WebFetch', input: { url: a.Url ?? a.url } }
    case 'invoke_subagent':
    case 'browser_subagent':
      return { name: 'Task', input: { description: description ?? a.Name ?? 'Subagent', prompt: a.Prompt ?? a.Task ?? a.Instruction } }
    default: {
      const { toolAction: _a, toolSummary: _s, ...rest } = a
      return { name, input: { ...rest, ...(description ? { description } : {}) } }
    }
  }
}

/** The text you typed, without the request wrapper and the metadata agy appends. */
export function userText(content: string): string {
  const m = content.match(/<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/)
  if (m) return m[1].trim()
  return content.replace(/<([A-Z_]+)>[\s\S]*?<\/\1>/g, '').trim()
}

/** Tool output without the "Created At / Completed At" header agy puts first. */
function resultText(content: string): { text: string; stdout?: string; error: boolean } {
  const text = content.replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+\n?/, '').trimEnd()
  const code = text.match(/exited with code (-?\d+)/)
  const out = text.match(/\nOutput:\n([\s\S]*)$/) ?? text.match(/^Output:\n([\s\S]*)$/)
  return {
    text,
    stdout: out ? out[1].replace(/\r\n/g, '\n').trimEnd() : undefined,
    error: (code ? code[1] !== '0' : false) || /^(error|failed)\b/i.test(text),
  }
}

const GOAL_DONE = '<!-- GOAL_COMPLETE -->'

/** Holds an Antigravity conversation in memory; later lines for the same step replace earlier ones. */
export class AntigravityDoc {
  private steps = new Map<number, any>()

  apply(rec: any) {
    if (rec && typeof rec === 'object' && typeof rec.step_index === 'number') this.steps.set(rec.step_index, rec)
  }

  items(meta: TranscriptMeta): ChatItem[] {
    const out: Draft[] = []
    const pending: { id: string; name: string }[] = []
    meta.stats.turns = 0
    meta.stats.startedAt = undefined
    meta.goal = undefined
    meta.tasks.clear()
    const calls = new Map<string, { name: string; input: any }>()
    for (const idx of [...this.steps.keys()].sort((a, b) => a - b)) {
      const s = this.steps.get(idx)
      const content = typeof s.content === 'string' ? s.content : ''
      const base = { uuid: `s${idx}`, ts: s.created_at ?? '' }
      const timestamp = Date.parse(base.ts)
      if (Number.isFinite(timestamp) && (!meta.stats.startedAt || timestamp < Date.parse(meta.stats.startedAt))) meta.stats.startedAt = new Date(timestamp).toISOString()
      if (s.type === 'USER_INPUT') {
        const model = content.match(/`Model Selection` from .*? to (.+?)\. /)
        if (model) meta.model = model[1]
        const text = userText(content)
        // "/goal …" keeps agy working until it writes the GOAL_COMPLETE marker
        const goal = text.match(/^\/goal\s+([\s\S]+)$/)
        if (goal) {
          meta.goal = { condition: goal[1].trim(), met: false, ts: base.ts }
          out.push({ kind: 'goal', ...base, condition: meta.goal.condition, met: false })
        } else if (text) out.push({ kind: 'user', ...base, text, images: 0 })
        pending.length = 0
        continue
      }
      if (s.type === 'PLANNER_RESPONSE') {
        const msgId = `s${idx}`
        if (typeof s.thinking === 'string' && s.thinking.trim()) out.push({ kind: 'assistant', ...base, uuid: `${msgId}:t`, msgId, model: meta.model, block: { type: 'thinking', text: s.thinking.trim() } })
        const done = content.includes(GOAL_DONE)
        const text = content.replaceAll(GOAL_DONE, '').trim()
        if (text) out.push({ kind: 'assistant', ...base, uuid: `${msgId}:x`, msgId, model: meta.model, block: { type: 'text', text } })
        if (done && meta.goal && !meta.goal.met) {
          meta.goal = { ...meta.goal, met: true, ts: base.ts }
          out.push({ kind: 'goal', ...base, uuid: `${msgId}:g`, condition: meta.goal.condition, met: true })
        }
        for (const [n, tc] of (Array.isArray(s.tool_calls) ? s.tool_calls : []).entries()) {
          const id = `${msgId}:${n}`
          const mapped = mapAgyTool(String(tc?.name ?? 'tool'), tc?.args ?? {})
          out.push({ kind: 'assistant', ...base, uuid: id, msgId, model: meta.model, block: { type: 'tool_use', id, name: mapped.name, input: mapped.input } })
          pending.push({ id, name: mapped.name })
          calls.set(id, mapped)
        }
        if (typeof s.input_tokens === 'number') {
          // the whole prompt: agy counts the cached part separately from input_tokens
          meta.stats.contextTokens = s.input_tokens + (typeof s.cache_read_tokens === 'number' ? s.cache_read_tokens : 0)
          const at = Date.parse(s.created_at ?? '')
          if (!Number.isNaN(at)) meta.stats.contextAt = at
        }
        if (content.trim() && !s.tool_calls?.length) meta.stats.turns++
        continue
      }
      // notices agy injects for the model (restarts, reminders) are not tool output, but one may
      // say a background task finished
      if (s.source === 'SYSTEM' || s.type === 'SYSTEM_MESSAGE') {
        const done = content.match(/Task id "([^"]+)" finished with result:\s*([\s\S]*?)\s*(?:Log: \S+\s*)?<\/SYSTEM_MESSAGE>/)
        const t = done && meta.tasks.get(done[1])
        if (t && t.status === 'running') {
          const code = done[2].match(/exited with code (-?\d+)/)?.[1]
          t.status = code && code !== '0' ? 'failed' : 'completed'
          t.summary = done[2].replace(/\r/g, '').trim().slice(0, 400)
          t.endedAt = base.ts
          out.push({ kind: 'notice', ...base, level: t.status === 'failed' ? 'warn' : 'info', subtype: 'task', text: `Background shell "${t.description}" ${t.status === 'failed' ? 'failed' : 'finished'}` })
        }
        continue
      }
      // anything else answers the oldest tool call still waiting
      const call = pending.shift()
      if (call && content) {
        const r = resultText(content)
        // a command that outlives its wait becomes a background task with a log file
        const bg = content.match(/running as a background task with task id: (\S+)/)
        if (bg) {
          const input = calls.get(call.id)?.input ?? {}
          meta.tasks.set(bg[1], {
            id: bg[1],
            type: 'shell',
            description: input.description ?? content.match(/Task Description: (.*)/)?.[1] ?? bg[1],
            command: typeof input.command === 'string' ? input.command : undefined,
            outputFile: content.match(/Task logs are available at: file:\/\/(\S+)/)?.[1],
            status: 'running',
            startedAt: base.ts,
          })
          out.push({ kind: 'tool_result', ...base, toolUseId: call.id, isError: false, text: `Running in the background (${bg[1].split('/').pop()})`, meta: { taskId: bg[1] } })
          continue
        }
        out.push({
          kind: 'tool_result',
          ...base,
          toolUseId: call.id,
          isError: r.error || s.status === 'ERROR',
          text: r.text.slice(0, 8000),
          meta: call.name === 'Bash' && r.stdout !== undefined ? { stdout: r.stdout.slice(0, 8000) } : undefined,
        })
      } else if (!call && /error/i.test(String(s.type)) && content.trim()) {
        out.push({ kind: 'notice', ...base, level: 'error', subtype: 'info', text: content.trim().slice(0, 2000) })
      }
    }
    return out.map((d, seq) => ({ ...d, seq }) as ChatItem)
  }
}

const unix = (v: unknown) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? Math.round(v / 1000) : v
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? undefined : Math.round(t / 1000)
}

const bucket = (q: any): RateWindow | undefined =>
  q && typeof q.remaining_fraction === 'number' ? { pct: Math.max(0, Math.min(100, (1 - q.remaining_fraction) * 100)), resetsAt: unix(q.reset_time) } : undefined

/** "Gemini 3.8 Flash (High)" → "Gemini 3.8 Flash" */
export const agyModelName = (display?: string) => display?.replace(/\s*\((?:low|medium|high|minimal|xhigh|max)\)\s*$/i, '').trim()

export function agyMode(data: any): string | undefined {
  const mode = data?.cycle_mode ?? data?.execution_mode
  return typeof mode === 'string' ? mode.toLowerCase().replace(/_/g, '-') : undefined
}

/**
 * Live numbers from agy's status line payload (saved per pane by Inyon's wrapper). Ignored when
 * it was written before this process started or names another conversation.
 */
export function agyStatus(
  pr: { agyStatus: Map<string, { ts: number; data: any }>; agyIntegration?: 'installed' | 'missing' },
  pane: string,
  startedAt: number,
  conversation?: string,
): (AgentStatus & { title?: string; state?: string; mode?: string; queued?: number; confirming?: boolean }) | undefined {
  const st = pr.agyStatus.get(pane)
  if (pr.agyIntegration === 'missing') return undefined
  if (!st || st.ts < startedAt - 5) return undefined
  const d = st.data ?? {}
  if (conversation && d.conversation_id && d.conversation_id !== conversation) return undefined
  const cw = d.context_window ?? {}
  const display: string | undefined = d.model?.display_name
  // Claude and GPT models draw on the "3p" quota; Gemini models on their own
  const group = /claude|gpt/i.test(display ?? '') ? '3p' : 'gemini'
  const size = typeof cw.context_window_size === 'number' && cw.context_window_size > 0 ? cw.context_window_size : undefined
  const used = typeof cw.total_input_tokens === 'number' && cw.total_input_tokens > 0 ? cw.total_input_tokens : undefined
  return {
    model: agyModelName(display),
    modelId: typeof d.model?.id === 'string' ? d.model.id : undefined,
    effort: d.model?.effort,
    costUsd: typeof d.cost?.total_cost_usd === 'number' && Number.isFinite(d.cost.total_cost_usd) ? d.cost.total_cost_usd : undefined,
    durationMs: typeof d.cost?.total_duration_ms === 'number' && Number.isFinite(d.cost.total_duration_ms) ? d.cost.total_duration_ms : undefined,
    version: d.version,
    contextPct: size && typeof cw.used_percentage === 'number' ? cw.used_percentage : undefined,
    contextUsed: used,
    contextSize: size,
    fiveHour: bucket(d.quota?.[`${group}-5h`]),
    sevenDay: bucket(d.quota?.[`${group}-weekly`]),
    plan: d.plan_tier,
    updatedAt: st.ts * 1000,
    title: d.conversation_title || undefined,
    state: d.agent_state,
    mode: agyMode(d),
    queued: typeof d.pending_input_count === 'number' ? d.pending_input_count : undefined,
    confirming: d.tool_confirmation_pending === true,
  }
}
