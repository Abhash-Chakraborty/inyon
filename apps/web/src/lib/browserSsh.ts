import type { SshPlugin } from '@inyon/phone'

/**
 * The web app's stand-in for the Android app's SSH plugin. A browser can't open SSH connections,
 * so the core reaches computers only through `inyon pair` links, and a server goes through a
 * paired computer. What it does keep is the secret store: the phone's identity key lives here.
 *
 * Secrets sit in IndexedDB, sealed with AES-GCM under a key the browser made non-extractable:
 * the page can use it, but nothing (this page included) can read the key out.
 */
export const NO_SSH = 'A browser can’t connect over SSH. Add the server through a paired computer, or use the Android app.'

const DB = 'inyon-secrets'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('keys')
      req.result.createObjectStore('secrets')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function run<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store))
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
  })
}

let sealing: Promise<{ db: IDBDatabase; key: CryptoKey }> | undefined

/** The database and the sealing key, made on first use. */
const ready = () =>
  (sealing ??= (async () => {
    const db = await open()
    let key = await run<CryptoKey | undefined>(db, 'keys', 'readonly', (s) => s.get('seal'))
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      await run(db, 'keys', 'readwrite', (s) => s.put(key, 'seal'))
    }
    return { db, key }
  })())

const refuse = () => Promise.reject(new Error(NO_SSH))
const enc = new TextEncoder()
const dec = new TextDecoder()

export function browserSsh(): SshPlugin {
  return {
    probe: refuse,
    connect: refuse,
    disconnect: async () => undefined,
    exec: refuse,
    stream: refuse,
    streamKill: async () => undefined,
    pty: refuse,
    ptyWrite: refuse,
    ptyResize: async () => undefined,
    ptyKill: async () => undefined,
    async setSecret({ key, value }) {
      const { db, key: seal } = await ready()
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, seal, enc.encode(value)))
      await run(db, 'secrets', 'readwrite', (s) => s.put({ iv, data }, key))
    },
    async getSecret({ key }) {
      const { db, key: seal } = await ready()
      const row = await run<{ iv: Uint8Array<ArrayBuffer>; data: Uint8Array<ArrayBuffer> } | undefined>(db, 'secrets', 'readonly', (s) => s.get(key))
      if (!row) return { value: null }
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv }, seal, row.data)
      return { value: dec.decode(plain) }
    },
    async deleteSecret({ key }) {
      const { db } = await ready()
      await run(db, 'secrets', 'readwrite', (s) => s.delete(key))
    },
    // nothing streams without SSH
    addListener: () => ({ remove() {} }),
  } as SshPlugin
}
