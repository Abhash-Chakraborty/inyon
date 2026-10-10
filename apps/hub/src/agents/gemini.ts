import { sha256Hex } from '../platform/store.ts'
import type { ChatItem } from '@tether/protocol'
import { Host, shq } from '../hosts/host.ts'
import type { TranscriptMeta } from '../claude/transcript.ts'

type Draft = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'seq'> : never) : never

/**
 * Gemini CLI records each session as JSONL under ~/.gemini/tmp/<project>/chats/session-*.jsonl:
 * a metadata line, message records, and `$patch` / `$set` / `$rewindTo` records that edit
 * earlier messages while a reply streams. (Format: packages/core/src/services/chatRecording*.)
 */
export async function guessGeminiSession(
  host: Host,
  home: string,
  proc: { cwd?: string; startedAt: number },
): Promise<string | undefined> {
  const ageMin = Math.max(5, Math.ceil((Date.now() / 1000 - proc.startedAt) / 60) + 2)
  const r = await host.exec(
    `find ${shq(home + '/.gemini/tmp')} -path '*/chats/session-*.json*' -mmin -${ageMin} 2>/dev/null | while read -r f; do echo "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f") $f $(head -c 3000 "$f" | head -n 1)"; done`,
  )
  const hash = proc.cwd ? sha256Hex(proc.cwd) : ''
  const rows = r.stdout
    .split('\n')
    .map((l) => l.match(/^(\d+) (\S+) (.*)$/))
    .filter(Boolean)
    .map((m) => {
      let meta: any = {}
      try {
        meta = JSON.parse(m![3])
      } catch {}
      return { mtime: +m![1], path: m![2], hash: meta.projectHash as string | undefined, dirs: (meta.directories ?? []) as string[], kind: meta.kind }
    })
    .filter((x) => x.kind !== 'subagent')
    .sort((a, b) => b.mtime - a.mtime)
  return rows.find((x) => x.mtime >= proc.startedAt - 2 && (!proc.cwd || x.hash === hash || x.dirs.includes(proc.cwd) || x.path.includes(`/${proc.cwd.split('/').pop()}/`)))?.path
}

const textOf = (c: any): string => {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(textOf).filter(Boolean).join('')
  if (c && typeof c === 'object') return typeof c.text === 'string' ? c.text : ''
  return ''
}

/** Gemini tool names → the names Tether's tool rows know. */
function mapTool(name: string, args: any): { name: string; input: any } {
  const a = args ?? {}
  switch (name) {
    case 'run_shell_command':
      return { name: 'Bash', input: { command: a.command, description: a.description } }
    case 'read_file':
    case 'read_many_files':
      return { name: 'Read', input: { file_path: a.absolute_path ?? a.file_path ?? (a.paths ?? []).join(', ') } }
    case 'write_file':
      return { name: 'Write', input: { file_path: a.file_path ?? a.absolute_path, content: a.content } }
    case 'replace':
    case 'edit':
      return { name: 'Edit', input: { file_path: a.file_path ?? a.absolute_path, old_string: a.old_string, new_string: a.new_string } }
    case 'glob':
      return { name: 'Glob', input: { pattern: a.pattern } }
    case 'search_file_content':
    case 'grep':
      return { name: 'Grep', input: { pattern: a.pattern } }
    case 'list_directory':
      return { name: 'LS', input: { path: a.path ?? a.dir_path } }
    case 'web_fetch':
      return { name: 'WebFetch', input: { url: a.url ?? a.prompt } }
    case 'google_web_search':
      return { name: 'WebSearch', input: { query: a.query } }
    case 'write_todos':
      return { name: 'TodoWrite', input: { todos: (a.todos ?? []).map((t: any) => ({ content: t.description ?? t.content, activeForm: t.description, status: t.status === 'in_progress' ? 'in_progress' : t.status === 'completed' ? 'completed' : 'pending' })) } }
    default:
      return { name, input: a }
  }
}

/** Holds a Gemini session in memory, applying records in order. */
export class GeminiDoc {
  private order: string[] = []
  private messages = new Map<string, any>()
  meta: { summary?: string; model?: string; tokens?: any } = {}

