// The Rust phone core as the web app meets it: the wasm module that apps/web/scripts/phone-core.ts
// writes, started and called the way apps/web/src/lib/phone.ts calls the TypeScript one.
// Run it after that script: bun test crates/inyon-phone/js
import { beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PhoneRuntime, PhoneStore, StartPhone } from '../../../apps/hub/src/phone/types.ts'

const dir = join(import.meta.dir, '../../../apps/web/src/phone-core')
let startPhone: StartPhone

/** The app's store, in memory: what it was handed, as it was handed. */
function memoryStore(seed: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(seed))
  const writes: [string, unknown][] = []
  const store: PhoneStore = {
    get: <T>(key: string) => data.get(key) as T | undefined,
    set: (key, value) => {
      writes.push([key, value])
      data.set(key, value)
    },
    del: (key) => void data.delete(key),
    keys: (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)),
  }
  return { store, data, writes }
}

const ssh = {} as never
const home = memoryStore({ hosts: [{ id: 'box', name: 'box', kind: 'ssh', target: 'me@box', hostKey: 'SHA256:x' }] })
let rt: PhoneRuntime

beforeAll(async () => {
  const glue = await import(join(dir, 'inyon_phone.js'))
  glue.initSync({ module: readFileSync(join(dir, 'inyon_phone_bg.wasm')) })
  startPhone = glue.startPhone
  // a start that fails leaves the page free to start it properly
  await expect(startPhone({ ssh } as never)).rejects.toThrow('needs a store')
  rt = await startPhone({ store: home.store, ssh, name: 'Test phone' })
})

const call = async (method: string, path: string, body?: unknown) => {
  const res = await rt.fetch(new Request(`http://localhost${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'content-type': 'application/json' } }))
  return { status: res.status, type: res.headers.get('content-type'), body: await res.json().catch(() => null) }
}

test('the phone is its own hub, with nothing to sign in to', async () => {
  expect(await call('GET', '/api/session')).toEqual({ status: 200, type: 'application/json;charset=utf-8', body: { authed: true, phone: true } })
  expect((await call('POST', '/api/logout')).status).toBe(200)
})

test('a path nothing answers is 404, and a known path asked with the wrong method 405, as JSON', async () => {
  expect(await call('GET', '/api/nothing')).toMatchObject({ status: 404, body: { error: 'Not found' } })
  expect(await call('DELETE', '/api/settings')).toMatchObject({ status: 405, body: { error: 'Method not allowed' } })
})

test("the core's records go to the app's store as values, and come back from it", async () => {
  expect((await call('PUT', '/api/settings', { autoResume: true })).status).toBe(200)
  const [, saved] = home.writes.findLast(([k]) => k === 'settings')!
  expect(saved).toMatchObject({ autoResume: true })
  expect((await call('GET', '/api/settings')).body).toMatchObject({ autoResume: true })
})

test("a body the core can't read is the hub's 400", async () => {
  const res = await rt.fetch(new Request('http://localhost/api/settings', { method: 'PUT', body: '{not json', headers: { 'content-type': 'application/json' } }))
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'Invalid JSON' })
})

test('a screen hears the machines as messages, and its timers run on the page', async () => {
  const heard: any[] = []
  const c = rt.connect((msg) => heard.push(msg))
  c.message(JSON.stringify({ t: 'sub.overview' }))
  await Bun.sleep(20)
  const first = heard.find((m) => m.t === 'overview')
  expect(first.hosts.map((h: any) => h.config.name)).toEqual(['box'])
  // the registry polls it on the core's timers; with no way to reach a server yet, it says so
  const deadline = Date.now() + 8000
  while (!heard.some((m) => m.t === 'overview' && m.hosts[0].status === 'error') && Date.now() < deadline) await Bun.sleep(100)
  expect(heard.findLast((m) => m.t === 'overview').hosts[0]).toMatchObject({ status: 'error' })
  c.close()
  const before = heard.length
  rt.resume()
  await Bun.sleep(300)
  expect(heard.length).toBe(before)
  rt.background(true)
  rt.background(false)
}, 15000)

test('a page runs one core', async () => {
  await expect(startPhone({ store: memoryStore().store, ssh })).rejects.toThrow('already running')
})
