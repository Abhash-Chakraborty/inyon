import type { ChatItem } from '@inyon/protocol'
import { shq, type Host } from '../hosts/host.ts'
import type { TranscriptMeta } from '../claude/transcript.ts'

type Draft = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'seq'> : never) : never

/** Prefer locks held by the detected process, then its nearest descendants (npm launcher). */
export function pickCopilotSession(locks: string[], processes: { pid: number; ppid: number }[], proc: { pid: number; resume?: string }): string | undefined {
  if (!Number.isSafeInteger(proc.pid) || proc.pid <= 0) return undefined
  let level = new Set([proc.pid])
  const visited = new Set<number>()
  for (let depth = 0; depth <= 4 && level.size; depth++) {
    const sessions = [...new Set(locks.filter((file) => {
      const match = file.match(/\/inuse\.(\d+)\.lock$/)
      return !!match && level.has(Number(match[1]))
    }).map((file) => file.replace(/\/inuse\.\d+\.lock$/, '/events.jsonl')))]
    if (sessions.length) {
      if (proc.resume) {
        const exact = sessions.find((file) => file.split('/').at(-2) === proc.resume)
        if (exact) return exact
      }
      return sessions.length === 1 ? sessions[0] : undefined
    }
    for (const pid of level) visited.add(pid)
    level = new Set(processes.filter((p) => level.has(p.ppid) && !visited.has(p.pid)).map((p) => p.pid))
  }
  return undefined
}

/** Copilot's inuse lock identifies ownership without guessing from cwd or newest transcript. */
export async function guessCopilotSession(host: Host, home: string, proc: { pid: number; resume?: string }): Promise<string | undefined> {
  if (!Number.isSafeInteger(proc.pid) || proc.pid <= 0) return undefined
  const root = `${home}/.copilot/session-state`
  const [locks, tree] = await Promise.all([
    host.exec(`find ${shq(root)} -mindepth 2 -maxdepth 2 -name 'inuse.*.lock' -print 2>/dev/null`),
    host.exec('ps -eo pid=,ppid='),
  ])
  const processes = tree.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]) }] : []
  })
  return pickCopilotSession(locks.stdout.split('\n').filter(Boolean), processes, proc)
}

function tool(name: string, a: any = {}) {
  switch (name) {
    case 'bash': case 'powershell': case 'local_shell': return { name: 'Bash', input: { command: a.command, description: a.description } }
    case 'view': return { name: 'Read', input: { file_path: a.path } }
    case 'create': return { name: 'Write', input: { file_path: a.path, content: a.file_text } }
    case 'edit': return { name: 'Edit', input: { file_path: a.path, old_string: a.old_str, new_string: a.new_str } }
    case 'grep': return { name: 'Grep', input: { pattern: a.pattern, path: a.path } }
    case 'glob': return { name: 'Glob', input: { pattern: a.pattern, path: a.path } }
    case 'web_fetch': return { name: 'WebFetch', input: { url: a.url } }
    default: return { name, input: a }
  }
}
const clip = (text: unknown, max = 24_000) => typeof text === 'string' ? text.slice(0, max) : ''

/** Official SDK event schema: github/copilot-sdk nodejs/src/generated/session-events.ts. */
export function normalizeCopilot(e: any, meta: TranscriptMeta): Draft[] {
  if (!e || typeof e !== 'object' || !e.data || e.agentId) return []
  const d = e.data
  const base = { uuid: String(e.id ?? ''), ts: String(e.timestamp ?? '') }
  switch (e.type) {
    case 'session.start':
      meta.version = d.copilotVersion
      meta.cwd = d.context?.cwd
      meta.model = d.selectedModel
      meta.effort = d.reasoningEffort
      meta.stats.startedAt = d.startTime ?? e.timestamp
      return []
    case 'session.title_changed': meta.title = d.title; return []
    case 'session.model_change':
      meta.model = d.newModel
      meta.effort = d.reasoningEffort ?? undefined
      return []
    case 'session.permissions_changed':
      meta.mode = d.mode ?? (d.allowAllPermissionMode === 'auto' ? 'assisted' : d.allowAllPermissions === true ? 'allow-all' : d.allowAllPermissions === false ? 'default' : meta.mode)
      return []
    case 'user.message':
      return d.content ? [{ kind: 'user', ...base, text: clip(d.content), images: (d.attachments ?? []).filter((a: any) => /image\//.test(a.mimeType ?? '')).length }] : []
    case 'assistant.message': {
      // Tool requests are also followed by execution_start records. Render once, at execution.
      const text = clip(d.content)
      return text ? [{ kind: 'assistant', ...base, msgId: d.messageId ?? base.uuid, model: d.model, block: { type: 'text', text } }] : []
    }
    case 'assistant.reasoning': {
      const text = clip(d.content)
      return text ? [{ kind: 'assistant', ...base, msgId: d.reasoningId ?? base.uuid, block: { type: 'thinking', text } }] : []
    }
    case 'tool.user_requested': case 'tool.execution_start': {
      if (!d.toolCallId || !d.toolName) return []
      const mapped = tool(d.toolName, d.arguments)
      meta.tools.set(d.toolCallId, mapped)
      const out: Draft[] = []
      if (e.type === 'tool.user_requested' && d.toolName === 'local_shell') out.push({ kind: 'user', ...base, uuid: base.uuid + ':input', text: '!' + (d.arguments?.command ?? ''), images: 0 })
      out.push({ kind: 'assistant', ...base, msgId: base.uuid, block: { type: 'tool_use', id: d.toolCallId, ...mapped } })
      return out
    }
    case 'tool.execution_complete': {
      const text = clip(d.result?.detailedContent ?? d.result?.content ?? d.error?.message, 8000)
      return [{ kind: 'tool_result', ...base, toolUseId: d.toolCallId, text, isError: d.success === false, meta: meta.tools.get(d.toolCallId)?.name === 'Bash' ? { stdout: text } : undefined }]
    }
    case 'assistant.turn_end':
      meta.stats.turns++
      return [{ kind: 'turn_end', ...base, durationMs: 0 }]
    case 'session.compaction_complete':
      if (d.success !== false) { meta.stats.compactions++; meta.stats.contextTokens = undefined }
      return []
    case 'session.usage_info':
      if (typeof d.currentTokens === 'number') meta.stats.contextTokens = d.currentTokens
      meta.status = { ...meta.status, model: meta.model, modelId: meta.model, effort: meta.effort, contextUsed: d.currentTokens, contextSize: d.tokenLimit, contextPct: d.tokenLimit > 0 ? d.currentTokens / d.tokenLimit * 100 : undefined, updatedAt: Date.parse(e.timestamp) || Date.now() }
      return []
    // assistant.usage.cost is a model multiplier / AI-credit measure, NOT dollars.
    case 'session.error': case 'session.warning':
      return [{ kind: 'notice', ...base, level: e.type === 'session.error' ? 'error' : 'warn', subtype: 'info', text: clip(d.message ?? d.error) }]
    default: return []
  }
}
