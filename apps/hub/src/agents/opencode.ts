import type { ChatItem } from '@inyon/protocol'
import { Host } from '../hosts/host.ts'
import type { TranscriptMeta } from '../claude/transcript.ts'
import { opencodeRequest } from './opencode-api.ts'

type Draft = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'seq'> : never) : never

/**
 * OpenCode's terminal app talks to its own local HTTP server (the same API `opencode serve`
 * exposes): /session, /session/{id}/message, /permission, /event. Inyon finds that server's port
 * from the process's listening sockets and reads the same session you see in tmux. (beta)
 */
export function selectOpenCodeSession(sessions: any[], cwd?: string, explicitSession?: string, title?: string): string | undefined {
  const mine = sessions.filter((s) => typeof s?.id === 'string' && (!cwd || s.directory === cwd))
  if (explicitSession) return mine.find((s) => s.id === explicitSession)?.id
  const roots = mine.filter((s) => !s.parentID && !s.time?.archived)
  // the terminal's title names the conversation on screen ("OC | <title>"): with several in the
  // folder, that's the one (the newest when two share a title)
  if (title) {
    const named = roots.filter((s) => s.title === title).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    if (named.length) return named[0].id
  }
  // There is no endpoint for the TUI's active session. Never guess another conversation.
  return roots.length === 1 ? roots[0].id : undefined
}
/** The TUI puts the conversation's title in the terminal title: "OC | <title>". */
export const titledSession = (paneTitle?: string) => paneTitle?.match(/^OC \| (.+)$/)?.[1]?.trim()

export async function opencodeEndpoint(host: Host, pid: number, cwd?: string, paneTitle?: string): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  const [sockets, process, children] = await Promise.all([
    host.exec('ss -ltnpH 2>/dev/null'),
    host.exec(`cat /proc/${pid}/cmdline 2>/dev/null`),
    host.exec(`pgrep -P ${pid} 2>/dev/null`),
  ])
  const args = process.stdout.split('\0').filter(Boolean)
  const index = args.findIndex((arg) => arg === '--session' || arg === '-s')
  const explicit = index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith('--session='))?.slice(10)
  const pids = new Set([String(pid), ...children.stdout.trim().split(/\s+/)])
  const ports = sockets.stdout.split('\n').filter((line) => [...line.matchAll(/pid=(\d+),/g)].some((m) => pids.has(m[1])))
    .map((line) => line.trim().split(/\s+/)[3]?.match(/:(\d+)$/)?.[1]).filter(Boolean)
  for (const port of new Set(ports)) {
    const base = `http://127.0.0.1:${port}`
    const healthy = await opencodeGet(host, `${base}/global/health`)
    if (healthy?.healthy !== true) continue
    const list = await opencodeGet(host, `${base}/session${cwd ? `?directory=${encodeURIComponent(cwd)}` : ''}`)
    if (!Array.isArray(list)) continue
    const session = selectOpenCodeSession(list, cwd, explicit, titledSession(paneTitle))
    if (session) return `opencode://127.0.0.1:${port}/${session}`
    // the home screen: no conversation yet (its own title says so), or none in this folder
    if (!list.length || paneTitle?.trim() === 'OpenCode') return `opencode://127.0.0.1:${port}/`
  }
  return undefined
}

