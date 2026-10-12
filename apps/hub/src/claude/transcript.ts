import type { AgentStatus, ArtifactInfo, BackgroundTask, ChatItem, SessionStats, SubagentInfo, ToolResultMeta } from '@tether/protocol'

/** Distributive Omit so each ChatItem variant keeps its own fields. */
type Draft = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'seq'> : never) : never

const MAX_TEXT = 24_000
const MAX_TOOL_INPUT_STRING = 60_000

/** Claude saves a long paste wrapped in <pasted_content> tags; the message is what's inside. */
const unwrapPaste = (s: string) => s.replace(/<\/?pasted_content\b[^>]*>/g, '').trim()

const clip = (s: string, max = MAX_TEXT) =>
  s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false }

/** Running summary of a session, built while reading its transcript. */
export interface TranscriptMeta {
  title?: string
  customTitle?: string
  mode?: string
  model?: string
  effort?: string
  cwd?: string
  gitBranch?: string
  version?: string
  status?: AgentStatus
  stats: SessionStats
  goal?: { condition: string; met: boolean; reason?: string; ts: string }
  rc?: { url: string; ts: string }
  queue: string[]
  tasks: Map<string, BackgroundTask>
  subagents: Map<string, SubagentInfo>
  artifacts: Map<string, ArtifactInfo>
  tools: Map<string, { name: string; input: any }>
}

export const newMeta = (): TranscriptMeta => ({
  stats: { turns: 0, compactions: 0 },
  queue: [],
  tasks: new Map(),
  subagents: new Map(),
  artifacts: new Map(),
  tools: new Map(),
})

/** A summary as JSON, to save with a conversation's cached copy (the recent tool calls only). */
export type SavedMeta = Omit<TranscriptMeta, 'tasks' | 'subagents' | 'artifacts' | 'tools'> & {
  tasks: [string, BackgroundTask][]
  subagents: [string, SubagentInfo][]
  artifacts: [string, ArtifactInfo][]
  tools: [string, { name: string; input: any }][]
}

export const saveMeta = (m: TranscriptMeta): SavedMeta => ({
  ...m,
  tasks: [...m.tasks],
  subagents: [...m.subagents],
  artifacts: [...m.artifacts],
  // a tool's result follows its call closely, so only the latest calls can still be answered
  tools: [...m.tools].slice(-200),
})

export const loadMeta = (s: SavedMeta): TranscriptMeta => ({
  ...s,
  tasks: new Map(s.tasks),
  subagents: new Map(s.subagents),
  artifacts: new Map(s.artifacts),
  tools: new Map(s.tools),
})

/** Strips huge strings from tool inputs (e.g. Write content) while keeping structure. */
function trimInput(v: any, depth = 0): any {
  if (typeof v === 'string') return v.length > MAX_TOOL_INPUT_STRING ? v.slice(0, MAX_TOOL_INPUT_STRING) + '\n…' : v
  if (depth > 6 || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimInput(x, depth + 1))
  const o: any = {}
  for (const k in v) o[k] = trimInput(v[k], depth + 1)
  return o
}

function blockText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
}

const tag = (s: string, name: string) => {
  const m = s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return m ? m[1] : undefined
}

