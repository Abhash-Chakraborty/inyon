// first, so records are read from ~/.inyon and machines can be reached
import { BIND, DATA_DIR, PORT, TLS } from './env.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { hasPassword, passwordProblem, sessionSecret, setPassword } from './password.ts'
import { clearCookie, clientAddress, closeSockets, holdSocket, isAuthed, issueCookie, recentSignIn, refreshCookie, revokeSession, tryLogin } from './auth.ts'
import { claimPhone, CODE_TTL, hasBearer, holdPhoneSocket, hubAbout, issueTicket, listPhones, newPairCode, phoneFor, phonePaired, redeemTicket, revokePhone } from './phones.ts'
import { HttpError, registry, tokenExpired } from './hosts/registry.ts'
import { allowedHosts } from './hostnames.ts'
import { detectNetworks } from './networks.ts'
import { nodeLinks, type NodeSocketData } from './hosts/node-link.ts'
import { wasRemoved } from './hosts/removed-nodes.ts'
import { nodeRoutes, pairCommands, prebuildNode } from './features/node-dist.ts'
import { headCommit, hubUpdater } from './features/hub-update.ts'
import { VERSION } from '@inyon/protocol'
import { api as handled, body, clientMessage, clients, closeClient, coreRoutes, json, newClient, ok, saveEverything, startCore, type Client, type Handler, type Routes } from './core.ts'
import type { HostState, PhoneClaim } from '@inyon/protocol'
import { pushAll, startHubPush } from './push/hub-push.ts'
import { pushRoutes, TEST_PAYLOAD } from './push/routes.ts'
import { pagesFeature } from './features/pages.ts'
import { asCompanion, claimCompanion, companionFor, companionFrame, companionMe, companionRoutes, contractRefusal, holdCompanionSocket, inboundRefusal, listCompanions, newCompanionCode, revokeCompanion, type CompanionRoute } from './companions.ts'
import type { CompanionScope } from '@inyon/protocol'
import { kv } from './platform/store.ts'
import { servedFingerprint } from './tls.ts'
import { sharedCapAllows } from './limits.ts'

/** The hub: Inyon's API and live updates over HTTP and a WebSocket, behind a password. */

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
/** The hub address that goes into the pairing one-liners (shell and PowerShell). */
function pairOrigin(req: Request, origin?: string) {
  const hub = String(origin ?? new URL(req.url).origin).replace(/\/+$/, '')
  if (!/^https?:\/\/[A-Za-z0-9.:\[\]_-]+$/.test(hub)) throw new HttpError(400, 'Unexpected hub address')
  return hub
}

// the inyon program carries the web app next to its code (see apps/node/build.ts)
const WEB_DIST = Bun.isStandaloneExecutable ? path.join(import.meta.dir, 'inyon-web') : path.resolve(import.meta.dir, '../../web/dist')
// what this hub runs, so an open app can tell it was updated; and its update from Settings
const HUB_COMMIT = headCommit()
const hubUpdate = hubUpdater({ dataDir: DATA_DIR, commit: HUB_COMMIT })

/**
 * A browser request made by this app's own pages. Other sites can share the hub's cookie when they
 * run on the same host (a dev server on another port, a sibling subdomain), so anything that
 * changes state, and the WebSocket, must come from the hub's own origin. Requests without an
 * Origin header don't come from a web page (curl, the node agent) and carry no ambient cookie risk.
 */
const ALLOWED_ORIGINS = new Set((process.env.INYON_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean))
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
const networkNames = new Set<string>()
void detectNetworks().then((nets) => nets.forEach((n) => n.name && networkNames.add(n.name)), () => {})
const knownHost = allowedHosts(process.env, BIND, networkNames)
const refusedHosts = new Set<string>()
function rightHost(req: Request) {
  if (isAuthed(req) || companionFor(req)) return true
  const names = [req.headers.get('host'), ...(req.headers.get('x-forwarded-host')?.split(',').map((h) => h.trim()) ?? [])].filter((h) => h !== null)
  const wrong = names.find((h) => !knownHost(h)) ?? (names.length ? undefined : '(none)')
  if (wrong === undefined) return true
  if (!refusedHosts.has(wrong) && refusedHosts.size < 50) {
    refusedHosts.add(wrong)
    console.log(`Refused a request for host ${JSON.stringify(wrong.slice(0, 200))}. If that is this hub's address, add it to INYON_ALLOWED_HOSTS.`)
  }
  return false
}
const WRONG_HOST = "This hub doesn't answer to that address. If it's yours, add it to INYON_ALLOWED_HOSTS on the hub."

