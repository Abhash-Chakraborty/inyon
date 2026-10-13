import { afterAll, beforeAll, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VERSION, type PairedPhone, type PhoneClaimResult, type PhonePairCode } from '@inyon/protocol'

// The real hub, started as a process on a free port with a throwaway data folder: what a browser
// and the phone app get over HTTP, with cookies, bearer tokens and the WebSocket.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inyon-hub-test-'))
let hub: ReturnType<typeof Bun.spawn> | undefined
let base = ''
let ws = ''
/** the browser's session, from setting the password */
let cookie = ''

beforeAll(async () => {
  hub = Bun.spawn([process.execPath, path.join(import.meta.dir, 'index.ts')], {
    env: { ...process.env, INYON_DATA_DIR: dataDir, PORT: '0', BIND: '127.0.0.1', INYON_HUB_NAME: 'Test hub', NODE_ENV: 'test' },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const errors = new Response(hub.stderr as ReadableStream).text()
  const reader = (hub.stdout as ReadableStream<Uint8Array>).getReader()
  let out = ''
  while (!/listening on (\S+)/.test(out)) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`the hub stopped:\n${out}\n${await errors}`)
    out += new TextDecoder().decode(value)
  }
  base = out.match(/listening on (\S+)/)![1]!
  ws = base.replace(/^http/, 'ws')
  // keep reading, so the hub never blocks on a full pipe
  void (async () => {
    while (!(await reader.read()).done);
  })()
  // first run: the setup code is written to the data folder
  const code = fs.readFileSync(path.join(dataDir, 'setup-code'), 'utf8').trim()
  const r = await post('/api/setup', { password: 'correct horse battery', code })
  expect(r.status).toBe(200)
  cookie = r.headers.get('set-cookie')!.split(';')[0]!
}, 40_000)

afterAll(() => {
  hub?.kill()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

type As = { cookie?: boolean | string; token?: string; origin?: string }
const headers = (as: As): Record<string, string> => ({
  'content-type': 'application/json',
  ...(as.cookie ? { cookie: as.cookie === true ? cookie : as.cookie } : {}),
  ...(as.token ? { authorization: `Bearer ${as.token}` } : {}),
  ...(as.origin ? { origin: as.origin } : {}),
})
const json = (r: Response) => r.json() as Promise<any>
const get = (p: string, as: As = {}) => fetch(`${base}${p}`, { headers: headers(as) })
const post = (p: string, body: unknown, as: As = {}) => fetch(`${base}${p}`, { method: 'POST', body: JSON.stringify(body), headers: headers(as) })
const del = (p: string, as: As = {}) => fetch(`${base}${p}`, { method: 'DELETE', headers: headers(as) })
const options = (p: string, extra: Record<string, string>) => fetch(`${base}${p}`, { method: 'OPTIONS', headers: { origin: 'http://localhost', ...extra } })

const CORS = {
  'access-control-allow-origin': 'http://localhost',
  vary: 'Origin',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
}
const corsOf = (r: Response) => Object.fromEntries(Object.keys(CORS).map((h) => [h, r.headers.get(h)]))
const NO_CORS = Object.fromEntries(Object.keys(CORS).map((h) => [h, null]))

/** A phone that paired: shows a code in the browser, claims it. */
async function pairPhone(name: string) {
  const shown = (await json(await post('/api/phones/pair', { origin: base }, { cookie: true }))) as PhonePairCode
  const r = await post('/api/phones/claim', { code: `${shown.id}:${shown.code}`, name }, { origin: 'http://localhost' })
  expect(r.status).toBe(200)
  return { shown, claim: r, ...((await r.json()) as PhoneClaimResult) }
}

/** An open WebSocket, with a promise of its close code. */
function connect(url: string, extra?: Record<string, string>) {
  return new Promise<{ socket: WebSocket; closed: Promise<number>; pong: () => Promise<void> }>((resolve, reject) => {
    const socket = new WebSocket(url, extra ? ({ headers: extra } as any) : undefined)
    const closed = new Promise<number>((done) => socket.addEventListener('close', (e) => done(e.code)))
    socket.addEventListener('error', () => reject(new Error(`no connection to ${url}`)))
    socket.addEventListener('open', () =>
      resolve({
        socket,
        closed,
        pong: () =>
          new Promise<void>((done) => {
            socket.addEventListener('message', (e) => JSON.parse(String(e.data)).t === 'pong' && done(), { once: true })
            socket.send(JSON.stringify({ t: 'ping' }))
          }),
      }),
    )
  })
}

test('showing a code takes a sign-in from the last ten minutes, and an http(s) origin', async () => {
  const r = await post('/api/phones/pair', { origin: base }, { cookie: true })
  expect(r.status).toBe(200)
  const shown = (await r.json()) as PhonePairCode
  expect(shown.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
  expect(shown.code).toMatch(/^\d{6}$/)
  expect(shown.expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000)
  const link = new URL(shown.link)
  expect(link.protocol).toBe('inyon:')
  expect([...link.searchParams]).toEqual([
    ['u', base],
    ['c', `${shown.id}:${shown.code}`],
    ['n', 'Test hub'],
  ])
  expect((await post('/api/phones/pair', { origin: 'file:///app' }, { cookie: true })).status).toBe(400)
  expect((await post('/api/phones/pair', { origin: base })).status).toBe(401)

  // a session signed in eleven minutes ago, signed with the hub's own secret
  const { secret } = JSON.parse(fs.readFileSync(path.join(dataDir, 'hub.json'), 'utf8'))
  const then = Date.now() - 11 * 60_000
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 86_400_000, n: 'older', iat: then, at: then })).toString('base64url')
  const old = `inyon_session=${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`
  expect((await json(await get('/api/session', { cookie: old }))).authed).toBe(true)
  const stale = await post('/api/phones/pair', { origin: base }, { cookie: old })
  expect(stale.status).toBe(403)
  expect(await json(stale)).toEqual({ error: 'Sign in again to pair a phone.' })
})