const kTokens = (n?: number) => (n === undefined ? '?' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

function resultMeta(tur: any): ToolResultMeta | undefined {
  if (!tur || typeof tur !== 'object' || Array.isArray(tur)) return undefined
  const meta: ToolResultMeta = {}
  if (Array.isArray(tur.structuredPatch) && tur.structuredPatch.length) {
    meta.patch = tur.structuredPatch.slice(0, 60).map((h: any) => ({
      oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines,
      lines: (h.lines ?? []).slice(0, 400),
    }))
  }
  if (typeof tur.filePath === 'string') meta.filePath = tur.filePath
  if (tur.type === 'create' || tur.type === 'update') meta.created = tur.type === 'create'
  if (typeof tur.stdout === 'string') meta.stdout = clip(tur.stdout, 8000).text
  if (typeof tur.stderr === 'string' && tur.stderr) meta.stderr = clip(tur.stderr, 4000).text
  if (tur.interrupted) meta.interrupted = true
  if (tur.answers && typeof tur.answers === 'object') meta.answers = tur.answers
  if (typeof tur.plan === 'string') meta.plan = tur.plan
  if (tur.file && typeof tur.file.numLines === 'number') meta.numLines = tur.file.numLines
  if (typeof tur.backgroundTaskId === 'string') meta.taskId = tur.backgroundTaskId
  else if (typeof tur.taskId === 'string') meta.taskId = tur.taskId
  return Object.keys(meta).length ? meta : undefined
}

/**
 * `<task-notification>` blocks report background tasks finishing. The same notification shows up
 * in several transcript lines, so a notice comes back only the first time a task finishes.
 */
function taskNotification(meta: TranscriptMeta, text: string, base: { uuid: string; ts: string }): Draft[] {
  const ts = base.ts
  const id = tag(text, 'task-id')
  if (!id) return []
  const status = tag(text, 'status') ?? 'completed'
  const failed = /fail|error|killed/.test(status)
  const notice = (msg: string): Draft[] => [{ kind: 'notice', ...base, level: failed ? 'warn' : 'info', subtype: 'task', text: msg }]
  const sub = meta.subagents.get(tag(text, 'tool-use-id') ?? '')
  if (sub) {
    const was = sub.status
    sub.status = failed ? 'error' : 'done'
    // a background subagent is also listed as a task from its start; it ends here too
    const task = meta.tasks.get(id)
    if (task?.status === 'running') {
      task.status = failed ? 'failed' : /stop/.test(status) ? 'stopped' : 'completed'
      task.endedAt = ts
    }
    return was === 'running' ? notice(tag(text, 'summary') ?? `Subagent "${sub.description}" ${failed ? 'failed' : 'finished'}`) : []
  }
  const cur = meta.tasks.get(id)
  const fresh = !cur || cur.status === 'running'
  meta.tasks.set(id, {
    id,
    type: cur?.type ?? 'shell',
    description: cur?.description ?? tag(text, 'summary') ?? id,
    command: cur?.command,
    outputFile: tag(text, 'output-file') ?? cur?.outputFile,
    status: /fail|error|killed/.test(status) ? 'failed' : /stop/.test(status) ? 'stopped' : 'completed',
    summary: tag(text, 'summary'),
    startedAt: cur?.startedAt,
    endedAt: ts,
  })
  if (!fresh) return []
  const what = cur?.type === 'monitor' ? 'Monitor' : cur?.type === 'workflow' ? 'Workflow' : 'Background shell'
  return notice(tag(text, 'summary') ?? `${what} "${cur?.description ?? id}" ${failed ? 'failed' : /stop/.test(status) ? 'stopped' : 'finished'}`)
}

/**
 * Converts one Claude Code transcript line into zero or more chat items, and keeps the running
 * session summary in `meta` up to date. Bookkeeping lines produce no items.
 */
export function normalize(e: any, meta: TranscriptMeta, opts: { sidechain?: boolean } = {}): Draft[] {
  if (!e || typeof e !== 'object') return []
  const base = { uuid: e.uuid ?? crypto.randomUUID(), ts: e.timestamp ?? '' }
  if (e.cwd) meta.cwd = e.cwd
  if (e.gitBranch) meta.gitBranch = e.gitBranch
  if (e.version) meta.version = e.version

  switch (e.type) {
    case 'ai-title':
      meta.title = e.aiTitle
      return []
    case 'custom-title':
      meta.customTitle = e.customTitle
      return []
    case 'permission-mode':
      meta.mode = e.permissionMode
      return []
    case 'cost-state':
      meta.stats.costUsd = e.totalCostUSD
      meta.stats.durationMs = e.totalDuration
      meta.stats.apiDurationMs = e.totalAPIDuration
      meta.stats.linesAdded = e.totalLinesAdded
      meta.stats.linesRemoved = e.totalLinesRemoved
      if (e.startTime) meta.stats.startedAt = new Date(e.startTime).toISOString()
      return []
    case 'queue-operation': {
      const c = String(e.content ?? '')
      if (c.startsWith('<task-notification>')) return e.operation === 'enqueue' ? taskNotification(meta, c, base) : []
      if (e.operation === 'enqueue') meta.queue.push(unwrapPaste(c))
      // pressing Esc/↑ pulls every queued message back into the input box at once
      else if (e.operation === 'popAll') meta.queue.length = 0
      else {
        // a message from another session is logged with different attributes on its
        // <cross-session-message …> tag when it's queued and when it's taken: compare what's inside
        const i = meta.queue.findIndex((q) => queueKey(q) === queueKey(unwrapPaste(c)))
        if (i >= 0) meta.queue.splice(i, 1)
        else if (e.operation === 'dequeue' && meta.queue.length) meta.queue.shift()
      }
      return []
    }
    case 'attachment':
      return attachmentItems(e, base, meta)
    case 'system':
      return systemItem(e, base, meta)
    case 'assistant': {
      if (e.isSidechain && !opts.sidechain) return []
      const msg = e.message ?? {}
      if (msg.model && msg.model !== '<synthetic>') meta.model = msg.model
      const u = msg.usage
      if (u && typeof u.input_tokens === 'number') {
        meta.stats.contextTokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
        meta.stats.contextAt = Date.parse(base.ts) || undefined
      }
      const out: Draft[] = []
      for (const b of msg.content ?? []) {
        const common = { kind: 'assistant' as const, ...base, msgId: msg.id ?? base.uuid, model: msg.model }
        if (b.type === 'text' && b.text?.trim()) {
          out.push({ ...common, uuid: `${base.uuid}:${out.length}`, block: { type: 'text', text: clip(b.text).text } })
        } else if (b.type === 'thinking' && b.thinking?.trim()) {
          out.push({ ...common, uuid: `${base.uuid}:${out.length}`, block: { type: 'thinking', text: clip(b.thinking).text } })
        } else if (b.type === 'tool_use') {
          trackToolUse(meta, b, base.ts)
          out.push({
            ...common,
            uuid: `${base.uuid}:${out.length}`,
            block: { type: 'tool_use', id: b.id, name: b.name, input: trimInput(b.input) },
          })
        }
      }
      return out
    }
    case 'user':
      return userItems(e, base, meta, opts.sidechain)
  }
  return []
}

function trackToolUse(meta: TranscriptMeta, b: any, ts: string) {
  const input = b.input ?? {}
  meta.tools.set(b.id, { name: b.name, input: { description: input.description, command: input.command, run_in_background: input.run_in_background, task_id: input.task_id, subagent_type: input.subagent_type, prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 4000) : undefined, name: input.name } })
  if (meta.tools.size > 4000) meta.tools.delete(meta.tools.keys().next().value!)
  if (b.name === 'Agent' || b.name === 'Task') {
    meta.subagents.set(b.id, {
      toolUseId: b.id,
      type: input.subagent_type,
      description: input.description ?? input.subagent_type ?? 'Subagent',
      prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 4000) : undefined,
      status: 'running',
      background: !!input.run_in_background,
      startedAt: ts,
    })
  }
}