/**
 * The phone app runs on an origin of its own and signs in with a bearer token, so its requests
 * are cross-origin and need CORS answers. That is safe where no cookie is read: a request with a
 * bearer is judged by the bearer alone (see isAuthed), and these two routes never look at one.
 */
const CORS_PATHS = new Set(['/api/phones/claim', '/api/phones/ticket'])
const phoneRequest = (req: Request) => hasBearer(req) || CORS_PATHS.has(new URL(req.url).pathname)

/**
 * A call from a page with no origin of its own (a sandboxed frame, such as a page served under
 * /v/) or from another site. The browser may still attach the hub's cookie, so these are refused
 * for every method, reads included. A bearer request carries no ambient credential and passes.
 */
function framedCaller(req: Request) {
  const origin = req.headers.get('origin')
  if (origin === 'null') return true
  return req.headers.get('sec-fetch-site') === 'cross-site' && !(origin && ALLOWED_ORIGINS.has(origin))
}
function allowOrigin(res: Response, origin: string) {
  res.headers.set('Access-Control-Allow-Origin', origin)
  res.headers.set('Vary', 'Origin')
  res.headers.set('Access-Control-Allow-Headers', 'authorization, content-type')
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE')
  return res
}
function cors(req: Request, res: Response) {
  const origin = req.headers.get('origin')
  return origin && phoneRequest(req) ? allowOrigin(res, origin) : res
}
/** A preflight carries no token yet; the one for a bearer request names the header it will send. */
function preflight(req: Request) {
  if (req.method !== 'OPTIONS') return
  const url = new URL(req.url)
  const forBearer = /\bauthorization\b/i.test(req.headers.get('access-control-request-headers') ?? '')
  if (!url.pathname.startsWith('/api/') || !(forBearer || CORS_PATHS.has(url.pathname))) return
  if (!rightHost(req)) return json({ error: WRONG_HOST }, { status: 421 })
  const res = new Response(null, { status: 204, headers: { 'Access-Control-Max-Age': '600' } })
  const origin = req.headers.get('origin')
  return origin ? allowOrigin(res, origin) : res
}

/**
 * An API handler behind sign-in and the same-origin check. `open`: no sign-in needed. `owner`:
 * the hub's own account is the browser's to manage, so a paired phone is refused. `companion`:
 * what a companion app may do here, with which scope; without it a companion is refused.
 */
const api =
  (fn: Handler, { open = false, owner = false, companion }: { open?: boolean; owner?: boolean; companion?: CompanionRoute } = {}): Handler => {
    const run = handled(fn)
    return async (req) => {
      const pre = preflight(req)
      if (pre) return pre
      if (!rightHost(req)) return json({ error: WRONG_HOST }, { status: 421 })
      // a companion's token is judged on its own: its contract, then its scope for this route
      const comp = companionFor(req)
      if (comp) return asCompanion(req, comp, companion)
      if (owner && hasBearer(req)) return cors(req, json({ error: 'Not from a phone. Do this in the browser.' }, { status: 403 }))
      if (!phoneRequest(req) && framedCaller(req)) return json({ error: 'Cross-site request refused' }, { status: 403 })
      // a bearer request carries no ambient credential, so CSRF doesn't apply to it
      if (req.method !== 'GET' && req.method !== 'HEAD' && !phoneRequest(req) && !sameOrigin(req)) return json({ error: 'Cross-site request refused' }, { status: 403 })
      // a bearer this hub doesn't know was forgotten here (or never was this hub's): the phone may
      // forget the hub on this answer, and only on this one, not on any 401 a proxy gives
      if (!open && !isAuthed(req)) return cors(req, json(hasBearer(req) ? { error: 'Not signed in', reason: 'revoked' } : { error: 'Not signed in' }, { status: 401 }))
      return cors(req, await run(req))
    }
  }

