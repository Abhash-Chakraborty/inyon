import fs from 'node:fs'
import path from 'node:path'
import type { ServerWebSocket } from 'bun'
import type { AgentKind, ClientMsg, HostConfig, ServerMsg } from '@tether/protocol'
import { BIND, DATA_DIR, PORT, ensurePassword, TLS } from './config.ts'
import { clearCookie, isAuthed, issueCookie, refreshCookie, revokeSession, tryLogin } from './auth.ts'
import { HttpError, publicConfig, registry } from './hosts/registry.ts'
import { watchers, type Subscriber } from './claude/watcher.ts'
import { answer, codexRewind, exitAgent, findTaskOutput, inputAnswer, keys, launch, remoteControl, sendMessage, setMode, interrupt, reconnectAgent, renamePane, restartAgent, startAgent, stopTask } from './claude/actions.ts'
import {
  cleanUploads, listCommands, listConfigs, listFiles, listSubagents, readConfig, readTranscript,
  startUploadJanitor, taskOutput, uploadFiles, uploadUsage, writeConfig,
} from './features/features.ts'
import { loadSettings, saveSettings } from './config.ts'
import { ensureSessions, runSetup, setKeepSession, setupReport } from './features/setup.ts'
import { answerSignIn, readSignIn, startSignIn, stopSignIn } from './features/signin.ts'
import { installIntegration, uninstallIntegration } from './claude/integration.ts'
import { openTerminal } from './terminal/terminal.ts'
import type { PtyHandle } from './hosts/host.ts'
import { nodeLinks, type NodeSocketData } from './hosts/node-link.ts'
import crypto from 'node:crypto'
import { listModels } from './features/models.ts'
import { sendOnce } from './claude/send-receipts.ts'
import { nodeRoutes, pairCommands, prebuildNode } from './features/node-dist.ts'

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
/** The hub address that goes into the pairing one-liners (shell and PowerShell). */
function pairOrigin(req: Request, origin?: string) {
  const hub = String(origin ?? new URL(req.url).origin).replace(/\/+$/, '')
  if (!/^https?:\/\/[A-Za-z0-9.:\[\]_-]+$/.test(hub)) throw new HttpError(400, 'Unexpected hub address')
  return hub
}

const WEB_DIST = path.resolve(import.meta.dir, '../../web/dist')

// ---------- helpers ----------

const json = (data: unknown, init: ResponseInit = {}) => Response.json(data, init)

async function body<T = any>(req: Request, limit = 1024 * 1024): Promise<T> {
  // JSON bodies are small; refuse big ones before reading them into memory
  if (Number(req.headers.get('content-length') ?? 0) > limit) throw new HttpError(413, 'Request too large')
  try {
    return (await req.json()) as T
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

/** URL-safe pane ids: "%12" travels as "12". */
const paneParam = (p: string) => (p.startsWith('%') ? p : `%${p}`)

type Handler = (req: Request & { params: Record<string, string> }) => Promise<Response> | Response

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

/** Wraps an API handler with auth and error handling. */
const api =
  (fn: Handler, open = false): Handler =>
  async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return json({ error: 'Cross-site request refused' }, { status: 403 })
    if (!open && !isAuthed(req)) return json({ error: 'Not signed in' }, { status: 401 })
    try {
      return await fn(req)
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, { status: err.status })
      console.error(err)
      return json({ error: String((err as Error)?.message ?? err) }, { status: 500 })
    }
  }

const ok = () => json({ ok: true })

function validateHost(b: Partial<HostConfig>): Omit<HostConfig, 'id'> {
  const name = String(b.name ?? '').trim()
  const target = String(b.target ?? '').trim()
  if (!name) throw new HttpError(400, 'Give the machine a name')
  // a leading "-" would be read by ssh as an option
  if (!/^[\w.@-]+$/.test(target) || target.startsWith('-')) throw new HttpError(400, 'Use user@host or an alias from ~/.ssh/config')
  const port = b.port ? Number(b.port) : undefined
  if (port !== undefined && !(port > 0 && port < 65536)) throw new HttpError(400, 'Port must be 1-65535')
  const identityFile = b.identityFile?.trim() || undefined
  if (identityFile && !/^[\w./~-]+$/.test(identityFile)) throw new HttpError(400, 'Key path has unexpected characters')
  return { name, kind: 'ssh', target, port, identityFile }
}

