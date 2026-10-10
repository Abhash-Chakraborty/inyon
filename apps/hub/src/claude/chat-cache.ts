import fs from 'node:fs'
import path from 'node:path'
import type { ChatInfo, ChatItem } from '@tether/protocol'
import { DATA_DIR } from '../config.ts'

/**
 * The latest part of each conversation on a remote machine, kept on the hub's disk, so a
 * session on a machine that dropped off (NetBird or Tailscale down, laptop asleep) can still be
 * read. It's replaced by the live transcript as soon as the machine answers again.
 */
const DIR = path.join(DATA_DIR, 'chats')
const KEEP = 200
const file = (key: string) => path.join(DIR, `${key.replace(/[^\w.-]/g, '_')}.json`)

export interface CachedChat {
  sessionId?: string
  transcript?: string
  info: ChatInfo
  items: ChatItem[]
  savedAt: number
}

export function loadChat(key: string): CachedChat | undefined {
  try {
    return JSON.parse(fs.readFileSync(file(key), 'utf8')) as CachedChat
  } catch {
    return
  }
}

export function saveChat(key: string, chat: Omit<CachedChat, 'savedAt' | 'items'> & { items: ChatItem[] }) {
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
    const f = file(key)
    const tmp = `${f}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ ...chat, items: chat.items.slice(-KEEP), savedAt: Date.now() }), { mode: 0o600 })
    fs.renameSync(tmp, f)
  } catch (e) {
    console.error('chat cache:', (e as Error).message)
  }
}

/** Drops cached conversations of a removed machine, and any older than 30 days. */
export function pruneChats(hostId?: string) {
  try {
    const old = Date.now() - 30 * 86_400_000
    for (const f of fs.readdirSync(DIR)) {
      const p = path.join(DIR, f)
      if ((hostId && f.startsWith(`${hostId.replace(/[^\w.-]/g, '_')}_`)) || fs.statSync(p).mtimeMs < old) fs.rmSync(p, { force: true })
    }
  } catch {}
}
