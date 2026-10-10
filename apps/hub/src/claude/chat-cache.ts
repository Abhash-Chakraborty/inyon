import type { ChatInfo, ChatItem } from '@tether/protocol'
import { keyPart, kv } from '../platform/store.ts'

/**
 * The latest part of each conversation on a remote machine, kept on the hub's disk, so a
 * session on a machine that dropped off (NetBird or Tailscale down, laptop asleep) can still be
 * read. It's replaced by the live transcript as soon as the machine answers again.
 */
const KEEP = 200
const storeKey = (key: string) => `chats/${keyPart(key)}`

export interface CachedChat {
  sessionId?: string
  transcript?: string
  info: ChatInfo
  items: ChatItem[]
  savedAt: number
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
