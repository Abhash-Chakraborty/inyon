// first, so records are read from ~/.tether and machines can be reached
import { BIND, DATA_DIR, PORT, TLS } from './env.ts'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { checkPassword, hasPassword, passwordProblem, setPassword } from './password.ts'
import { clearCookie, clientAddress, isAuthed, issueCookie, refreshCookie, revokeSession, tryLogin } from './auth.ts'
import { HttpError, registry } from './hosts/registry.ts'
import { allowedHosts } from './hostnames.ts'
import { nodeLinks, type NodeSocketData } from './hosts/node-link.ts'
import { nodeRoutes, pairCommands, prebuildNode } from './features/node-dist.ts'
import { api as handled, body, clientMessage, clients, closeClient, coreRoutes, json, newClient, startCore, type Client, type Handler, type Routes } from './core.ts'

/** The hub: Tether's API and live updates over HTTP and a WebSocket, behind a password. */

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
/** The hub address that goes into the pairing one-liners (shell and PowerShell). */
function pairOrigin(req: Request, origin?: string) {
  const hub = String(origin ?? new URL(req.url).origin).replace(/\/+$/, '')
  if (!/^https?:\/\/[A-Za-z0-9.:\[\]_-]+$/.test(hub)) throw new HttpError(400, 'Unexpected hub address')
  return hub
}

const WEB_DIST = path.resolve(import.meta.dir, '../../web/dist')

/**
 * A browser request made by this app's own pages. Other sites can share the hub's cookie when they
 * run on the same host (a dev server on another port, a sibling subdomain), so anything that
 * changes state, and the WebSocket, must come from the hub's own origin. Requests without an
 * Origin header don't come from a web page (curl, the node agent) and carry no ambient cookie risk.
 */