function trackToolResult(meta: TranscriptMeta, toolUseId: string, isError: boolean, tur: any, ts: string) {
  // a command that runs past its timeout moves to the background without asking to, so a long
  // conversation's summary may not hold the call; a background task ID alone says it was Bash
  const use = meta.tools.get(toolUseId) ?? (typeof tur?.backgroundTaskId === 'string' ? { name: 'Bash', input: {} } : undefined)
  if (!use) return
  const sub = meta.subagents.get(toolUseId)
  if (sub) {
    // background subagents return immediately; they finish later via a task notification
    if (!(sub.background && tur?.isAsync)) sub.status = isError ? 'error' : 'done'
  }
  const taskId = tur?.backgroundTaskId ?? tur?.taskId
  if (taskId && (use.name === 'Bash' || use.name === 'Monitor' || use.name === 'Workflow')) {
    meta.tasks.set(taskId, {
      id: taskId,
      type: use.name === 'Bash' ? 'shell' : use.name === 'Monitor' ? 'monitor' : 'workflow',
      description: use.input.description ?? use.input.name ?? taskId,
      command: typeof use.input.command === 'string' ? use.input.command : undefined,
      status: 'running',
      startedAt: ts,
    })
  }
  if ((use.name === 'TaskStop' || use.name === 'KillShell') && use.input.task_id) {
    const t = meta.tasks.get(use.input.task_id)
    if (t) {
      t.status = 'stopped'
      t.endedAt = ts
    }
  }
  if (use.name === 'Artifact' && typeof tur?.url === 'string') {
    meta.artifacts.set(tur.url, { url: tur.url, title: tur.title ?? meta.artifacts.get(tur.url)?.title, updatedAt: ts })
  }
}

