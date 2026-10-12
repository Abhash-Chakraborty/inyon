import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

/**
 * Where the core keeps its small JSON records (machine list, settings, drafts, last-seen
 * snapshots, chat caches). The hub keeps them as files under ~/.inyon; the phone app keeps them
 * in its own storage. Keys look like file paths without the extension: "hosts", "chats/abc".
 */
export interface Store {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
  del(key: string): void
  /** keys under a prefix such as "chats/" */
  keys(prefix: string): string[]
}

/** Until a real store is plugged in (and in tests), records live in memory. */
export function memoryStore(): Store {
  const data = new Map<string, string>()
  return {
    get: (key) => {
      const raw = data.get(key)
      return raw === undefined ? undefined : JSON.parse(raw)
    },
    set: (key, value) => void data.set(key, JSON.stringify(value)),
    del: (key) => void data.delete(key),
    keys: (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)),
  }
}

let current: Store = memoryStore()

/** Plug in the platform's store. Call it before importing anything that reads records. */
export function useStore(store: Store) {
  current = store
}

export const kv: Store = {
  get: (key) => current.get(key),
  set: (key, value) => current.set(key, value),
  del: (key) => current.del(key),
  keys: (prefix) => current.keys(prefix),
}

/** A file-name-safe form of an id, for keys like "chats/<id>". */
export const keyPart = (s: string) => s.replace(/[^\w.-]/g, '_')

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const sha256Hex = (text: string) => bytesToHex(nobleSha256(utf8ToBytes(text)))