const ALLOWED_ORIGINS = new Set((process.env.TETHER_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean))
function sameOrigin(req: Request) {
  const origin = req.headers.get('origin')
  if (!origin) return true
  if (ALLOWED_ORIGINS.has(origin)) return true
  try {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
    return !!host && new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Sent to a name the hub answers to (see hostnames.ts), including the one a local proxy forwards.
 * A signed-in browser passes under any name: its cookie can only have been set by the hub itself.
 */
const knownHost = allowedHosts(process.env, BIND)
const refusedHosts = new Set<string>()
function rightHost(req: Request) {
  if (isAuthed(req)) return true
  const names = [req.headers.get('host'), ...(req.headers.get('x-forwarded-host')?.split(',').map((h) => h.trim()) ?? [])].filter((h) => h !== null)
  const wrong = names.find((h) => !knownHost(h)) ?? (names.length ? undefined : '(none)')
  if (wrong === undefined) return true
  if (!refusedHosts.has(wrong) && refusedHosts.size < 50) {
    refusedHosts.add(wrong)
    console.log(`Refused a request for host ${JSON.stringify(wrong.slice(0, 200))}. If that is this hub's address, add it to TETHER_ALLOWED_HOSTS.`)
  }
  return false
}
const WRONG_HOST = "This hub doesn't answer to that address. If it's yours, add it to TETHER_ALLOWED_HOSTS on the hub."

/** An API handler behind sign-in and the same-origin check. */
const api =
  (fn: Handler, open = false): Handler => {
    const run = handled(fn)
    return async (req) => {
      if (!rightHost(req)) return json({ error: WRONG_HOST }, { status: 421 })
      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return json({ error: 'Cross-site request refused' }, { status: 403 })
      if (!open && !isAuthed(req)) return json({ error: 'Not signed in' }, { status: 401 })
      return run(req)
    }
  }

/** The shared routes, each behind sign-in. */
const guarded = (routes: Routes) =>
  Object.fromEntries(
    Object.entries(routes).map(([route, r]) => [
      route,
      typeof r === 'function' ? api(r) : Object.fromEntries(Object.entries(r).map(([method, h]) => [method, api(h!)])),
    ]),
  )

type SocketData = Client | (NodeSocketData & { kind: 'node' })

// ---------- static files (production build of apps/web) ----------

// no framing by other sites; images only from the hub itself, so agent output can't make the
// browser fetch an outside URL (a prompt-injected agent could put data in one)
const PAGE_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
}

async function serveStatic(pathname: string) {
  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
  } catch {}
  const rel = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  const file = Bun.file(path.join(WEB_DIST, rel))
  if (rel !== '/' && (await file.exists())) {
    const immutable = rel.startsWith('/assets/')
    return new Response(file, {
      headers: { 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', ...PAGE_HEADERS },
    })
  }
  const index = Bun.file(path.join(WEB_DIST, 'index.html'))
  if (await index.exists()) return new Response(index, { headers: { 'Cache-Control': 'no-cache', ...PAGE_HEADERS } })
  return new Response('Web app not built. Run `pnpm build`.', { status: 503 })
}

// ---------- server ----------

// A new hub has no password: the first visit creates one, with a one-time code from the hub's log.
// The code is asked for even on localhost, since a page in your browser can reach localhost too.
const SETUP_CODE_FILE = path.join(DATA_DIR, 'setup-code')
const exposed = !/^(127\.|::1$|localhost$)/.test(BIND)
const setupCode = !hasPassword() ? crypto.randomBytes(4).toString('hex') : undefined
if (setupCode) fs.writeFileSync(SETUP_CODE_FILE, setupCode + '\n', { mode: 0o600 })
const setupAttempts = { n: 0, reset: 0 }
startCore()

/** HTTPS directly, or behind a local HTTPS proxy (Tailscale Serve, Caddy…) where the hub only sees http. */
function secureRequest(req: Request): boolean {
  const ip: string = server.requestIP(req)?.address ?? ''
  return new URL(req.url).protocol === 'https:' || (/^(127\.|::1$|::ffff:127\.)/.test(ip) && req.headers.get('x-forwarded-proto') === 'https')
}

const server = Bun.serve<SocketData>({
  port: PORT,
  hostname: BIND,
  ...(TLS ? { tls: { cert: Bun.file(TLS.cert), key: Bun.file(TLS.key) } } : {}),
  idleTimeout: 120,
  // the largest upload Settings allows; each route also counts its body against its own limit
  // (8 KB for sign-in, 1 MB for JSON, the upload setting for files)
  maxRequestBodySize: 2049 * 1024 * 1024,
  routes: {
    '/api/session': api((req) => {
      const authed = isAuthed(req)
      // sliding sign-in: a session in use keeps going, one left alone for 30 days ends
      const cookie = authed ? refreshCookie(req, secureRequest(req)) : undefined
      return json({ authed, setup: !hasPassword(), setupCode: !!setupCode && !hasPassword() }, cookie ? { headers: { 'Set-Cookie': cookie } } : {})
    }, true),
    '/api/setup': {
      POST: api(async (req) => {
        if (hasPassword()) throw new HttpError(409, 'This hub already has a password. Sign in instead.')
        const b = await body<{ password: string; code?: string }>(req, 8 * 1024)
        const now = Date.now()
        if (setupAttempts.reset < now) Object.assign(setupAttempts, { n: 0, reset: now + 60_000 })
        if (!setupCode) throw new HttpError(409, 'This hub already has a password. Sign in instead.')
        const code = String(b.code ?? '').trim().toLowerCase()
        if (setupAttempts.n >= 8) throw new HttpError(429, 'Too many attempts. Try again in a minute.')
        if (code.length !== setupCode.length || !crypto.timingSafeEqual(Buffer.from(code), Buffer.from(setupCode))) {
          setupAttempts.n++
          await Bun.sleep(400)
          throw new HttpError(401, 'That setup code is not right. It is in the hub log, and in ~/.tether/setup-code.')
        }
        const password = String(b.password ?? '')
        const problem = passwordProblem(password)
        if (problem) throw new HttpError(400, problem)
        // a second request racing this one finds the password already set
        if (hasPassword()) throw new HttpError(409, 'This hub already has a password. Sign in instead.')
        setPassword(password)
        fs.rmSync(SETUP_CODE_FILE, { force: true })
        return json({ ok: true }, { headers: { 'Set-Cookie': issueCookie(secureRequest(req)) } })
      }, true),
    },
    '/api/password': {
      POST: api(async (req) => {
        const b = await body<{ current: string; next: string }>(req, 8 * 1024)
        if (!(await checkPassword(String(b.current ?? '')))) {
          await Bun.sleep(400)
          throw new HttpError(401, 'Your current password is not right')
        }
        const problem = passwordProblem(String(b.next ?? ''))
        if (problem) throw new HttpError(400, problem)
        // a new password signs out every other browser; this one gets a fresh sign-in
        setPassword(String(b.next))
        return json({ ok: true }, { headers: { 'Set-Cookie': issueCookie(secureRequest(req)) } })
      }),
    },
    '/api/login': {
      POST: api(async (req) => {
        const { password } = await body<{ password: string }>(req, 8 * 1024)
        // behind a local proxy every request comes from loopback: count guesses per real client
        const client = clientAddress(server.requestIP(req)?.address ?? '?', req.headers.get('x-forwarded-for'))
        const r = await tryLogin(client, String(password ?? ''))
        if (!r.ok) return json({ error: r.error }, { status: 401 })
        return json({ ok: true }, { headers: { 'Set-Cookie': issueCookie(secureRequest(req)) } })
      }, true),
    },
    '/api/logout': {
      POST: api((req) => {
        revokeSession(req)
        return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie() } })
      }, true),
    },
    '/api/hosts/pair': {
      POST: api(async (req) => {
        const b = await body<{ name?: string; origin?: string }>(req)
        const name = String(b.name ?? '').trim() || 'Laptop'
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'node'
        let unique = id
        for (let i = 2; registry.get(unique); i++) unique = `${id}-${i}`
        const hub = pairOrigin(req, b.origin)
        const token = crypto.randomBytes(32).toString('base64url')
        registry.add({ id: unique, name, kind: 'node', tokenHash: sha256(token) })
        const commands = pairCommands(hub, token)
        return json({ id: unique, token, command: commands.unix, commands })
      }),
    },
    // a new command for a machine that was added but never ran it (or lost its token)
    '/api/hosts/:id/pair': {
      POST: api(async (req) => {
        const rt = registry.get(req.params.id)
        if (rt?.host.config.kind !== 'node') throw new HttpError(404, 'Unknown machine')
        if (rt.state.status === 'online') throw new HttpError(409, 'This machine is connected; remove it first to pair it again')
        const hub = pairOrigin(req, (await body<{ origin?: string }>(req)).origin)
        const token = crypto.randomBytes(32).toString('base64url')
        registry.setNodeToken(req.params.id, sha256(token))
        const commands = pairCommands(hub, token)
        return json({ id: req.params.id, token, command: commands.unix, commands })
      }),
    },
    ...nodeRoutes,
    ...guarded(coreRoutes),
  },
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/node') {
      // tether-node machines authenticate with their pairing token
      const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
      const hash = token ? sha256(token) : ''
      const cfg = hash && registry.configs().find((c) => c.kind === 'node' && c.tokenHash && crypto.timingSafeEqual(Buffer.from(c.tokenHash), Buffer.from(hash)))
      if (!cfg) {
        await Bun.sleep(500)
        return new Response('Unknown token', { status: 403 })
      }
      if (srv.upgrade(req, { data: { kind: 'node', hostId: cfg.id } })) return registry.markPaired(cfg.id)
      return new Response('Upgrade failed', { status: 400 })
    }
    if (url.pathname === '/ws') {
      if (!sameOrigin(req)) return new Response('Cross-site connection refused', { status: 403 })
      if (!isAuthed(req)) return new Response('Not signed in', { status: 401 })
      if (srv.upgrade(req, { data: newClient() })) return
      return new Response('Upgrade failed', { status: 400 })
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, { status: 404 })
    if (!rightHost(req)) return new Response(`${WRONG_HOST}\n`, { status: 421, headers: PAGE_HEADERS })
    return serveStatic(url.pathname)
  },
  websocket: {
    perMessageDeflate: true,
    idleTimeout: 120,
    // a client that can't keep up is closed instead of silently losing messages; the app
    // reconnects and gets a fresh copy of everything it watches
    backpressureLimit: 4 * 1024 * 1024,
    closeOnBackpressureLimit: true,
    open(ws) {
      if (ws.data.kind === 'node') return nodeLinks.attach(ws.data.hostId, ws as any)
      const c = ws.data
      c.send = (msg) => {
        ws.send(JSON.stringify(msg))
      }
      clients.add(c)
    },
    message(ws, raw) {
      if (ws.data.kind === 'node') return nodeLinks.message(ws.data.hostId, String(raw))
      clientMessage(ws.data, String(raw))
    },
    close(ws) {
      if (ws.data.kind === 'node') return nodeLinks.detach(ws.data.hostId, ws as any)
      closeClient(ws.data)
    },
  },
})

console.log(`Tether hub listening on ${TLS ? 'https' : 'http'}://${server.hostname}:${server.port}`)
prebuildNode()
if (!hasPassword()) {
  const where = `${TLS ? 'https' : 'http'}://${exposed ? server.hostname : 'localhost'}:${server.port}`
  console.log(`
  First run: open ${where} and create your password.`)
  if (setupCode) console.log(`  It will ask for this setup code: ${setupCode} (also in ${SETUP_CODE_FILE})
`)
}