/** A companion hands in its code; the answer carries its token. */
const claim = async (req: Request) => {
  const refused = contractRefusal(req)
  if (refused) return refused
  const b = await body<Record<string, unknown>>(req, 8 * 1024)
  const res = claimCompanion(clientAddress(server.requestIP(req)?.address ?? '?', req.headers.get('x-forwarded-for')), b)
  // a wrong code costs a moment, as wrong phone digits do
  if (res.status === 401) await Bun.sleep(400)
  return res
}

/** The shared routes, each behind sign-in; the few a companion may call carry its handler. */
const guarded = (routes: Routes) =>
  Object.fromEntries(
    Object.entries(routes).map(([route, r]) => [
      route,
      typeof r === 'function'
        ? api(r)
        : Object.fromEntries(Object.entries(r).map(([method, h]) => [method, api(h!, { companion: companionRoutes[route]?.[method as 'GET' | 'POST'] })])),
    ]),
  )

/** an app's connection, with the request it opened with until it's tied to that sign-in (or to its phone) */
type AppSocket = Client & { req?: Request; phone?: string; companion?: { id: string; scopes: CompanionScope[] }; release?: () => void }
type SocketData = AppSocket | (NodeSocketData & { kind: 'node' })

// ---------- static files (production build of apps/web) ----------

// no framing by other sites; images only from the hub itself, so agent output can't make the
// browser fetch an outside URL (a prompt-injected agent could put data in one). Scripts only from
// the app's own files: the page's `script-src 'self'` alone would also take a script an agent wrote
// under /v/. A path needs a host in CSP; `*:*` is any host on any port, and the page's own policy still
// holds it to this hub, so together they leave the app's files on this hub (checked in Chromium).
const PAGE_CSP = "frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; script-src *:*/assets/ *:*/theme.js *:*/sw.js"
const PAGE_HEADERS = {
  'Content-Security-Policy': PAGE_CSP,
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
  return new Response('Web app not built. Run `bun run build`.', { status: 503 })
}

// ---------- server ----------

// A new hub has no password: the first visit creates one, with a one-time code from the hub's log.
// The code is asked for even on localhost, since a page in your browser can reach localhost too.
const SETUP_CODE_FILE = path.join(DATA_DIR, 'setup-code')
const exposed = !/^(127\.|::1$|localhost$)/.test(BIND)
// on a network address, plain http sends the password and session in the clear: only on purpose
// (say on a VPN address, which encrypts on its own), with INYON_ALLOW_HTTP=1
if (exposed && !TLS && !/^(1|true|yes)$/i.test(process.env.INYON_ALLOW_HTTP ?? '')) {
  console.error(`Refusing to serve plain http on ${BIND}: set TLS_CERT and TLS_KEY, keep BIND on 127.0.0.1 behind an HTTPS proxy, or set INYON_ALLOW_HTTP=1 if the network encrypts it already (Tailscale, NetBird, WireGuard).`)
  process.exit(1)
}
const setupCode = !hasPassword() ? crypto.randomBytes(4).toString('hex') : undefined
if (setupCode) fs.writeFileSync(SETUP_CODE_FILE, setupCode + '\n', { mode: 0o600 })
const setupAttempts = { n: 0, reset: 0 }
/** wrong setup codes per address this minute (the shared count above covers all of them) */
const setupTries = new Map<string, number>()
startCore()
startHubPush()