const queueKey = (text: string) => text.replace(/^<cross-session-message\b[^>]*>/, '<cross-session-message>')

function attachmentItems(e: any, base: { uuid: string; ts: string }, meta: TranscriptMeta): Draft[] {
  const a = e.attachment
  if (!a) return []
  switch (a.type) {
    case 'queued_command':
      if (typeof a.prompt !== 'string') return []
      if (a.prompt.startsWith('<task-notification>')) return taskNotification(meta, a.prompt, base)
      if (a.humanTurn) return [{ kind: 'user', ...base, text: unwrapPaste(String(a.prompt ?? '')), images: 0, queued: true }]
      return []
    case 'goal_status': {
      const prev = meta.goal
      // "/goal clear" is recorded as a met goal with the sentinel flag: the goal is gone, not achieved
      if (a.sentinel && a.met) {
        meta.goal = undefined
        return prev && !prev.met ? [{ kind: 'goal', ...base, condition: prev.condition, met: false, cleared: true }] : []
      }
      meta.goal = { condition: a.condition ?? '', met: !!a.met, reason: a.reason, ts: base.ts }
      if (!prev || prev.condition !== meta.goal.condition || prev.met !== meta.goal.met) {
        return [{ kind: 'goal', ...base, condition: meta.goal.condition, met: meta.goal.met, reason: a.reason }]
      }
      return []
    }
    case 'task_status': {
      if (!a.taskId) return []
      const cur = meta.tasks.get(a.taskId)
      const status = String(a.status ?? 'running')
      meta.tasks.set(a.taskId, {
        id: a.taskId,
        type: a.taskType === 'local_bash' ? 'shell' : /monitor/.test(a.taskType ?? '') ? 'monitor' : /workflow/.test(a.taskType ?? '') ? 'workflow' : cur?.type ?? 'other',
        description: a.description ?? cur?.description ?? a.taskId,
        command: a.shell?.command ?? cur?.command,
        outputFile: a.outputFilePath ?? cur?.outputFile,
        status: status === 'running' ? 'running' : /fail|error/.test(status) ? 'failed' : /kill|stop/.test(status) ? 'stopped' : 'completed',
        startedAt: cur?.startedAt ?? base.ts,
        endedAt: status === 'running' ? undefined : base.ts,
      })
      return []
    }
  }
  return []
}

