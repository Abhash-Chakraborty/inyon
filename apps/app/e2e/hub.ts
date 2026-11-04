// A stand-in hub for the app's browser checks: the page under the hub's own CSP at /next, the
// sign-in endpoints, the pane actions, the chunked upload routes and the /ws2 streams (protocol
// v2), fed made-up data (demo.ts). The React app's build (apps/web/dist), when there is one, is
// served at / over the same data through the v1 /ws socket, so a check can draw both apps side by
// side. Nothing here comes from a real account.
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ServerWebSocket } from 'bun'
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright'
import { accounts, overview, storefront } from './demo.ts'

const root = path.join(import.meta.dir, '../../..')
const dist = process.env.APP_DIST ?? path.join(import.meta.dir, '../dist')
const web = path.join(root, 'apps/web/public')
const reactDist = path.join(root, 'apps/web/dist')
const rs = await Bun.file(path.join(root, 'crates/inyon-hub/src/static_files.rs')).text()
// a debug build (APP_DIST) loads its script from /next/wasm, which the policy doesn't allow
const NEXT_CSP = process.env.APP_DIST ? "frame-ancestors 'none'" : /pub const NEXT_CSP: &str =\s*"([^"]+)"/.exec(rs)![1]!

type Item = Record<string, unknown>
type Stream = { seq: number; items: Item[]; state: Item; older?: Item[] }
type Socket = ServerWebSocket<{ subs: Set<string>; v1: boolean }>

/** A file sent a chunk at a time, as the hub keeps it until it's finished. */
type Upload = { id: string; name: string; size: number; type: string; pane?: string; chunks: Uint8Array[]; received: number }

export const state = {
  authed: true,
  sends: [] as Item[],
  drafts: [] as Item[],
  frames: [] as Item[],
  /** what the upload routes saw: start, put, status, finish, delete */
  calls: [] as string[],
  /** the next this many chunk PUTs answer 503, as a hub whose machine dropped would */
  failChunks: 0,
  /** the next start answers this refusal */
  refuseStart: undefined as undefined | { status: number; error: string },
  /** each chunk waits this long, so progress can be seen */
  chunkDelay: 0,
  chunk: 64 * 1024,
  uploads: new Map<string, Upload>(),
  /** the files that finished, by path */
  saved: new Map<string, { name: string; bytes: Uint8Array; pane?: string }>(),
  /** extra routes a check adds: return a Response to answer, undefined to pass */
  routes: [] as ((req: Request, url: URL) => Promise<Response | undefined> | Response | undefined)[],
}

export const streams = new Map<string, Stream>()
export function resetChats() {
  streams.clear()
  const s = storefront()
  streams.set('local:%11', { seq: 1, items: s.items, state: s.state, older: s.older })
  const a = accounts()
  streams.set('local:%12', { seq: 1, items: a.items, state: a.state })
}
resetChats()
const EPOCH = 1
const sockets = new Set<Socket>()

function snapshot(stream: string) {
  if (stream === 'overview') return { t: 'snapshot', stream, epoch: EPOCH, seq: 1, rows: { hosts: overview().hosts } }
  const c = streams.get(stream)
  if (!c) return { t: 'snapshot', stream, epoch: EPOCH, seq: 1, rows: { items: [] }, state: { loaded: true, hasMore: false } }
  return { t: 'snapshot', stream, epoch: EPOCH, seq: c.seq, rows: { items: c.items, live: [], queue: [] }, state: c.state }
}

/** A change to a chat, sent to every socket that follows it. */
export function change(stream: string, parts: { append?: Item[]; state?: Item }) {
  const c = streams.get(stream)!
  const from = c.seq++
  if (parts.append) c.items.push(...parts.append)
  if (parts.state) Object.assign(c.state, parts.state)
  const frame = JSON.stringify({ t: 'delta', stream, epoch: EPOCH, from, seq: c.seq, ...(parts.append ? { append: { items: parts.append } } : {}), ...(parts.state ? { state: parts.state } : {}) })
  for (const ws of sockets) if (!ws.data.v1 && ws.data.subs.has(stream)) ws.send(frame)
  const [host, pane] = [stream.slice(0, stream.indexOf(':')), stream.slice(stream.indexOf(':') + 1)]
  if (parts.append) for (const ws of sockets) if (ws.data.v1 && ws.data.subs.has(stream)) ws.send(JSON.stringify({ t: 'chat.append', key: `${host}:${pane}`, items: parts.append }))
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers })

async function uploads(req: Request, p: string): Promise<Response | undefined> {
  const m = /^\/api\/hosts\/([^/]+)\/uploads(?:\/(start|[^/]+))?(?:\/(finish|\d+))?$/.exec(p)
  if (!m) return
  const [, , a, b] = m
  if (a === 'start' && req.method === 'POST') {
    state.calls.push('start')
    if (state.refuseStart) {
      const r = state.refuseStart
      state.refuseStart = undefined
      return json({ error: r.error }, r.status)
    }
    const body = await req.json()
    const id = Math.random().toString(36).slice(2, 10)
    state.uploads.set(id, { id, name: body.name, size: body.size, type: body.type, pane: body.pane, chunks: [], received: 0 })
    return json({ id, size: body.size, received: 0, chunk: state.chunk })
  }
  const u = a ? state.uploads.get(a) : undefined
  if (a && !u) return json({ error: 'This upload is no longer on the hub. Send the file again.' }, 404)
  const status = (x: Upload) => ({ id: x.id, size: x.size, received: x.received, chunk: state.chunk })
  if (u && b && /^\d+$/.test(b) && req.method === 'PUT') {
    state.calls.push(`put ${b}`)
    if (state.chunkDelay) await Bun.sleep(state.chunkDelay)
    if (state.failChunks > 0) {
      state.failChunks--
      return json({ error: 'The machine is reconnecting' }, 503)
    }
    if (+b !== u.received) return json({ ...status(u), error: `The upload carries on from byte ${u.received}` }, 409)
    const bytes = new Uint8Array(await req.arrayBuffer())
    u.chunks.push(bytes)
    u.received += bytes.length
    return json(status(u))
  }
  if (u && b === 'finish' && req.method === 'POST') {
    state.calls.push('finish')
    const { sha256 } = await req.json()
    const all = new Uint8Array(u.received)
    let at = 0
    for (const c of u.chunks) all.set(c, (at += c.length) - c.length)
    if (createHash('sha256').update(all).digest('hex') !== sha256) return json({ error: "The file didn't arrive whole. Send it again." }, 422)
    const saved = `/home/sam/.inyon/uploads/2026-11-04/${u.name}`
    state.saved.set(saved, { name: u.name, bytes: all, pane: u.pane })
    state.uploads.delete(u.id)
    return json({ name: u.name, path: saved, size: u.size, type: u.type })
  }
  if (u && !b && req.method === 'GET') {
    state.calls.push('status')
    return json(status(u))
  }
  if (u && !b && req.method === 'DELETE') {
    state.calls.push('delete')
    state.uploads.delete(u.id)
    return json({ ok: true })
  }
}

const server = Bun.serve({
  port: 0,
  async fetch(req, srv) {
    const url = new URL(req.url)
    const p = url.pathname
    if (p === '/ws2' || p === '/ws') {
      if (!state.authed) return new Response('Not signed in', { status: 401 })
      return srv.upgrade(req, { data: { subs: new Set<string>(), v1: p === '/ws' } }) ? undefined : new Response('no upgrade', { status: 400 })
    }
    for (const r of state.routes) {
      const res = await r(req, url)
      if (res) return res
    }
    if (p === '/api/session') return json({ authed: state.authed, setup: false, setupCode: false, version: '0.25.0' })
    const up = await uploads(req, p)
    if (up) return up
    const action = /^\/api\/hosts\/([^/]+)\/panes\/([^/]+)\/([a-z]+)$/.exec(p)
    if (action && req.method === 'POST') {
      const host = decodeURIComponent(action[1]!)
      const pane = action[2]!
      const body = await req.json().catch(() => ({}))
      if (action[3] === 'send') {
        state.sends.push({ host, pane, ...body })
        const stream = `${host}:%${pane}`
        if (streams.has(stream)) setTimeout(() => change(stream, { append: [{ kind: 'user', seq: 1000 + state.sends.length, uuid: `sent${state.sends.length}`, ts: new Date().toISOString(), text: body.text, images: 0 }] }), 400)
      }
      return json({ ok: true })
    }
    if (p.startsWith('/api/')) return json({})
    if (p === '/theme.js' || p.startsWith('/agents/') || p === '/icon.svg') return new Response(Bun.file(path.join(web, p)))
    if (p === '/next' || p.startsWith('/next/')) {
      const rel = p.replace(/^\/next\/?/, '')
      const f = Bun.file(path.join(dist, rel))
      if (rel && (await f.exists())) return new Response(f, { headers: { 'content-security-policy': NEXT_CSP } })
      return new Response(Bun.file(path.join(dist, 'index.html')), { headers: { 'content-type': 'text/html;charset=utf-8', 'content-security-policy': NEXT_CSP } })
    }
    // the React app, when it's built
    const f = Bun.file(path.join(reactDist, p))
    if (p !== '/' && (await f.exists())) return new Response(f)
    const index = Bun.file(path.join(reactDist, 'index.html'))
    if (await index.exists()) return new Response(index, { headers: { 'content-type': 'text/html;charset=utf-8' } })
    return new Response('Not found', { status: 404 })
  },
  websocket: {
    open(ws: Socket) {
      sockets.add(ws)
    },
    close(ws: Socket) {
      sockets.delete(ws)
    },
    message(ws: Socket, m) {
      const msg = JSON.parse(String(m))
      state.frames.push(msg)
      if (msg.t === 'ping') return ws.send(JSON.stringify({ t: 'pong' }))
      if (msg.t === 'draft') state.drafts.push(msg)
      if (ws.data.v1) {
        // the React app's protocol: the overview and each chat whole
        if (msg.t === 'sub.overview') ws.send(JSON.stringify(overview()))
        if (msg.t === 'sub.chat') {
          const key = `${msg.host}:${msg.pane}`
          ws.data.subs.add(key)
          const c = streams.get(key)
          if (c) {
            ws.send(JSON.stringify({ t: 'chat.reset', key, info: c.state.info, items: c.items, hasMore: false }))
            if (c.state.screen) ws.send(JSON.stringify({ t: 'chat.screen', key, screen: c.state.screen }))
          }
        }
        return
      }
      if (msg.t === 'hello') ws.send(JSON.stringify({ t: 'hello', v: 2 }))
      if (msg.t === 'sub') {
        ws.data.subs.add(msg.stream)
        const c = streams.get(msg.stream)
        const seq = msg.stream === 'overview' ? 1 : (c?.seq ?? 1)
        if (msg.at?.epoch === EPOCH && msg.at.seq === seq) ws.send(JSON.stringify({ t: 'delta', stream: msg.stream, epoch: EPOCH, from: seq, seq }))
        else ws.send(JSON.stringify(snapshot(msg.stream)))
      }
      if (msg.t === 'unsub') ws.data.subs.delete(msg.stream)
      if (msg.t === 'more') {
        const c = streams.get(msg.stream)
        ws.send(JSON.stringify({ t: 'more', stream: msg.stream, items: c?.older ?? [], hasMore: false }))
        if (c) c.state.hasMore = false
      }
    },
  },
})