// The inyon command on this machine (`inyon`, its dashboard) reads the hub's machines over
// loopback with a token the hub writes as it starts, readable only by this user. Whoever can read
// that file can read the hub's records themselves, so it opens no new way in.
const LOCAL_TOKEN_FILE = path.join(DATA_DIR, 'local-token')
const localToken = crypto.randomBytes(24).toString('base64url')
fs.rmSync(LOCAL_TOKEN_FILE, { force: true })
fs.writeFileSync(LOCAL_TOKEN_FILE, localToken + '\n', { mode: 0o600 })
const loopback = (ip: string) => /^(127\.|::1$|::ffff:127\.)/.test(ip)
/** Loopback, or the hub's own address when it listens on one (a VPN address, say): either way this machine. */
const thisMachine = (ip: string) => loopback(ip) || (ip !== '' && ip.replace(/^::ffff:/, '') === BIND)
function fromThisMachine(req: Request) {
  if (!thisMachine(server.requestIP(req)?.address ?? '')) return false
  // the header; `?token=` only for inyon commands before 0.20.3, which sent it in the address
  const given = new URL(req.url).searchParams.get('token') ?? (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  return given.length === localToken.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(localToken))
}
const local = (fn: (req: Request) => Response | Promise<Response>) => async (req: Request) => (fromThisMachine(req) ? fn(req) : json({ error: 'Only the inyon command on this machine may ask' }, { status: 403 }))
/** A machine as the command lists it: who it is, whether it's reachable, what it runs. */
const localNode = (s: HostState) => ({
  id: s.config.id,
  name: s.config.name,
  kind: s.config.kind,
  status: s.status,
  ...(s.hostname ? { hostname: s.hostname } : {}),
  ...(s.os ? { os: s.os } : {}),
  ...(s.nodeVersion ? { version: s.nodeVersion } : {}),
  ...(s.lastSeen ? { lastSeen: s.lastSeen } : {}),
  ...(s.error ? { error: s.error } : {}),
  agents: s.agents,
  sessions: s.sessions.length,
})

/** HTTPS directly, or behind a local HTTPS proxy (Tailscale Serve, Caddy…) where the hub only sees http. */
function secureRequest(req: Request): boolean {
  const ip: string = server.requestIP(req)?.address ?? ''
  return new URL(req.url).protocol === 'https:' || (/^(127\.|::1$|::ffff:127\.)/.test(ip) && req.headers.get('x-forwarded-proto') === 'https')
}

// sites agents made, listed from ~/.inyon/pages.json and served under /v/<token>/ (features/pages.ts)
const pages = pagesFeature({
  home: os.homedir(),
  store: kv,
  secret: sessionSecret,
  phoneOf: (req) => phoneFor(req)?.id,
  phonePaired,
  knownHost,
  secure: secureRequest,
})

