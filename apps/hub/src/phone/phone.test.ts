import { afterAll, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import type { ServerMsg } from '@tether/protocol'
import { memoryStore, useStore } from '../platform/store.ts'
import { setHostBackends } from '../hosts/host.ts'
import { processBackend } from '../hosts/process-backend.ts'
import { startPhone } from './index.ts'
import { registry } from '../hosts/registry.ts'
import type { SshPlugin } from './types.ts'

const FINGERPRINT = 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'

/** A stand-in for the native plugin: every server refuses commands, calls are recorded. */
function fakeSsh() {
  const secrets = new Map<string, string>()
  const calls: { method: string; args: any }[] = []
  const rec = (method: string) => async (args: any) => void calls.push({ method, args })
  const ssh = {
    probe: async (args) => (calls.push({ method: 'probe', args }), { fingerprint: FINGERPRINT, keyType: 'ssh-ed25519' }),
    connect: rec('connect'),
    disconnect: rec('disconnect'),
    exec: async (args) => (calls.push({ method: 'exec', args }), { code: 1, stdout: '', stderr: 'not in this test' }),
    stream: rec('stream'),
    streamKill: rec('streamKill'),
    pty: rec('pty'),
    ptyWrite: rec('ptyWrite'),
    ptyResize: rec('ptyResize'),
    ptyKill: rec('ptyKill'),
    setSecret: async ({ key, value }) => void secrets.set(key, value),
    getSecret: async ({ key }) => ({ value: secrets.get(key) ?? null }),
    deleteSecret: async ({ key }) => void secrets.delete(key),
    addListener: () => ({ remove() {} }),
  } as SshPlugin
  return { ssh, secrets, calls }
}

const { ssh, secrets, calls } = fakeSsh()
// the phone asks GitHub for the newest tether-node release; here it gets a fixed answer
const realFetch = globalThis.fetch
const releaseChecks: string[] = []
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (!String(url).startsWith('https://api.github.com/')) return realFetch(url, init)
  releaseChecks.push(String(url))
  return Response.json({ tag_name: 'v9.9.9' })
}) as typeof fetch
const phone = await startPhone({ store: memoryStore(), ssh })

afterAll(() => {
  globalThis.fetch = realFetch
  // the rest of the suite runs commands locally
  setHostBackends(() => processBackend(path.join(os.tmpdir(), 'tether-test-cm')))
  useStore(memoryStore())
})