export const base = `http://127.0.0.1:${server.port}`
/** The same hub under a name that isn't localhost, so the page is a plain-HTTP one: no
 * `navigator.clipboard`, as on a hub reached over NetBird or a LAN. */
export const plainBase = `http://hub.test:${server.port}`
export const hasReact = await Bun.file(path.join(reactDist, 'index.html')).exists()

// ---- the browser and the checks ----

export const problems: string[] = []
export let checks = 0
export const check = (ok: unknown, what: string) => {
  checks++
  if (!ok) problems.push(what)
}

export const errors: string[] = []
export const watch = (page: Page) => {
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()))
}

export async function launch(): Promise<Browser> {
  return chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--host-resolver-rules=MAP hub.test 127.0.0.1'] })
}

export const SIZES = [
  [390, 844],
  [1440, 900],
] as const

/** A page at one size and theme, with the intro and update prompt out of the way. */
export async function open(browser: Browser, w: number, h: number, scheme: 'light' | 'dark'): Promise<{ ctx: BrowserContext; page: Page }> {
  const phone = w < 600
  const ctx = await browser.newContext({ ...(phone ? devices['iPhone 13'] : {}), viewport: { width: w, height: h }, colorScheme: scheme, reducedMotion: 'reduce' })
  await ctx.addInitScript(() => {
    try {
      sessionStorage.setItem('inyon.intro.seen', '1')
    } catch {}
  })
  const page = await ctx.newPage()
  watch(page)
  return { ctx, page }
}

/** Text smaller than 12px, or a page wider than its window. */
export async function layout(page: Page, label: string) {
  const small: string[] = await page.evaluate(() => {
    const out: string[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      if (!el || !n.textContent?.trim() || !el.getClientRects().length) continue
      const size = parseFloat(getComputedStyle(el).fontSize)
      if (size < 12) out.push(`${n.textContent.trim().slice(0, 30)} (${size}px)`)
    }
    return out
  })
  check(!small.length, `${label}: text under 12px: ${small.join(', ')}`)
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check(wide <= 0, `${label}: scrolls sideways by ${wide}px`)
}

/** Polls `f` until it's true or `ms` pass. */
export async function until(f: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  for (;;) {
    if (await f()) return true
    if (Date.now() > end) return false
    await Bun.sleep(50)
  }
}

export function finish(browser: Browser) {
  return async () => {
    await browser.close()
    server.stop(true)
    if (errors.length) problems.push(`page errors: ${[...new Set(errors)].join(' | ')}`)
    if (problems.length) {
      console.error(`${problems.length} of ${checks} checks failed:\n- ${problems.join('\n- ')}`)
      process.exit(1)
    }
    console.log(`all ${checks} checks passed`)
  }
}