// read the certificate's fingerprint now, with the certificate, for pairing links (tls.ts)
servedFingerprint()
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
      return json({ authed, setup: !hasPassword(), setupCode: !!setupCode && !hasPassword(), ...(authed ? { version: VERSION, commit: HUB_COMMIT } : {}) }, cookie ? { headers: { 'Set-Cookie': cookie } } : {})
    }, { open: true }),
    '/api/setup': {
      POST: api(async (req) => {
        if (hasPassword()) throw new HttpError(409, 'This hub already has a password. Sign in instead.')
        const b = await body<{ password: string; code?: string }>(req, 8 * 1024)
        const now = Date.now()
        if (setupAttempts.reset < now) {
          Object.assign(setupAttempts, { n: 0, reset: now + 60_000 })
          setupTries.clear()
        }
        if (!setupCode) throw new HttpError(409, 'This hub already has a password. Sign in instead.')
        const code = String(b.code ?? '').trim().toLowerCase()
        const client = clientAddress(server.requestIP(req)?.address ?? '?', req.headers.get('x-forwarded-for'))
        if ((setupTries.get(client) ?? 0) >= 8 || !sharedCapAllows('setup code', client, setupAttempts.n, 8)) throw new HttpError(429, 'Too many attempts. Try again in a minute.')
        if (code.length !== setupCode.length || !crypto.timingSafeEqual(Buffer.from(code), Buffer.from(setupCode))) {
          setupAttempts.n++
          setupTries.set(client, (setupTries.get(client) ?? 0) + 1)
          await Bun.sleep(400)
          throw new HttpError(401, 'That setup code is not right. `inyon hub code` on the hub machine shows it; it is also in ~/.inyon/setup-code.')
        }
        const password = String(b.password ?? '')
        const problem = passwordProblem(password)
        if (problem) throw new HttpError(400, problem)
        // a second request racing this one finds the password already set
        if (hasPassword()) throw new HttpError(409, 'This hub already has a password. Sign in instead.')
        setPassword(password)
        fs.rmSync(SETUP_CODE_FILE, { force: true })
        return json({ ok: true }, { headers: { 'Set-Cookie': issueCookie(secureRequest(req)) } })
      }, { open: true, owner: true }),
    },
    '/api/password': {
      POST: api(async (req) => {
        const b = await body<{ current: string; next: string }>(req, 8 * 1024)
        // the current password counts against the sign-in limits: a stolen cookie mustn't be a
        // way to guess it at full speed
        const client = clientAddress(server.requestIP(req)?.address ?? '?', req.headers.get('x-forwarded-for'))
        const r = await tryLogin(client, String(b.current ?? ''))
        if (r.limited) throw new HttpError(429, r.error!)
        if (!r.ok) throw new HttpError(401, 'Your current password is not right')
        const problem = passwordProblem(String(b.next ?? ''))
        if (problem) throw new HttpError(400, problem)
        // a new password signs out every other browser; this one gets a fresh sign-in
        setPassword(String(b.next))
        // connections opened with the old password end too (this browser reconnects signed in)
        closeSockets()
        return json({ ok: true }, { headers: { 'Set-Cookie': issueCookie(secureRequest(req)) } })
      }, { owner: true }),
    },
    '/api/login': {
      POST: api(async (req) => {
        const { password } = await body<{ password: string }>(req, 8 * 1024)
        // behind a local proxy every request comes from loopback: count guesses per real client
        const client = clientAddress(server.requestIP(req)?.address ?? '?', req.headers.get('x-forwarded-for'))
        const r = await tryLogin(client, String(password ?? ''))
        if (!r.ok) return json({ error: r.error }, { status: 401 })
        return json({ ok: true }, { headers: { 'Set-Cookie': issueCookie(secureRequest(req)) } })
      }, { open: true, owner: true }),
    },
    '/api/logout': {
      POST: api((req) => {
        revokeSession(req)
        return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie(secureRequest(req)) } })
      }, { open: true }),
    },
    // ---------- phones: the app pairs by scanning a code this hub's web app shows ----------
    '/api/phones': {
      GET: api((req) => json(listPhones(req))),
    },
    '/api/phones/pair': {
      POST: api(async (req) => {
        // a code hands out a token that outlives this session, so the password must be fresh
        if (!recentSignIn(req, CODE_TTL)) throw new HttpError(403, 'Sign in again to pair a phone.')
        const b = await body<{ origin?: string; name?: string }>(req, 8 * 1024)
        return json(newPairCode(b.origin))
      }, { owner: true }),
    },
    '/api/phones/claim': {
      POST: api(async (req) => {
        const b = await body<Partial<PhoneClaim>>(req, 8 * 1024)
        const client = clientAddress(server.requestIP(req)?.address ?? '?', req.headers.get('x-forwarded-for'))
        try {
          return json(claimPhone(client, b))
        } catch (err) {
          // wrong digits cost a moment, as a wrong setup code does
          if (err instanceof HttpError && err.status === 401) await Bun.sleep(400)
          throw err
        }
      }, { open: true }),
    },
    '/api/phones/ticket': {
      POST: api((req) => {
        const phone = phoneFor(req)
        if (!phone) throw new HttpError(403, 'Only a paired phone connects with a ticket.')
        return json({ ticket: issueTicket(phone.id), hub: hubAbout() })
      }),
    },
    '/api/phones/:id': {
      DELETE: api((req) => {
        if (!revokePhone(req.params.id)) throw new HttpError(404, 'Unknown phone')
        return ok()
      }, { owner: true }),
    },
    // ---------- companion apps: they type a short code this hub's web app or `inyon hub companion-code` shows ----------
    '/api/companions': {
      GET: api(() => json(listCompanions())),
    },
    '/api/companions/pair': {
      POST: api((req) => {
        // a code hands out a token that outlives this session, so the password must be fresh
        if (!recentSignIn(req, CODE_TTL)) throw new HttpError(403, 'Sign in again to pair a companion app.')
        return json(newCompanionCode())
      }, { owner: true }),
    },
    '/api/companions/claim': {
      // open, and a companion that still holds an older token may pair again with a new code
      POST: api(claim, { open: true, companion: { run: claim } }),
    },
    '/api/companions/me': {
      GET: api(() => json({ error: 'Only a companion app asks this' }, { status: 403 }), { companion: { run: (_req, c) => json(companionMe(c)) } }),
    },
    '/api/companions/:id': {
      DELETE: api((req) => {
        if (!revokeCompanion(req.params.id)) throw new HttpError(404, 'Unknown companion app')
        return ok()
      }, { owner: true }),
    },
    '/api/hosts/pair': {
      POST: api(async (req) => {
        const b = await body<{ name?: string; origin?: string }>(req)
        const name = String(b.name ?? '').trim() || 'Laptop'
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'node'
        const hub = pairOrigin(req, b.origin)
        const token = crypto.randomBytes(32).toString('base64url')
        const commands = await pairCommands(hub, token)
        let unique = id
        for (let i = 2; registry.get(unique); i++) unique = `${id}-${i}`
        registry.add({ id: unique, name, kind: 'node', tokenHash: sha256(token), tokenIssuedAt: Date.now() })
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
        const commands = await pairCommands(hub, token)
        registry.setNodeToken(req.params.id, sha256(token))
        return json({ id: req.params.id, token, command: commands.unix, commands })
      }),
    },
    // `inyon join` swaps the token in the "Add a machine" command for one only it knows, before the
    // machine first connects: the pasted command (in shell history, a support paste, a screen
    // share) is dead once used. Older commands that skip this still connect with the pasted token.
    '/node/claim': {
      POST: async (req: Request) => {
        const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
        const hash = token ? sha256(token) : ''
        const cfg = hash ? registry.configs().find((c) => c.kind === 'node' && c.tokenHash && crypto.timingSafeEqual(Buffer.from(c.tokenHash), Buffer.from(hash))) : undefined
        if (!cfg || tokenExpired(cfg)) {
          await Bun.sleep(500)
          return new Response(cfg ? 'This pairing command expired; get a new one from the hub\n' : 'Unknown token; the command was used already or replaced. Get a new one from the hub.\n', { status: 403 })
        }
        // a machine already connected with it (an older inyon): swapping now would cut it off
        if (cfg.pairedAt) return new Response('This machine is paired already\n', { status: 409 })
        const fresh = crypto.randomBytes(32).toString('base64url')
        registry.setNodeToken(cfg.id, sha256(fresh))
        return json({ token: fresh })
      },
    },
    // ---------- the inyon command on this machine, over loopback with the local token ----------
    '/api/local/nodes': local(() => json({ v: 1, ok: true, nodes: registry.overview().map(localNode) })),
    // `inyon hub companion-code`: a code for a companion app without a browser
    '/api/local/companion-code': local(() => json({ v: 1, ok: true, ...newCompanionCode() })),
    ...nodeRoutes,
    ...guarded(coreRoutes),
    ...guarded(pushRoutes((endpoint) => pushAll(TEST_PAYLOAD, undefined, endpoint))),
    ...guarded(hubUpdate.routes),
    ...guarded(pages.routes),
  },
  async fetch(req, srv) {
    const url = new URL(req.url)
    // a page's own files: the token in the path is the only credential, never the cookie
    if (url.pathname.startsWith('/v/')) return pages.view(req)
    if (url.pathname === '/node') {
      // machines running inyon authenticate with their pairing token
      const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
      const hash = token ? sha256(token) : ''
      const cfg = hash && registry.configs().find((c) => c.kind === 'node' && c.tokenHash && crypto.timingSafeEqual(Buffer.from(c.tokenHash), Buffer.from(hash)))
      if (!cfg || tokenExpired(cfg)) {
        await Bun.sleep(500)
        // 410: the machine was removed here and should stop calling; it takes its service down
        if (!cfg && wasRemoved(hash)) return new Response('This machine was removed from the hub', { status: 410 })
        return new Response(cfg ? 'This pairing command expired; get a new one from the hub' : 'Unknown token', { status: 403 })
      }
      if (srv.upgrade(req, { data: { kind: 'node', hostId: cfg.id } })) return registry.markPaired(cfg.id)
      return new Response('Upgrade failed', { status: 400 })
    }
    if (url.pathname === '/ws') {
      // a phone connects with a ticket (a page can't set a header on a WebSocket) or its bearer;
      // either one is judged alone, never a cookie sent along with it
      const ticket = url.searchParams.get('ticket')
      // a companion app: its bearer, and its contract in a header or (for a client that can't set one) ?contract=
      const comp = ticket === null ? companionFor(req) : undefined
      if (comp) {
        const refused = contractRefusal(req, url.searchParams.get('contract'))
        if (refused) return refused
        const data: AppSocket = Object.assign(newClient(), { companion: { id: comp.id, scopes: comp.scopes } })
        if (srv.upgrade(req, { data })) return
        return new Response('Upgrade failed', { status: 400 })
      }
      const asPhone = ticket !== null || hasBearer(req)
      const phone = ticket !== null ? redeemTicket(ticket) : asPhone ? phoneFor(req) : undefined
      if (asPhone && !phone) return new Response('Not signed in', { status: 401 })
      if (!asPhone && !sameOrigin(req)) return new Response('Cross-site connection refused', { status: 403 })
      if (!asPhone && !isAuthed(req)) return new Response('Not signed in', { status: 401 })
      const data: AppSocket = Object.assign(newClient(), { req, phone: phone?.id })
      if (srv.upgrade(req, { data })) return
      return new Response('Upgrade failed', { status: 400 })
    }
    // a route that only lists some methods leaves OPTIONS to land here
    const pre = preflight(req)
    if (pre) return pre
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
      const companion = c.companion
      c.send = companion
        ? (msg) => {
            const out = companionFrame(msg, companion.scopes)
            if (out) ws.send(JSON.stringify(out))
          }
        : (msg) => {
            ws.send(JSON.stringify(msg))
          }
      c.release = companion ? holdCompanionSocket(companion.id, ws) : c.phone ? holdPhoneSocket(c.phone, ws) : holdSocket(c.req!, ws)
      c.req = undefined
      clients.add(c)
    },
    message(ws, raw) {
      if (ws.data.kind === 'node') return nodeLinks.message(ws.data.hostId, String(raw))
      const companion = ws.data.companion
      // a companion may only watch: anything else ends its connection
      const refused = companion && inboundRefusal(String(raw), companion.scopes)
      if (refused) return ws.close(4403, refused)
      clientMessage(ws.data, String(raw))
    },
    close(ws) {
      if (ws.data.kind === 'node') return nodeLinks.detach(ws.data.hostId, ws as any)
      ws.data.release?.()
      closeClient(ws.data)
    },
  },
})

// a restart (systemctl, Ctrl+C) keeps what was about to be saved: open chats, drafts, machines
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    saveEverything()
    process.exit(0)
  })
}

console.log(`Inyon hub listening on ${TLS ? 'https' : 'http'}://${server.hostname}:${server.port}`)
prebuildNode()
if (!hasPassword()) {
  const where = `${TLS ? 'https' : 'http'}://${exposed ? server.hostname : 'localhost'}:${server.port}`
  console.log(`
  First run: open ${where} and create your password.`)
  // the code itself only to a terminal: a log (launchd's, nohup's, the journal) may be readable by
  // other users of this machine, who could set the password before you do
  if (setupCode)
    console.log(
      process.stdout.isTTY
        ? `  It will ask for this setup code: ${setupCode} (also in ${SETUP_CODE_FILE})\n`
        : `  It will ask for the setup code in ${SETUP_CODE_FILE} (\`inyon hub code\` shows it)\n`,
    )
}
