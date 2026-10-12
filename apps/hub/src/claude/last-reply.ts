import type { ChatItem } from '@inyon/protocol'
import { shq } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { normalizeCodex } from '../agents/codex.ts'
import { newMeta, normalize } from './transcript.ts'
import { TranscriptReader } from './transcript-tail.ts'
import { watchers } from './watcher.ts'

/** The agent's last words in its latest turn (none once you've spoken since). */
export function replyOf(items: ChatItem[]) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'user') return undefined
    if (it.kind === 'assistant' && it.block.type === 'text' && it.block.text.trim()) return it.block.text
  }
  return undefined
}

/** Markdown to one plain line, cut at a word near `max` characters. */
export function plainLine(md: string, max = 180) {
  const s = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).trimEnd()}…`
}

/**
 * What a "finished" notification says: the start of the agent's reply. From the open chat when
 * there is one, otherwise from the end of its transcript file. Undefined when it can't tell.
 */
export async function lastReply(hostId: string, paneId: string): Promise<string | undefined> {
  const w = watchers.peek(hostId, paneId)
  if (w?.following) {
    const r = replyOf(w.items)
    return r && plainLine(r)
  }
  const agent = registry.findPane(hostId, paneId)?.pane.agent
  const path = agent?.transcriptPath
  if (!path || !path.endsWith('.jsonl') || (agent.kind !== 'claude' && agent.kind !== 'codex')) return undefined
  const out = await registry.host(hostId).exec(`tail -c 262144 ${shq(path)} 2>/dev/null`, { timeoutMs: 4000 })
  const meta = newMeta()
  const reader = new TranscriptReader()
  const items: ChatItem[] = []
  // the first line is usually cut short; it doesn't parse and is skipped
  for (const line of out.stdout.split('\n')) {
    const e = reader.line(line)?.entry
    if (!e) continue
    try {
      items.push(...((agent.kind === 'codex' ? normalizeCodex(e, meta) : normalize(e, meta)) as ChatItem[]))
    } catch {}
  }
  const r = replyOf(items)
  return r && plainLine(r)
}