export const parseEndpoint = (uri: string) => {
  const m = uri.match(/^opencode:\/\/(127\.0\.0\.1):(\d+)\/([^?#]*)$/)
  return m ? { base: `http://${m[1]}:${m[2]}`, session: m[3] } : undefined
}
/** OpenCode started with --port has an HTTP API; plain `opencode` is read from its database and driven through its screen */
export const viaOpenCodeApi = (uri?: string) => !!uri?.startsWith('opencode://')

export async function opencodeGet(host: Host, url: string): Promise<any> {
  try { return await opencodeRequest(host, url) } catch { return undefined }
}

export async function opencodePost(host: Host, url: string, body: unknown): Promise<boolean> {
  try { return (await opencodeRequest(host, url, 'POST', body)) !== false } catch { return false }
}

function mapTool(tool: string, input: any): { name: string; input: any } {
  const a = input ?? {}
  switch (tool) {
    case 'bash':
      return { name: 'Bash', input: { command: a.command, description: a.description } }
    case 'read':
      return { name: 'Read', input: { file_path: a.filePath ?? a.path } }
    case 'write':
      return { name: 'Write', input: { file_path: a.filePath, content: a.content } }
    case 'edit':
      return { name: 'Edit', input: { file_path: a.filePath, old_string: a.oldString, new_string: a.newString } }
    case 'patch':
      return { name: 'ApplyPatch', input: { patch: a.patchText ?? a.patch } }
    case 'glob':
      return { name: 'Glob', input: { pattern: a.pattern } }
    case 'grep':
      return { name: 'Grep', input: { pattern: a.pattern } }
    case 'list':
      return { name: 'LS', input: { path: a.path } }
    case 'webfetch':
      return { name: 'WebFetch', input: { url: a.url } }
    case 'todowrite':
      return { name: 'TodoWrite', input: { todos: (a.todos ?? []).map((t: any) => ({ content: t.content, activeForm: t.content, status: t.status })) } }
    case 'task':
      return { name: 'Agent', input: { description: a.description, prompt: a.prompt, subagent_type: a.subagent_type } }
    // same shape as Claude's question tool
    case 'question':
      return { name: 'AskUserQuestion', input: { questions: a.questions } }
    default:
      return { name: tool, input: a }
  }
}

/** OpenCode messages ({info, parts}[]) → chat items. */
export function opencodeItems(messages: any[], meta: TranscriptMeta): ChatItem[] {
  const out: Draft[] = []
  let cost = 0
  let hasCost = false
  meta.stats.turns = 0
  for (const msg of messages ?? []) {
    const info = msg.info ?? msg
    const parts: any[] = msg.parts ?? []
    const ts = info.time?.created ? new Date(info.time.created).toISOString() : ''
    const base = { uuid: info.id, ts }
    if (!meta.stats.startedAt && info.time?.created) meta.stats.startedAt = new Date(info.time.created).toISOString()
    const model = info.model?.modelID ?? info.modelID
    const provider = info.model?.providerID ?? info.providerID
    if (model) meta.model = provider ? `${provider}/${model}` : model
    if (info.agent) meta.mode = info.agent
    if (info.role === 'user') {
      meta.effort = info.variant
      meta.stats.turns++
      const text = parts.filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('\n').trim()
      if (text) out.push({ kind: 'user', ...base, text, images: parts.filter((p) => p.type === 'file').length })
      else if (parts.some((p) => p.type === 'text' && p.synthetic && p.text === 'The following tool was executed by the user')) {
        const result = messages.find((m) => m.info?.parentID === info.id && m.parts?.some((p: any) => p.type === 'tool' && p.tool === 'bash'))
        const command = result?.parts.find((p: any) => p.type === 'tool' && p.tool === 'bash')?.state?.input?.command
        if (typeof command === 'string') out.push({ kind: 'user', ...base, text: command, images: 0, shell: true })
      }
      continue
    }
    if (info.variant) meta.effort = info.variant
    // stopping a turn isn't a failure
    if (info.error?.name === 'MessageAbortedError') out.push({ kind: 'notice', ...base, uuid: `${info.id}:error`, level: 'info', subtype: 'interrupted', text: 'Stopped' })
    else if (info.error) out.push({ kind: 'notice', ...base, uuid: `${info.id}:error`, level: 'error', subtype: 'api_error', text: String(info.error.data?.message ?? info.error.message ?? info.error.name ?? 'OpenCode request failed') })
    if (typeof info.cost === 'number') { cost += info.cost; hasCost = true }
    // the context is what the last reply with usage took, counting everything the TUI's sidebar
    // counts: input, output, reasoning and both kinds of cache
    const t = info.tokens
    if (t && ((t.output ?? 0) > 0 || (t.total ?? 0) > 0)) {
      meta.stats.contextTokens = typeof t.total === 'number' ? t.total : (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
      const at = info.time?.completed ?? info.time?.created
      if (at) meta.stats.contextAt = at
    }
    for (const p of parts) {
      const pb = { ...base, uuid: p.id ?? `${info.id}:${out.length}`, msgId: info.id }
      if (p.type === 'text' && p.text?.trim()) out.push({ kind: 'assistant', ...pb, model: info.modelID, block: { type: 'text', text: p.text } })
      else if (p.type === 'reasoning' && p.text?.trim()) out.push({ kind: 'assistant', ...pb, block: { type: 'thinking', text: p.text } })
      else if (p.type === 'tool') {
        const id = p.callID ?? p.id
        const st = p.state ?? {}
        const mapped = mapTool(p.tool, st.input)
        out.push({ kind: 'assistant', ...pb, block: { type: 'tool_use', id, name: mapped.name, input: mapped.input } })
        if (st.status === 'completed' || st.status === 'error') {
          const text = String(st.output ?? st.error ?? '').slice(0, 8000)
          out.push({ kind: 'tool_result', ...base, uuid: `${pb.uuid}:r`, toolUseId: id, isError: st.status === 'error', text, meta: mapped.name === 'Bash' ? { stdout: text } : undefined })
        }
      }
    }
  }
  meta.stats.costUsd = hasCost ? cost : undefined
  meta.status = { model: meta.model, modelId: meta.model, effort: meta.effort, contextUsed: meta.stats.contextTokens, costUsd: meta.stats.costUsd, updatedAt: Date.now() }
  return out.map((d, seq) => ({ ...d, seq }) as ChatItem)
}