// ---------- websocket clients ----------

interface Client extends Subscriber {
  kind: 'client'
  overview: boolean
  chats: Set<string>
  terms: Map<string, PtyHandle>
}

const clients = new Set<Client>()

registry.on((e) => {
  if (e.type === 'overview') {
    const msg: ServerMsg = { t: 'overview', hosts: registry.overview() }
    for (const c of clients) if (c.overview) c.send(msg)
  } else if (e.type === 'notify') {
    for (const c of clients) c.send({ t: 'notify', host: e.host, pane: e.pane, kind: e.kind, title: e.title, body: e.body, agent: e.agent as any })
  }
})

type SocketData = Client | (NodeSocketData & { kind: 'node' })

function onMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
  if (ws.data.kind === 'node') return nodeLinks.message(ws.data.hostId, String(raw))
  const c = ws.data
  let m: ClientMsg
  try {
    m = JSON.parse(String(raw))
  } catch {
    return
  }
  switch (m.t) {
    case 'ping':
      return c.send({ t: 'pong' })
    case 'sub.overview':
      c.overview = true
      return c.send({ t: 'overview', hosts: registry.overview() })
    case 'sub.chat': {
      const key = `${m.host}:${m.pane}`
      if (c.chats.has(key) || !registry.get(m.host)) return
      c.chats.add(key)
      return watchers.get(m.host, m.pane).subscribe(c)
    }
    case 'unsub.chat': {
      const key = `${m.host}:${m.pane}`
      if (!c.chats.delete(key)) return
      return watchers.peek(m.host, m.pane)?.unsubscribe(c)
    }
    case 'chat.more':
      return watchers.peek(m.host, m.pane)?.more(c, m.before)
    case 'draft':
      if (typeof m.text !== 'string' || m.text.length > 100_000 || !registry.get(m.host)) return
      // only for a chat this client watches: a bare draft must not start a watcher nobody stops
      return watchers.peek(m.host, m.pane)?.draftFromApp(m.text, c)
    case 'term.open': {
      if (c.terms.has(m.id) || c.terms.size >= 8) return
      try {
        // one streaming decoder per terminal so multi-byte characters split across chunks survive
        const decoder = new TextDecoder()
        const term = openTerminal(m.host, m.pane, m.cols, m.rows, (d) =>
          c.send({ t: 'term.data', id: m.id, d: decoder.decode(d, { stream: true }) }),
        )
        c.terms.set(m.id, term)
        term.exited.then(() => {
          if (c.terms.get(m.id) === term) {
            c.terms.delete(m.id)
            c.send({ t: 'term.exit', id: m.id })
          }
        })
      } catch (err) {
        c.send({ t: 'term.exit', id: m.id, reason: (err as Error).message })
      }
      return
    }
    case 'term.in':
      return c.terms.get(m.id)?.write(m.d)
    case 'term.resize':
      return c.terms.get(m.id)?.resize(Math.max(10, m.cols | 0), Math.max(4, m.rows | 0))
    case 'term.close': {
      const t = c.terms.get(m.id)
      c.terms.delete(m.id)
      return t?.kill()
    }
  }
}

function onClose(ws: ServerWebSocket<SocketData>) {
  if (ws.data.kind === 'node') return nodeLinks.detach(ws.data.hostId, ws as any)
  const c = ws.data
  clients.delete(c)
  for (const key of c.chats) {
    const i = key.indexOf(':')
    watchers.peek(key.slice(0, i), key.slice(i + 1))?.unsubscribe(c)
  }
  for (const t of c.terms.values()) t.kill()
}

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

const firstPassword = ensurePassword()
registry.start()
startUploadJanitor()
setInterval(() => ensureSessions().catch(() => {}), 30_000)
setTimeout(() => ensureSessions().catch(() => {}), 5_000)

/** HTTPS directly, or behind a local HTTPS proxy (Tailscale Serve, Caddy…) where the hub only sees http. */
function secureRequest(req: Request): boolean {
  const ip: string = server.requestIP(req)?.address ?? ''
  return new URL(req.url).protocol === 'https:' || (/^(127\.|::1$|::ffff:127\.)/.test(ip) && req.headers.get('x-forwarded-proto') === 'https')
}

