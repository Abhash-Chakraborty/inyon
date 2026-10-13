import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { withPrecacheList } from './lib/precache.ts'

const source = readFileSync(path.join(import.meta.dir, '../public/sw.js'), 'utf8')
const ORIGIN = 'https://hub.example'

/** The worker running in a stand-in browser: a cache store, and its install and activate events. */
function worker(assets: string[], store = new Map<string, Map<string, true>>()) {
  const fetched: string[] = []
  const cache = (name: string) => {
    if (!store.has(name)) store.set(name, new Map())
    const entries = store.get(name)!
    return {
      keys: async () => [...entries.keys()].map((url) => ({ url })),
      addAll: async (urls: string[]) => {
        for (const u of urls) {
          fetched.push(u)
          entries.set(new URL(u, ORIGIN).href, true)
        }
      },
      delete: async (r: { url: string }) => entries.delete(r.url),
    }
  }
  const caches = { open: async (n: string) => cache(n), keys: async () => [...store.keys()], delete: async (n: string) => store.delete(n) }
  const handlers: Record<string, (e: any) => void> = {}
  const self = {
    registration: { scope: ORIGIN + '/' },
    addEventListener: (ev: string, fn: (e: any) => void) => (handlers[ev] = fn),
    skipWaiting() {},
    clients: { claim: async () => {} },
  }
  new Function('self', 'caches', 'location', 'navigator', withPrecacheList(source, assets))(self, caches, new URL(ORIGIN + '/'), { userAgent: 'test' })
  const fire = async (ev: string) => {
    let pending: Promise<unknown> = Promise.resolve()
    handlers[ev]!({ waitUntil: (p: Promise<unknown>) => (pending = p) })
    await pending
  }
  const cached = (name: string) => [...(store.get(name) ?? new Map()).keys()].map((u) => new URL(u).pathname).sort()
  return { fetched, fire, cached, store }
}

test('installing caches the shell and every file of the build', async () => {
  const w = worker(['assets/index-abc.js', 'assets/index-abc.css', 'assets/geist-latin.woff2', 'version.json'])
  await w.fire('install')
  expect(w.cached('inyon-v3')).toEqual([
    '/', '/assets/geist-latin.woff2', '/assets/index-abc.css', '/assets/index-abc.js', '/badge-96.png', '/icon-192.png', '/manifest.webmanifest',
  ])
})

test('a new build fetches only what it added, and activating drops what it no longer has', async () => {
  const first = worker(['assets/index-abc.js', 'assets/geist-latin.woff2'])
  await first.fire('install')
  first.store.set('inyon-v2', new Map([[ORIGIN + '/', true]]))
  const next = worker(['assets/index-def.js', 'assets/geist-latin.woff2'], first.store)
  await next.fire('install')
  expect(next.fetched.filter((u) => u.includes('assets/'))).toEqual(['/assets/index-def.js'])
  await next.fire('activate')
  expect(next.cached('inyon-v3')).toEqual(['/', '/assets/geist-latin.woff2', '/assets/index-def.js', '/badge-96.png', '/icon-192.png', '/manifest.webmanifest'])
  expect([...next.store.keys()]).toEqual(['inyon-v3'])
})

test('the worker source ships with an empty list, which the build fills in', () => {
  expect(source).toMatch(/^const ASSETS = \[\]$/m)
  expect(withPrecacheList(source, ['assets/b.js', 'assets/a.css', 'version.json'])).toContain('const ASSETS = ["assets/a.css","assets/b.js"]')
  expect(() => withPrecacheList('const CACHE = 1', [])).toThrow()
})
