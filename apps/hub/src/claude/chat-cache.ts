import type { AgentKind, ChatInfo, ChatItem } from '@tether/protocol'
import { keyPart, kv } from '../platform/store.ts'
import type { SavedMeta } from './transcript.ts'

/**
 * The latest part of each conversation, kept on the hub's disk (in the phone app, its storage).
 * Opening the chat again shows it at once and reads on from where it stopped, so a long session
 * isn't read from the start after hours away or after the app was closed. A session on a machine
 * that dropped off (NetBird or Tailscale down, laptop asleep) can still be read meanwhile.
 */
export const KEEP = 300
/**
 * Bumped when reading a transcript changes how the summary is built (tasks, queue, subagents), so
 * a chat saved by an older reader is read again from the start instead of carrying its mistakes on
 */
export const READER = 2
const storeKey = (key: string) => `chats/${keyPart(key)}`

export interface CachedChat {
  sessionId?: string
  transcript?: string
  /** the agent process the conversation belongs to (see procOf in watcher.ts) */
  proc?: string
  info: ChatInfo
  items: ChatItem[]
  savedAt: number
  /** where reading the transcript stopped, with the summary built up to there */
  /** `older`: the file offset of the line the first saved message came from (0: nothing before it) */
  at?: { offset: number; seq: number; codex: boolean; agent?: AgentKind; meta: SavedMeta; older?: number; reader?: number }
}

export function loadChat(key: string): CachedChat | undefined {
  return kv.get<CachedChat>(storeKey(key))
}

export function saveChat(key: string, chat: Omit<CachedChat, 'savedAt' | 'items'> & { items: ChatItem[] }) {
  try {
    kv.set(storeKey(key), { ...chat, items: chat.items.slice(-KEEP), savedAt: Date.now() })
  } catch (e) {
    console.error('chat cache:', (e as Error).message)
  }
}

/** Drops cached conversations of a removed machine, and any older than 30 days. */
export function pruneChats(hostId?: string) {
  try {
    const old = Date.now() - 30 * 86_400_000
    for (const k of kv.keys('chats/')) {
      if ((hostId && k.startsWith(`chats/${keyPart(hostId)}_`)) || (kv.get<CachedChat>(k)?.savedAt ?? 0) < old) kv.del(k)
    }
  } catch {}
}