const call = async (method: string, url: string, body?: unknown) => {
  const res = await phone.fetch(new Request(`http://phone${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
  return { status: res.status, data: (await res.json()) as any }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

test('the phone looks up the newest tether-node for laptops paired with it', async () => {
  const { nodeUpdates } = await import('../hosts/node-update.ts')
  await until(() => nodeUpdates.latestRelease === '9.9.9')
  expect(releaseChecks).toEqual(['https://api.github.com/repos/Abhash-Chakraborty/tether-releases/releases/latest'])
})

test('the phone needs no sign-in', async () => {
  expect((await call('GET', '/api/session')).data).toMatchObject({ authed: true })
})

test("the phone's key is one OpenSSH ed25519 line, made once", async () => {
  const a = (await call('GET', '/api/phone/key')).data.publicKey as string
  expect(a).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[\w+/]+=* tether-phone$/)
  expect((await call('GET', '/api/phone/key')).data.publicKey).toBe(a)
  expect(secrets.has('phone-key')).toBe(true)
})

test('probing a server reads its fingerprint', async () => {
  const r = await call('POST', '/api/phone/probe', { target: 'me@10.0.0.5', port: 2222 })
  expect(r.data.fingerprint).toBe(FINGERPRINT)
  expect(calls.at(-1)).toEqual({ method: 'probe', args: { host: '10.0.0.5', port: 2222 } })
})

test('a server needs a user and a confirmed fingerprint', async () => {
  expect((await call('POST', '/api/hosts', { name: 'x', target: '10.0.0.5', hostKey: FINGERPRINT })).status).toBe(400)
  expect((await call('POST', '/api/hosts', { name: 'x', target: 'me@10.0.0.5' })).status).toBe(400)
  expect((await call('POST', '/api/hosts', { name: 'x', target: 'me@10.0.0.5', hostKey: FINGERPRINT, auth: 'password' })).status).toBe(400)
})

test('adding, editing and removing a server keeps its secret in the keystore', async () => {
  const add = await call('POST', '/api/hosts', { name: 'Laptop', target: 'me@10.0.0.5', port: 2222, hostKey: FINGERPRINT, auth: 'password', password: 'hunter22' })
  expect(add.status).toBe(200)
  const id = add.data.id as string
  expect(JSON.parse(secrets.get(`server:${id}`)!)).toEqual({ password: 'hunter22' })

  // the first poll connects with the saved password
  await until(() => calls.some((c) => c.method === 'connect' && c.args.id === id))
  const connect = calls.find((c) => c.method === 'connect' && c.args.id === id)!.args
  expect(connect).toMatchObject({ host: '10.0.0.5', port: 2222, username: 'me', hostKey: FINGERPRINT, password: 'hunter22' })
  // commands run through sh, whatever the login shell is
  await until(() => calls.some((c) => c.method === 'exec' && c.args.id === id))
  expect(calls.find((c) => c.method === 'exec' && c.args.id === id)!.args.command).toStartWith("sh -c '")

  const list = await call('GET', '/api/hosts')
  expect(list.data.find((h: any) => h.id === id)).toMatchObject({ name: 'Laptop', auth: 'password', hostKey: FINGERPRINT })
  expect(JSON.stringify(list.data)).not.toContain('hunter22')

  // switching to the phone's key drops the password and reconnects with the key
  expect((await call('PATCH', `/api/hosts/${id}`, { auth: 'phone-key' })).status).toBe(200)
  expect(secrets.has(`server:${id}`)).toBe(false)
  expect(calls.some((c) => c.method === 'disconnect' && c.args.id === id)).toBe(true)
  await until(() => calls.some((c) => c.method === 'connect' && c.args.id === id && c.args.ed25519Seed))

  expect((await call('DELETE', `/api/hosts/${id}`)).status).toBe(200)
  expect((await call('GET', '/api/hosts')).data.some((h: any) => h.id === id)).toBe(false)
})

test('a server that needs no key or password signs in with neither', async () => {
  const add = await call('POST', '/api/hosts', { name: 'Open', target: 'me@10.0.0.7', hostKey: FINGERPRINT, auth: 'none' })
  expect(add.status).toBe(200)
  const id = add.data.id as string
  expect(secrets.has(`server:${id}`)).toBe(false)
  await until(() => calls.some((c) => c.method === 'connect' && c.args.id === id))
  const connect = calls.find((c) => c.method === 'connect' && c.args.id === id)!.args
  expect(connect).toMatchObject({ host: '10.0.0.7', username: 'me', password: '' })
  expect(connect.ed25519Seed).toBeUndefined()
  expect((await call('DELETE', `/api/hosts/${id}`)).status).toBe(200)
})

test('a server can be reached through a paired computer instead of the phone', async () => {
  // only a paired computer can open it
  expect((await call('POST', '/api/hosts', { name: 'DB', target: 'work-db', via: 'nowhere' })).status).toBe(400)
  registry.add({ id: 'jump', name: 'Jump box', kind: 'link', machineId: 'test-machine', urls: [], relays: [] })
  // an alias from the computer's ssh config, no fingerprint and no sign-in of its own
  const add = await call('POST', '/api/hosts', { name: 'DB', target: 'work-db', via: 'jump' })
  expect(add.status).toBe(200)
  const id = add.data.id as string
  const saved = (await call('GET', '/api/hosts')).data.find((h: any) => h.id === id)
  expect(saved).toMatchObject({ kind: 'ssh', target: 'work-db', via: 'jump' })
  expect(saved.hostKey).toBeUndefined()
  expect(saved.auth).toBeUndefined()
  // the phone never dials it itself
  await new Promise((r) => setTimeout(r, 50))
  expect(calls.some((c) => c.method === 'connect' && c.args.id === id)).toBe(false)

  // and back to the phone's own connection: then it needs a fingerprint and a sign-in
  expect((await call('PATCH', `/api/hosts/${id}`, { via: '', target: 'me@10.0.0.9', auth: 'password' })).status).toBe(400)
  expect((await call('PATCH', `/api/hosts/${id}`, { via: '', target: 'me@10.0.0.9', hostKey: FINGERPRINT, auth: 'password', password: 'pw' })).status).toBe(200)
  expect((await call('GET', '/api/hosts')).data.find((h: any) => h.id === id).via).toBeUndefined()
  await call('DELETE', `/api/hosts/${id}`)
  await call('DELETE', '/api/hosts/jump')
})

test('unknown routes and methods are refused', async () => {
  expect((await call('GET', '/api/nope')).status).toBe(404)
  expect((await call('DELETE', '/api/settings')).status).toBe(405)
})

test('a connected screen gets the overview', async () => {
  const got: ServerMsg[] = []
  const c = phone.connect((m) => got.push(m))
  c.message(JSON.stringify({ t: 'sub.overview' }))
  await until(() => got.some((m) => m.t === 'overview'))
  c.close()
})