const q = (req: Request, name: string) => new URL(req.url).searchParams.get(name) ?? ''

const server = Bun.serve<SocketData>({
  port: PORT,
  hostname: BIND,
  ...(TLS ? { tls: { cert: Bun.file(TLS.cert), key: Bun.file(TLS.key) } } : {}),
  idleTimeout: 120,
  maxRequestBodySize: 2048 * 1024 * 1024,
  routes: {
    '/api/session': api((req) => {
      const authed = isAuthed(req)
      // sliding sign-in: a session in use keeps going, one left alone for 30 days ends
      const cookie = authed ? refreshCookie(req, secureRequest(req)) : undefined
      return json({ authed }, cookie ? { headers: { 'Set-Cookie': cookie } } : {})
    }, true),
    '/api/login': {
      POST: api(async (req) => {
        const { password } = await body<{ password: string }>(req, 8 * 1024)
        const ip = server.requestIP(req)?.address ?? '?'
        // behind a local proxy every request comes from loopback: count guesses per real client
        const loopback = /^(127\.|::1$|::ffff:127\.)/.test(ip)
        const client = (loopback && req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()) || ip
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
    '/api/hosts': {
      GET: api(() => json(registry.configs().map(publicConfig))),
      POST: api(async (req) => {
        const cfg = validateHost(await body(req))
        const id = cfg.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'host'
        let unique = id
        for (let i = 2; registry.get(unique); i++) unique = `${id}-${i}`
        registry.add({ ...cfg, id: unique })
        return json({ id: unique })
      }),
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
    '/api/hosts/:id': {
      PATCH: api(async (req) => {
        const id = req.params.id
        const cur = registry.get(id)?.host.config
        if (!cur) throw new HttpError(404, 'Unknown machine')
        const b = await body(req)
        if (cur.kind !== 'ssh') registry.update(id, { name: String(b.name ?? cur.name).trim() || cur.name })
        else registry.update(id, validateHost({ ...cur, ...b }))
        return ok()
      }),
      DELETE: api((req) => {
        if (req.params.id === 'local') throw new HttpError(400, 'This machine cannot be removed')
        nodeLinks.disconnect(req.params.id)
        registry.remove(req.params.id)
        return ok()
      }),
    },
    '/api/hosts/:id/integration': {
      POST: api(async (req) => {
        const { enable } = await body<{ enable: boolean }>(req)
        const host = registry.host(req.params.id)
        if (enable) await installIntegration(host)
        else await uninstallIntegration(host)
        registry.setKeepIntegration(req.params.id, enable)
        registry.refresh(req.params.id)
        return ok()
      }),
    },
    '/api/hosts/:id/launch': {
      POST: api(async (req) => {
        const b = await body(req)
        const pane = await launch(req.params.id, {
          session: b.session, name: b.name, cwd: b.cwd, agent: b.agent ?? (b.claude ? 'claude' : 'shell'),
          model: b.model, mode: b.mode, prompt: b.prompt,
        })
        return json({ pane })
      }),
    },
    '/api/settings': {
      GET: api(() => json(loadSettings())),
      PUT: api(async (req) => {
        const b = await body(req)
        const cur = loadSettings()
        const u = b.uploads ?? {}
        const next = {
          ...cur,
          keepSession: cur.keepSession,
          autoResume: typeof b.autoResume === 'boolean' ? b.autoResume : cur.autoResume,
          uploads: {
            retentionDays: Math.max(0, Math.min(365, Number(u.retentionDays ?? cur.uploads.retentionDays) | 0)),
            maxMB: Math.max(1, Math.min(2048, Number(u.maxMB ?? cur.uploads.maxMB) | 0)),
            longPasteLines: Math.max(5, Math.min(1000, Number(u.longPasteLines ?? cur.uploads.longPasteLines) | 0)),
          },
        }
        saveSettings(next)
        return json(next)
      }),
    },
    '/api/hosts/:id/uploads': {
      GET: api(async (req) => json(await uploadUsage(req.params.id))),
      POST: api(async (req) => {
        // refuse an oversized upload before it's read into memory
        const { maxMB } = loadSettings().uploads
        if (Number(req.headers.get('content-length') ?? 0) > (maxMB + 1) * 1024 * 1024) throw new HttpError(413, `Uploads are limited to ${maxMB} MB`)
        const form = await req.formData().catch(() => {
          throw new HttpError(400, 'Expected multipart form data')
        })
        const files = form.getAll('files').filter((f) => typeof f !== 'string') as unknown as File[]
        if (!files.length) throw new HttpError(400, 'No files')
        const pane = form.get('pane')
        return json({ files: await uploadFiles(req.params.id, typeof pane === 'string' && pane ? paneParam(pane) : undefined, files) })
      }),
    },
    '/api/hosts/:id/uploads/clean': {
      POST: api(async (req) => {
        const b = await body<{ olderThanDays?: number }>(req)
        return json(await cleanUploads(req.params.id, Number(b.olderThanDays ?? 0)))
      }),
    },
    '/api/hosts/:id/setup': {
      GET: api(async (req) => json(await setupReport(req.params.id))),
      POST: api(async (req) => {
        const b = await body<{ action?: string; keepSession?: boolean }>(req)
        if (typeof b.keepSession === 'boolean') {
          setKeepSession(req.params.id, b.keepSession)
          return ok()
        }
        return json(await runSetup(req.params.id, String(b.action ?? '')))
      }),
    },
    '/api/hosts/:id/signin': {
      POST: api(async (req) => {
        const b = await body<{ agent?: string }>(req)
        return json(await startSignIn(req.params.id, String(b.agent) as AgentKind))
      }),
    },
    '/api/hosts/:id/signin/:pane': {
      GET: api(async (req) => json(await readSignIn(req.params.id, paneParam(req.params.pane)))),
      POST: api(async (req) => {
        await answerSignIn(req.params.id, paneParam(req.params.pane), await body(req))
        return ok()
      }),
      DELETE: api(async (req) => {
        await stopSignIn(req.params.id, paneParam(req.params.pane))
        return ok()
      }),
    },
    '/api/hosts/:id/configs': {
      GET: api(async (req) => json(await listConfigs(req.params.id))),
    },
    '/api/hosts/:id/config': {
      GET: api(async (req) => json(await readConfig(req.params.id, q(req, 'path')))),
      PUT: api(async (req) => {
        const b = await body<{ path: string; content: string }>(req)
        return json(await writeConfig(req.params.id, String(b.path), String(b.content ?? '')))
      }),
    },
    '/api/hosts/:id/subagents': {
      GET: api(async (req) => json(await listSubagents(req.params.id, q(req, 'transcript')))),
    },
    '/api/hosts/:id/transcript': {
      GET: api(async (req) => json(await readTranscript(req.params.id, q(req, 'path')))),
    },
    '/api/hosts/:id/task-output': {
      GET: api(async (req) => {
        const path = q(req, 'path') || (await findTaskOutput(req.params.id, q(req, 'id')))
        if (!path) throw new HttpError(404, 'No output saved for that task')
        return json(await taskOutput(req.params.id, path))
      }),
    },
    '/api/hosts/:id/panes/:pane/commands': {
      GET: api(async (req) => json(await listCommands(req.params.id, paneParam(req.params.pane)))),
    },
    '/api/hosts/:id/panes/:pane/models': {
      GET: api(async (req) => json(await listModels(req.params.id, paneParam(req.params.pane)))),
    },
    '/api/hosts/:id/panes/:pane/files': {
      GET: api(async (req) => json(await listFiles(req.params.id, paneParam(req.params.pane)))),
    },
    '/api/hosts/:id/panes/:pane/input': {
      POST: api(async (req) => {
        const b = await body<{ text: string }>(req)
        await inputAnswer(req.params.id, paneParam(req.params.pane), String(b.text ?? ''))
        return ok()
      }),
    },
    '/api/hosts/:id/tasks/stop': {
      POST: api(async (req) => {
        const b = await body<{ path?: string; id?: string }>(req)
        return json(await stopTask(req.params.id, b.path || undefined, b.id))
      }),
    },
    '/api/hosts/:id/panes/:pane/rc': {
      POST: api(async (req) => {
        const b = await body<{ on: boolean }>(req)
        await remoteControl(req.params.id, paneParam(req.params.pane), !!b.on)
        return ok()
      }),
    },
    '/api/hosts/:id/panes/:pane/mode': {
      POST: api(async (req) => {
        const b = await body<{ mode: string }>(req)
        await setMode(req.params.id, paneParam(req.params.pane), String(b.mode))
        return ok()
      }),
    },
    '/api/hosts/:id/panes/:pane/send': {
      POST: api(async (req) => {
        const { text, requestId } = await body<{ text: string; requestId?: string }>(req)
        if (requestId !== undefined && (typeof requestId !== 'string' || !/^[\w-]{1,128}$/.test(requestId))) throw new HttpError(400, 'Invalid send id')
        const submit = () => sendMessage(req.params.id, paneParam(req.params.pane), String(text ?? ''), !!requestId)
        if (requestId) await sendOnce(JSON.stringify([req.params.id, req.params.pane, requestId]), String(text ?? ''), submit)
        else await submit()
        return ok()
      }),
    },
    '/api/hosts/:id/panes/:pane/answer': {
      POST: api(async (req) => {
        const b = await body<{ option: number; text?: string }>(req)
        await answer(req.params.id, paneParam(req.params.pane), Number(b.option), b.text)
        return ok()
      }),
    },
    '/api/hosts/:id/panes/:pane/keys': {
      POST: api(async (req) => {
        const b = await body<{ keys: string[] }>(req)
        if (!Array.isArray(b.keys) || b.keys.length > 20) throw new HttpError(400, 'keys must be a short list')
        await keys(req.params.id, paneParam(req.params.pane), b.keys.map(String))
        return ok()
      }),
    },
    '/api/hosts/:id/panes/:pane/interrupt': {
      POST: api(async (req) => {
        await interrupt(req.params.id, paneParam(req.params.pane))
        return ok()
      }),
    },
    '/api/hosts/:id/panes/:pane/name': {
      PUT: api(async (req) => {
        const { name } = await body<{ name?: string }>(req)
        await renamePane(req.params.id, paneParam(req.params.pane), String(name ?? ''))
        return ok()
      }),
    },
    '/api/hosts/:id/panes/:pane/reconnect': {
      POST: api(async (req) => {
        await reconnectAgent(req.params.id, paneParam(req.params.pane))
        return ok()
      }),
    },
    '/api/hosts/:id/panes/:pane/restart': {
      POST: api(async (req) => {
        await restartAgent(req.params.id, paneParam(req.params.pane))
        return ok()
      }),
    },
    '/api/hosts/:id/panes/:pane/exit': {
      POST: api(async (req) => {
        await exitAgent(req.params.id, paneParam(req.params.pane))
        return ok()
      }),
    },
    '/api/hosts/:id/panes/:pane/rewind': {
      POST: api(async (req) => {
        const b = await body<{ text?: string }>(req)
        await codexRewind(req.params.id, paneParam(req.params.pane), typeof b.text === 'string' ? b.text : undefined)
        return ok()
      }),
    },
    '/api/hosts/:id/panes/:pane/start': {
      POST: api(async (req) => {
        const b = await body<{ agent?: string; resume?: string }>(req)
        await startAgent(req.params.id, paneParam(req.params.pane), (b.agent as any) ?? 'claude', b.resume)
        return ok()
      }),
    },
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
      const client: Client = { kind: 'client', overview: false, chats: new Set(), terms: new Map(), send: () => {} }
      if (srv.upgrade(req, { data: client })) return
      return new Response('Upgrade failed', { status: 400 })
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, { status: 404 })
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
    message: onMessage,
    close: onClose,
  },
})

console.log(`Tether hub listening on ${TLS ? 'https' : 'http'}://${server.hostname}:${server.port}`)
prebuildNode()
if (firstPassword) {
  // a service's output ends up in the journal: only show the password on an interactive terminal
  const file = path.join(DATA_DIR, 'initial-password')
  fs.writeFileSync(file, firstPassword + '\n', { mode: 0o600 })
  if (process.stdout.isTTY) console.log(`\n  First run: your Tether password is  ${firstPassword}`)
  else console.log(`\n  First run: your Tether password is in ${file}`)
  console.log('  Change it with: pnpm --filter @tether/hub set-password (then delete that file)\n')
}