function systemItem(e: any, base: { uuid: string; ts: string }, meta: TranscriptMeta): Draft[] {
  switch (e.subtype) {
    case 'turn_duration':
      meta.stats.turns++
      return [{ kind: 'turn_end', ...base, durationMs: e.durationMs ?? 0 }]
    case 'compact_boundary': {
      meta.stats.compactions++
      const m = e.compactMetadata ?? {}
      // what's left after compacting is the context now, until the next reply reports usage
      meta.stats.compactedAt = meta.stats.contextAt = Date.parse(base.ts) || undefined
      meta.stats.contextTokens = typeof m.postTokens === 'number' ? m.postTokens : undefined
      const how = m.trigger === 'auto' ? 'Auto-compacted' : 'Compacted'
      const text = m.preTokens ? `${how} · ${kTokens(m.preTokens)} → ${kTokens(m.postTokens)} tokens` : 'Conversation compacted'
      return [{ kind: 'notice', ...base, level: 'info', subtype: 'compact', text }]
    }
    case 'bridge_status':
      if (typeof e.url === 'string') meta.rc = { url: e.url, ts: base.ts }
      return [{ kind: 'notice', ...base, level: 'info', subtype: 'rc', text: String(e.content ?? 'Remote Control is active') }]
    case 'away_summary':
      return [{ kind: 'notice', ...base, level: 'info', subtype: 'recap', text: String(e.content ?? '').replace(/\s*\(disable recaps.*\)$/, '') }]
    case 'api_error':
      return [{ kind: 'notice', ...base, level: 'error', subtype: 'api_error', text: String(e.content || e.error?.message || 'API error') }]
    case 'local_command': {
      const c = String(e.content ?? '')
      const name = tag(c, 'command-name')
      if (name) return [{ kind: 'command', ...base, name, args: tag(c, 'command-args') ?? '' }]
      const out = tag(c, 'local-command-stdout') ?? tag(c, 'local-command-stderr')
      if (out !== undefined) {
        if (/Remote Control disconnected/i.test(out)) meta.rc = undefined
        return [{ kind: 'command', ...base, name: '', args: '', output: out }]
      }
      return []
    }
    case 'informational':
      if (e.level === 'warning' || e.level === 'error') {
        return [{ kind: 'notice', ...base, level: e.level === 'error' ? 'error' : 'warn', subtype: 'info', text: String(e.content ?? '') }]
      }
      return []
  }
  return []
}

function userItems(e: any, base: { uuid: string; ts: string }, meta: TranscriptMeta, sidechain = false): Draft[] {
  if (e.isSidechain && !sidechain) return []
  const content = e.message?.content
  if (e.isCompactSummary) return []

  // tool results
  if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')) {
    const out: Draft[] = []
    for (const b of content) {
      if (b?.type !== 'tool_result') continue
      // tool output is shown collapsed; 8k chars is plenty and keeps first loads light on phones
      const { text, truncated } = clip(blockText(b.content), 8000)
      trackToolResult(meta, b.tool_use_id, !!b.is_error, e.toolUseResult, base.ts)
      out.push({
        kind: 'tool_result',
        ...base,
        uuid: `${base.uuid}:${out.length}`,
        toolUseId: b.tool_use_id,
        isError: !!b.is_error,
        text,
        truncated,
        meta: resultMeta(e.toolUseResult),
      })
    }
    return out
  }

  const text = blockText(content)
  if (text.includes('<task-notification>')) return taskNotification(meta, text, base)
  if (e.isMeta) return []
  const images = Array.isArray(content) ? content.filter((b: any) => b?.type === 'image').length : 0

  // slash commands and their output
  const cmd = tag(text, 'command-name')
  if (cmd) return [{ kind: 'command', ...base, name: cmd, args: tag(text, 'command-args') ?? '' }]
  const stdout = tag(text, 'local-command-stdout')
  if (stdout !== undefined) {
    if (/Remote Control disconnected/i.test(stdout)) meta.rc = undefined
    return [{ kind: 'command', ...base, name: '', args: '', output: stdout }]
  }
  if (text.includes('<local-command-caveat>')) return []

  // "!" shell mode
  const bashIn = tag(text, 'bash-input')
  if (bashIn !== undefined) return [{ kind: 'user', ...base, text: bashIn, images: 0, shell: true }]
  const bashOut = tag(text, 'bash-stdout')
  if (bashOut !== undefined) {
    const err = tag(text, 'bash-stderr')
    return [{ kind: 'command', ...base, name: '!', args: '', output: [bashOut, err].filter(Boolean).join('\n') }]
  }

  if (/^\[Request interrupted by user/.test(text)) {
    return [{ kind: 'notice', ...base, level: 'warn', subtype: 'interrupted', text: 'Interrupted' }]
  }
  if (!text.trim() && !images) return []
  return [{ kind: 'user', ...base, text: clip(unwrapPaste(text)).text, images }]
}
