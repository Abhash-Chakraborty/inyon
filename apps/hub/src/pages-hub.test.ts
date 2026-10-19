import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PageEntry, PageOpen, PhoneClaimResult, PhonePairCode } from '@inyon/protocol'
import { errorPage, etagOf, viewHeaders } from './features/pages-core.ts'

// Pages in the real hub, started as a process with a throwaway home and data folder: a site added
// through the API, opened, served under /v/, revoked and removed, and the refusal of cookie /api
// calls from framed pages. The exact /v/ answers are checked in features/pages.test.ts; here the
// point is that the hub's wiring adds nothing to them and never looks at a cookie.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inyon-pages-hub-'))
const home = path.join(root, 'home')
const dataDir = path.join(root, 'data')
const siteDir = path.join(root, 'sites', 'plan')
let hub: ReturnType<typeof Bun.spawn> | undefined
let base = ''
let cookie = ''
const IGNORED = ['date', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']

beforeAll(async () => {
  fs.mkdirSync(home, { recursive: true })
  fs.cpSync(new URL('../../../fixtures/pages/site/', import.meta.url), siteDir, { recursive: true })
  hub = Bun.spawn([process.execPath, path.join(import.meta.dir, 'index.ts')], {
    env: { ...process.env, HOME: home, INYON_DATA_DIR: dataDir, PORT: '0', BIND: '127.0.0.1', NODE_ENV: 'test' },
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
  void (async () => {
    while (!(await reader.read()).done);
  })()
  const code = fs.readFileSync(path.join(dataDir, 'setup-code'), 'utf8').trim()
  const r = await call('POST', '/api/setup', { body: { password: 'correct horse battery', code } })
  expect(r.status).toBe(200)
  cookie = r.headers.get('set-cookie')!.split(';')[0]!
}, 40_000)

afterAll(() => {
  hub?.kill()
  fs.rmSync(root, { recursive: true, force: true })
})

type As = { cookie?: boolean; token?: string; headers?: Record<string, string>; body?: unknown }
const call = (method: string, p: string, as: As = {}) =>
  fetch(`${base}${p}`, {
    method,
    headers: {
      ...(as.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(as.cookie ? { cookie } : {}),
      ...(as.token ? { authorization: `Bearer ${as.token}` } : {}),
      ...as.headers,
    },
    ...(as.body === undefined ? {} : { body: JSON.stringify(as.body) }),
  })
const headerSet = (r: Response) => Object.fromEntries([...r.headers].filter(([k]) => !IGNORED.includes(k)))
const open = async (as: As = { cookie: true }, slug = 'fixture') => (await (await call('POST', `/api/pages/local/${slug}/open`, as)).json()) as PageOpen
const tokenOf = (url: string) => url.split('/')[2]!

test('a folder added through the API is listed with its progress and written to ~/.inyon/pages.json', async () => {
  const r = await call('POST', '/api/pages/local', { cookie: true, body: { path: siteDir } })
  expect(r.status).toBe(200)
  const entry = (await r.json()) as PageEntry
  expect(entry).toMatchObject({ host: 'local', slug: 'fixture', name: 'Fixture site', folder: siteDir, by: 'app', progress: { done: 1, total: 3 } })
  const file = JSON.parse(fs.readFileSync(path.join(home, '.inyon', 'pages.json'), 'utf8'))
  expect(file.pages.map((p: any) => [p.slug, p.path])).toEqual([['fixture', siteDir]])
  const list = (await (await call('GET', '/api/pages', { cookie: true })).json()) as { pages: PageEntry[] }
  expect(list.pages).toEqual([entry])
  expect((await call('GET', '/api/pages')).status).toBe(401)
})

test('an entry written by hand (the CLI, Blueprint) shows up without a restart', async () => {
  const other = path.join(root, 'sites', 'other')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, 'index.html'), '<!doctype html><title>Other</title>')
  const file = path.join(home, '.inyon', 'pages.json')
  const now = JSON.parse(fs.readFileSync(file, 'utf8'))
  now.pages.push({ slug: 'other', name: 'Other', path: other, project: other, by: 'cli', added: 1 })
  fs.writeFileSync(file, JSON.stringify(now))
  const later = new Date(Date.now() + 2000)
  fs.utimesSync(file, later, later)
  const list = (await (await call('GET', '/api/pages', { cookie: true })).json()) as { pages: PageEntry[] }
  expect(list.pages.map((p: PageEntry) => p.slug)).toEqual(['fixture', 'other'])
  expect((await call('DELETE', '/api/pages/local/other', { cookie: true })).status).toBe(200)
})

test('/v/ serves the site with exactly the sandbox headers, and never reads or sets a cookie', async () => {
  const { url, expires } = await open()
  expect(url).toMatch(/^\/v\/v1\.[\w-]+\.[\w-]{43}\/$/)
  expect(expires).toBeGreaterThan(Date.now() + 11.9 * 3600_000)
  const plain = await fetch(`${base}${url}`)
  expect(plain.status).toBe(200)
  const index = fs.statSync(path.join(siteDir, 'index.html'))
  const origin = new URL(base).origin
  expect(headerSet(plain)).toEqual(
    Object.fromEntries(viewHeaders({ origin, token: tokenOf(url), cache: 'no-cache', type: 'text/html;charset=utf-8', etag: etagOf(index.size, index.mtimeMs) })),
  )
  expect(await plain.text()).toBe(fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8'))

  // a signed-in cookie and a phone's bearer change nothing, and nothing is ever set
  const withCredentials = await fetch(`${base}${url}`, { headers: { cookie, authorization: 'Bearer nope' } })
  expect(withCredentials.status).toBe(200)
  expect(headerSet(withCredentials)).toEqual(headerSet(plain))
  for (const r of [plain, withCredentials]) expect(r.headers.get('set-cookie')).toBeNull()

  // nor does a cookie open a bad link
  const bad = await fetch(`${base}/v/v1.e30.${'A'.repeat(43)}/`, { headers: { cookie } })
  expect(bad.status).toBe(403)
  expect(bad.headers.get('set-cookie')).toBeNull()
  expect(headerSet(bad)).toEqual(Object.fromEntries(viewHeaders({ origin, token: null, cache: 'no-store', type: 'text/html;charset=utf-8' })))
  expect(await bad.text()).toBe(errorPage(403))
  expect(errorPage(403)).toContain('Link expired')

  // progress.json is never cached, a Range request gets the whole file
  const progress = await fetch(`${base}${url}progress.json`, { headers: { range: 'bytes=0-3' } })
  expect(progress.status).toBe(200)
  expect(progress.headers.get('cache-control')).toBe('no-store')
  expect(await progress.text()).toBe(fs.readFileSync(path.join(siteDir, 'progress.json'), 'utf8'))
  const head = await fetch(`${base}${url}style.css`, { method: 'HEAD' })
  expect([head.status, head.headers.get('content-length'), await head.text()]).toEqual([200, String(fs.statSync(path.join(siteDir, 'style.css')).size), ''])
})

test('/v/ refuses a Host the hub does not answer to, even with a signed-in cookie', async () => {
  const { url } = await open()
  const r = await fetch(`${base}${url}`, { headers: { host: 'evil.example', cookie } })
  expect(r.status).toBe(421)
  expect(r.headers.get('content-security-policy')).toStartWith('sandbox allow-scripts allow-forms allow-popups allow-downloads;')
})

test('Revoke ends every link made before it', async () => {
  const { url } = await open()
  expect((await fetch(`${base}${url}`)).status).toBe(200)
  expect((await call('POST', '/api/pages/local/fixture/revoke', { cookie: true })).status).toBe(200)
  expect((await fetch(`${base}${url}`)).status).toBe(403)
  expect((await fetch(`${base}${(await open()).url}`)).status).toBe(200)
  expect((await call('POST', '/api/pages/local/nope/revoke', { cookie: true })).status).toBe(404)
})

test("a phone's link is bound to it, and stops when the phone is forgotten", async () => {
  const shown = (await (await call('POST', '/api/phones/pair', { cookie: true, body: { origin: base } })).json()) as PhonePairCode
  const claim = (await (await call('POST', '/api/phones/claim', { body: { code: `${shown.id}:${shown.code}`, name: 'Pixel' } })).json()) as PhoneClaimResult
  const opened = await call('POST', '/api/pages/local/fixture/open', { token: claim.token, headers: { origin: 'http://localhost' } })
  expect(opened.status).toBe(200)
  expect(opened.headers.get('access-control-allow-origin')).toBe('http://localhost')
  const { url } = (await opened.json()) as PageOpen
  const payload = JSON.parse(Buffer.from(tokenOf(url).split('.')[1]!, 'base64url').toString())
  const [phone] = (await (await call('GET', '/api/phones', { cookie: true })).json()) as { id: string }[]
  expect(payload.p).toBe(phone!.id)
  expect((await fetch(`${base}${url}`)).status).toBe(200)
  expect((await call('DELETE', `/api/phones/${phone!.id}`, { cookie: true })).status).toBe(200)
  expect((await fetch(`${base}${url}`)).status).toBe(403)
})

test('cookie /api calls from a framed page (Origin: null) or another site are refused, reads too; a bearer is not', async () => {
  const refused = [
    call('GET', '/api/pages', { cookie: true, headers: { origin: 'null' } }),
    call('GET', '/api/pages', { cookie: true, headers: { 'sec-fetch-site': 'cross-site' } }),
    call('GET', '/api/session', { cookie: true, headers: { origin: 'null' } }),
    call('GET', '/api/hosts', { cookie: true, headers: { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' } }),
    call('POST', '/api/pages/local/fixture/open', { cookie: true, headers: { origin: 'null' } }),
    call('POST', '/api/pages/local/fixture/revoke', { cookie: true, headers: { origin: 'null', 'sec-fetch-site': 'cross-site' } }),
  ]
  for (const r of await Promise.all(refused)) {
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'Cross-site request refused' })
  }
  // the app's own calls, and plain tools with no browser headers, still pass
  expect((await call('GET', '/api/pages', { cookie: true, headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200)
  expect((await call('GET', '/api/pages', { cookie: true, headers: { 'sec-fetch-site': 'none' } })).status).toBe(200)
  expect((await call('GET', '/api/pages', { cookie: true })).status).toBe(200)

  // a paired phone sends a bearer from its own origin, which is cross-site
  const shown = (await (await call('POST', '/api/phones/pair', { cookie: true, body: { origin: base } })).json()) as PhonePairCode
  const claimed = await call('POST', '/api/phones/claim', { body: { code: `${shown.id}:${shown.code}`, name: 'Tablet' }, headers: { origin: 'http://localhost', 'sec-fetch-site': 'cross-site' } })
  expect(claimed.status).toBe(200)
  const { token } = (await claimed.json()) as PhoneClaimResult
  expect((await call('GET', '/api/pages', { token, headers: { origin: 'null' } })).status).toBe(200)
  expect((await call('GET', '/api/pages', { token, headers: { origin: 'http://localhost', 'sec-fetch-site': 'cross-site' } })).status).toBe(200)
})

test('removing a page drops it and its links', async () => {
  const { url } = await open()
  expect((await call('DELETE', '/api/pages/local/fixture', { cookie: true })).status).toBe(200)
  expect((await fetch(`${base}${url}`)).status).toBe(403)
  expect((await call('POST', '/api/pages/local/fixture/open', { cookie: true })).status).toBe(404)
  expect(JSON.parse(fs.readFileSync(path.join(home, '.inyon', 'pages.json'), 'utf8')).pages).toEqual([])
})