test('a phone claims the code once, then talks to the hub with its token', async () => {
  const phone = await pairPhone('Pixel')
  expect(corsOf(phone.claim)).toEqual(CORS)
  expect(phone.token).toHaveLength(43)
  expect(phone.hub).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), name: 'Test hub', version: VERSION })
  const again = await post('/api/phones/claim', { code: `${phone.shown.id}:${phone.shown.code}`, name: 'Twice' })
  expect(again.status).toBe(404)
  expect(await json(again)).toEqual({ error: 'That code has expired. Show a new one on the hub.' })

  // the token signs in where the cookie would, and gets CORS answers; a bare request gets neither
  const session = await get('/api/session', { token: phone.token, origin: 'http://localhost' })
  expect((await json(session)).authed).toBe(true)
  expect(session.headers.get('set-cookie')).toBeNull()
  expect(corsOf(session)).toEqual(CORS)
  const anonymous = await get('/api/session', { origin: 'http://localhost' })
  expect((await json(anonymous)).authed).toBe(false)
  expect(corsOf(anonymous)).toEqual(NO_CORS)
  const browser = await get('/api/session', { cookie: true })
  expect(corsOf(browser)).toEqual(NO_CORS)
  expect((await get('/api/hosts', { token: phone.token })).status).toBe(200)
  expect((await get('/api/hosts', { token: phone.token.slice(1) })).status).toBe(401)

  // the phone is listed for both, and knows itself
  const mine = (await json(await get('/api/phones', { token: phone.token }))) as PairedPhone[]
  expect(mine).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{12}$/), name: 'Pixel', pairedAt: expect.any(Number), lastSeen: expect.any(Number), thisPhone: true }])
  const theirs = (await json(await get('/api/phones', { cookie: true }))) as PairedPhone[]
  expect(theirs).toEqual([{ ...mine[0]!, thisPhone: undefined }])

  // the WebSocket opens with a ticket, once
  const { ticket, hub } = await json(await post('/api/phones/ticket', {}, { token: phone.token }))
  expect(ticket).toHaveLength(43)
  // and says what the hub is now, so the phone's copy of its name and version stays current
  expect(hub).toEqual(phone.hub)
  const live = await connect(`${ws}/ws?ticket=${ticket}`)
  await live.pong()
  live.socket.close()
  expect((await fetch(`${base}/ws?ticket=${ticket}`)).status).toBe(401)
  expect((await post('/api/phones/ticket', {}, { cookie: true })).status).toBe(403)
  // or with the token itself, from code that can send a header
  const direct = await connect(`${ws}/ws`, { authorization: `Bearer ${phone.token}` })
  await direct.pong()
  direct.socket.close()
  expect(connect(`${ws}/ws`, { authorization: 'Bearer nope', cookie })).rejects.toThrow()
})