  apply(rec: any) {
    if (!rec || typeof rec !== 'object') return
    if (rec.$rewindTo) {
      const i = this.order.indexOf(rec.$rewindTo)
      if (i >= 0) for (const id of this.order.splice(i)) this.messages.delete(id)
      return
    }
    if (rec.$set) {
      if (rec.$set.summary) this.meta.summary = rec.$set.summary
      if (Array.isArray(rec.$set.messages)) {
        this.order = []
        this.messages.clear()
        for (const m of rec.$set.messages) this.put(m)
      }
      return
    }
    if (rec.$patch) {
      const p = rec.$patch
      for (const u of [...(p.updates ?? []), ...(p.id ? [p] : [])]) {
        const m = this.messages.get(u.id)
        if (!m) continue
        if (u.content !== undefined) m.content = u.content
        for (const tc of u.toolCalls ?? []) {
          const t = (m.toolCalls ?? []).find((x: any) => x.id === tc.id)
          if (t && tc.result !== undefined) t.result = tc.result
        }
      }
      for (const id of p.removeIds ?? []) {
        this.messages.delete(id)
        this.order = this.order.filter((x) => x !== id)
      }
      if (Array.isArray(p.orderIds)) this.order = p.orderIds.filter((id: string) => this.messages.has(id))
      return
    }
    if (rec.sessionId && !rec.id) {
      if (rec.summary) this.meta.summary = rec.summary
      return
    }
    if (rec.id && rec.type) this.put(rec)
  }

  private put(m: any) {
    if (!this.messages.has(m.id)) this.order.push(m.id)
    this.messages.set(m.id, structuredClone(m))
    if (m.type === 'gemini') {
      if (m.model) this.meta.model = m.model
      if (m.tokens) this.meta.tokens = m.tokens
    }
  }

  /** The whole conversation as chat items. */
  items(meta: TranscriptMeta): ChatItem[] {
    const out: Draft[] = []
    meta.stats.turns = 0
    for (const id of this.order) {
      const m = this.messages.get(id)
      if (!m) continue
      const base = { uuid: m.id, ts: m.timestamp ?? '' }
      const text = textOf(m.displayContent ?? m.content).trim()
      if (m.type === 'user') {
        if (text) out.push({ kind: 'user', ...base, text, images: 0 })
      } else if (m.type === 'gemini') {
        for (const [n, t] of (m.thoughts ?? []).entries()) {
          const body = [t.subject, t.description].filter(Boolean).join(': ')
          if (body) out.push({ kind: 'assistant', ...base, uuid: `${m.id}:t${n}`, msgId: m.id, block: { type: 'thinking', text: body } })
        }
        if (text) out.push({ kind: 'assistant', ...base, uuid: `${m.id}:x`, msgId: m.id, model: m.model, block: { type: 'text', text } })
        for (const tc of m.toolCalls ?? []) {
          const mapped = mapTool(tc.name, tc.args)
          out.push({ kind: 'assistant', ...base, uuid: `${m.id}:${tc.id}`, msgId: m.id, block: { type: 'tool_use', id: tc.id, name: mapped.name, input: mapped.input } })
          if (tc.status === 'success' || tc.status === 'error' || tc.status === 'cancelled' || tc.result) {
            const display = typeof tc.resultDisplay === 'string' ? tc.resultDisplay : ''
            out.push({
              kind: 'tool_result',
              ...base,
              uuid: `${m.id}:${tc.id}:r`,
              toolUseId: tc.id,
              isError: tc.status === 'error',
              text: (display || textOf(tc.result?.[0]?.functionResponse?.response?.output ?? tc.result)).slice(0, 8000),
              meta: mapped.name === 'Bash' ? { stdout: display.slice(0, 8000) } : undefined,
            })
          }
        }
        meta.stats.turns++
      } else if (m.type === 'info' || m.type === 'warning' || m.type === 'error') {
        if (text) out.push({ kind: 'notice', ...base, level: m.type === 'info' ? 'info' : m.type === 'warning' ? 'warn' : 'error', subtype: 'info', text })
      }
    }
    if (this.meta.summary) meta.title = this.meta.summary
    if (this.meta.model) meta.model = this.meta.model
    if (this.meta.tokens) {
      const t = this.meta.tokens
      meta.stats.contextTokens = (t.input ?? 0) + (t.cached ?? 0)
      meta.status = { model: this.meta.model, contextUsed: meta.stats.contextTokens, updatedAt: Date.now() }
    }
    return out.map((d, seq) => ({ ...d, seq }) as ChatItem)
  }
}