test('five wrong digits cancel a code', async () => {
  const shown = (await json(await post('/api/phones/pair', { origin: base }, { cookie: true }))) as PhonePairCode
  const wrong = String((Number(shown.code) + 1) % 1_000_000).padStart(6, '0')
  for (let i = 0; i < 5; i++) expect((await post('/api/phones/claim', { code: `${shown.id}:${wrong}`, name: 'Guess' })).status).toBe(401)
  expect((await post('/api/phones/claim', { code: `${shown.id}:${shown.code}`, name: 'Late' })).status).toBe(404)
}, 10_000)

test("a phone can't touch the hub's account or other phones", async () => {
  const phone = await pairPhone('Tablet')
  const [me] = (await json(await get('/api/phones', { token: phone.token }))).filter((p: PairedPhone) => p.thisPhone)
  const refused = [
    post('/api/phones/pair', { origin: base }, { token: phone.token, origin: 'http://localhost' }),
    del(`/api/phones/${me.id}`, { token: phone.token }),
    post('/api/setup', { password: 'x', code: 'x' }, { token: phone.token }),
    post('/api/login', { password: 'correct horse battery' }, { token: phone.token }),
    post('/api/password', { current: 'correct horse battery', next: 'something else' }, { token: phone.token }),
  ]
  for (const r of await Promise.all(refused)) expect(r.status).toBe(403)
  expect(corsOf(await refused[0]!)).toEqual(CORS)
  // still paired, and the password unchanged
  expect((await json(await get('/api/session', { token: phone.token }))).authed).toBe(true)
  expect((await post('/api/login', { password: 'correct horse battery' })).status).toBe(200)
})

test('preflights are answered for the phone; a cookie from another site is still refused', async () => {
  const claim = await options('/api/phones/claim', { 'access-control-request-method': 'POST' })
  expect(claim.status).toBe(204)
  expect(corsOf(claim)).toEqual(CORS)
  const bearer = await options('/api/hosts', { 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' })
  expect(bearer.status).toBe(204)
  expect(corsOf(bearer)).toEqual(CORS)
  expect((await options('/api/hosts', { 'access-control-request-method': 'GET' })).status).toBe(404)
  // the browser's cookie from a page on another origin: as before
  const csrf = await post('/api/refresh', {}, { cookie: true, origin: 'http://evil.example' })
  expect(csrf.status).toBe(403)
  expect(await json(csrf)).toEqual({ error: 'Cross-site request refused' })
  expect(corsOf(csrf)).toEqual(NO_CORS)
})

test('the inyon command on this machine reads the machines over loopback with the local token', async () => {
  const token = fs.readFileSync(path.join(dataDir, 'local-token'), 'utf8').trim()
  expect(token.length).toBeGreaterThanOrEqual(32)
  expect(fs.statSync(path.join(dataDir, 'local-token')).mode & 0o777).toBe(0o600)
  // no token, a wrong one, or a signed-in browser's cookie: refused
  expect((await get('/api/local/nodes')).status).toBe(403)
  expect((await get(`/api/local/nodes?token=${'x'.repeat(token.length)}`)).status).toBe(403)
  expect((await get('/api/local/nodes', { cookie: true })).status).toBe(403)
  const r = await get(`/api/local/nodes?token=${token}`)
  expect(r.status).toBe(200)
  const body = await json(r)
  expect(body.v).toBe(1)
  expect(body.nodes.map((n: any) => [n.id, n.kind])).toContainEqual(['local', 'local'])
  for (const n of body.nodes) expect(Object.keys(n)).not.toContain('config')
  const bearer = await get('/api/local/nodes', { token })
  expect(bearer.status).toBe(200)
})

test('removing a phone closes its connection and ends its token', async () => {
  const phone = await pairPhone('Old phone')
  const [me] = (await json(await get('/api/phones', { token: phone.token }))).filter((p: PairedPhone) => p.thisPhone)
  const { ticket } = await json(await post('/api/phones/ticket', {}, { token: phone.token }))
  const live = await connect(`${ws}/ws?ticket=${ticket}`)
  await live.pong()

  expect((await del(`/api/phones/${me.id}`, { cookie: true })).status).toBe(200)
  expect(await live.closed).toBe(4001)
  expect((await get('/api/hosts', { token: phone.token })).status).toBe(401)
  expect(((await json(await get('/api/phones', { cookie: true }))) as PairedPhone[]).map((p) => p.name)).not.toContain('Old phone')
  expect((await del(`/api/phones/${me.id}`, { cookie: true })).status).toBe(404)
})
