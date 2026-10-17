import type { AgentKind, ClientMsg, HostConfig, ServerMsg } from '@inyon/protocol'
import { loadSettings, saveSettings } from './config.ts'
import { HttpError, publicConfig, registry } from './hosts/registry.ts'
import { watchers, type Subscriber } from './claude/watcher.ts'
import { answer, codexRewind, endSession, exitAgent, findTaskOutput, forkConversation, inputAnswer, keys, launch, remoteControl, sendMessage, setMode, setUltracode, interrupt, reconnectAgent, renamePane, restartAgent, startAgent, stopTask } from './claude/actions.ts'
import {
  cleanUploads, listCommands, listConfigs, listFiles, listSubagents, readConfig, readTranscript,
  startUploadJanitor, taskOutput, uploadFiles, uploadPiece, uploadUsage, writeConfig,
} from './features/features.ts'
import { ensureSessions, runSetup, setKeepSession, setupReport } from './features/setup.ts'
import { answerSignIn, readSignIn, startSignIn, stopSignIn } from './features/signin.ts'
import { installIntegration, uninstallIntegration } from './claude/integration.ts'
import { openTerminal } from './terminal/terminal.ts'
import type { PtyHandle } from './hosts/host.ts'
import { nodeLinks } from './hosts/node-link.ts'
import { tidyMachine } from './hosts/tidy.ts'
import { rememberRemoved } from './hosts/removed-nodes.ts'
import { nodeUpdates } from './hosts/node-update.ts'
import { listModels } from './features/models.ts'
import { sendOnce } from './claude/send-receipts.ts'
import { pruneChats } from './claude/chat-cache.ts'
import { lastReply } from './claude/last-reply.ts'
import { saveDrafts } from './claude/drafts.ts'
import { paneConversations, switchConversation } from './features/conversations.ts'
import { gitCommit, gitDiff, gitPush, gitStatus, listDir, readFile } from './features/workspace.ts'

/**
 * Inyon's API and live updates, independent of how they are served: the hub puts them behind
 * HTTP and a WebSocket with sign-in; the phone app calls them in-process.
 */

// ---------- helpers ----------

export const json = (data: unknown, init: ResponseInit = {}) => Response.json(data, init)

/**
 * The request body as it arrives, failing with 413 once it passes `limit` bytes. Content-Length is
 * checked first, but a chunked body has none, so the bytes are counted as well.
 */
export function limitedBody(req: Request, limit: number, message = 'Request too large'): ReadableStream<Uint8Array> {
  if (Number(req.headers.get('content-length') ?? 0) > limit) throw new HttpError(413, message)
  let seen = 0
  return (req.body ?? new Response('').body!).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        seen += chunk.byteLength
        if (seen > limit) out.error(new HttpError(413, message))
        else out.enqueue(chunk)
      },
    }),
  )
}

export async function body<T = any>(req: Request, limit = 1024 * 1024): Promise<T> {
  // JSON bodies are small; refuse big ones without reading them into memory
  const text = await new Response(limitedBody(req, limit)).text().catch((err) => {
    throw err instanceof HttpError ? err : new HttpError(400, 'Invalid JSON')
  })
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

/** URL-safe pane ids: "%12" travels as "12". */
export const paneParam = (p: string) => (p.startsWith('%') ? p : `%${p}`)

export const ok = () => json({ ok: true })

export const q = (req: Request, name: string) => new URL(req.url).searchParams.get(name) ?? ''

export type Handler = (req: Request & { params: Record<string, string> }) => Promise<Response> | Response
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type Routes = Record<string, Handler | Partial<Record<Method, Handler>>>

/** Errors become JSON responses with the right status. */
export const api =
  (fn: Handler): Handler =>
  async (req) => {
    try {
      return await fn(req)
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, { status: err.status })
      console.error(err)
      return json({ error: String((err as Error)?.message ?? err) }, { status: 500 })
    }
  }

export function validateHost(b: Partial<HostConfig>): Omit<HostConfig, 'id'> {
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

/** A readable id for a new machine, unique among the ones already added. */
export function newHostId(name: string) {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'host'
  let unique = id
  for (let i = 2; registry.get(unique); i++) unique = `${id}-${i}`
  return unique
}

// ---------- websocket clients ----------

export interface Client extends Subscriber {
  kind: 'client'
  overview: boolean
  chats: Set<string>
  terms: Map<string, PtyHandle>
}

export const clients = new Set<Client>()

type Notice = Extract<ServerMsg, { t: 'notify' }>
/** Others that hear each notification with its final text: a hub's Web Push (push/hub-push.ts). */
export const noticeSinks = new Set<(n: Notice) => void>()

registry.on((e) => {
  if (e.type === 'overview') {
    const msg: ServerMsg = { t: 'overview', hosts: registry.overview() }
    for (const c of clients) if (c.overview) c.send(msg)
  } else if (e.type === 'notify') {
    let sent = false
    const send = (body: string) => {
      if (sent) return
      sent = true
      const n: Notice = { t: 'notify', host: e.host, pane: e.pane, kind: e.kind, title: e.title, body, agent: e.agent as any }
      for (const c of clients) c.send(n)
      for (const sink of noticeSinks) sink(n)
    }
    if (e.kind !== 'done') return send(e.body)
    // "Claude finished" says little: show the start of its reply instead, if it's quick to find
    setTimeout(() => send(e.body), 2500)
    lastReply(e.host, e.pane).then((reply) => send(reply || e.body), () => send(e.body))
  }
})

/**
 * Writes now what would otherwise be saved a few seconds from now: open chats, drafts, and what
 * each machine looked like. For when the phone app goes to the background or the hub stops.
 */
export function saveEverything() {
  for (const save of [() => watchers.saveAll(), saveDrafts, () => registry.saveAll()]) {
    try {
      save()
    } catch (err) {
      console.error('saving before closing:', err)
    }
  }
}

/** A connected app: it gets updates through `send` once added to `clients`. */
export const newClient = (send: (msg: ServerMsg) => void = () => {}): Client => ({ kind: 'client', overview: false, chats: new Set(), terms: new Map(), send })

/** chats one app can watch at once */
const MAX_CHATS = 64

/** Runs `fn` once the machine reports the pane, now if it already does; gives up after 30 s. */
function whenPane(host: string, pane: string, fn: () => void) {
  if (registry.findPane(host, pane)) return fn()
  const off = registry.on((e) => {
    if (e.type !== 'overview' || !registry.findPane(host, pane)) return
    off()
    clearTimeout(timer)
    fn()
  })
  const timer = setTimeout(off, 30_000)
}

/** One message from an app (raw JSON text). */
export function clientMessage(c: Client, raw: string) {
  let m: ClientMsg
  try {
    m = JSON.parse(raw)
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
      if (c.chats.has(key) || !registry.get(m.host) || typeof m.pane !== 'string' || !/^%\d+(\.\d+)?$/.test(m.pane) || c.chats.size >= MAX_CHATS) return
      c.chats.add(key)
      // only a pane the machine has gets a watcher; one just launched may show up a moment later
      return whenPane(m.host, m.pane, () => {
        if (clients.has(c) && c.chats.has(key)) watchers.get(m.host, m.pane).subscribe(c)
      })
    }
    case 'unsub.chat': {
      const key = `${m.host}:${m.pane}`
      if (!c.chats.delete(key)) return
      return watchers.peek(m.host, m.pane)?.unsubscribe(c)
    }
    case 'chat.more':
      return void watchers.peek(m.host, m.pane)?.more(c, m.before)
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

/** The app went away: stop everything it was watching. */
export function closeClient(c: Client) {
  clients.delete(c)
  for (const key of c.chats) {
    const i = key.indexOf(':')
    watchers.peek(key.slice(0, i), key.slice(i + 1))?.unsubscribe(c)
  }
  for (const t of c.terms.values()) t.kill()
}

// ---------- API ----------

export const coreRoutes: Routes = {
  '/api/refresh': {
    POST: api(async () => {
      await registry.refreshAll()
      return ok()
    }),
  },
  '/api/hosts': {
    GET: api(() => json(registry.configs().map(publicConfig))),
    POST: api(async (req) => {
      const cfg = validateHost(await body(req))
      const id = newHostId(cfg.name)
      registry.add({ ...cfg, id })
      return json({ id })
    }),
  },
  '/api/hosts/:id': {
    PATCH: api(async (req) => {
      const id = req.params.id
      const cur = registry.get(id)?.host.config
      if (!cur) throw new HttpError(404, 'Unknown machine')
      const b = await body(req)
      if (cur.kind !== 'ssh') registry.update(id, { name: String(b.name ?? cur.name).trim() || cur.name })
      else {
        const next = validateHost({ ...cur, ...b })
        // a new address or key: the connection kept open to the old one goes
        if (next.target !== cur.target || next.port !== cur.port || next.identityFile !== cur.identityFile) await registry.get(id)?.host.close()
        registry.update(id, next)
      }
      return ok()
    }),
    DELETE: api(async (req) => {
      if (req.params.id === 'local') throw new HttpError(400, 'This machine cannot be removed')
      const rt = registry.get(req.params.id)
      // hooks, uploads and the open connection come off the machine first, while it still answers
      if (rt) await tidyMachine(rt.host, rt.state)
      rememberRemoved(rt?.host.config.tokenHash)
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
  // one tap in the app: brings the machine's inyon up to date (see hosts/node-update.ts)
  '/api/hosts/:id/node/update': {
    POST: api((req) => {
      const rt = registry.get(req.params.id)
      if (!rt) throw new HttpError(404, 'Unknown machine')
      const refused = nodeUpdates.start(rt.host, rt.state)
      if (refused) throw new HttpError(409, refused)
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
          maxTotalMB: Math.max(0, Math.min(102400, Number(u.maxTotalMB ?? cur.uploads.maxTotalMB) | 0)),
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
      // refuse an oversized upload as soon as it passes the limit, chunked or not
      const { maxMB } = loadSettings().uploads
      const counted = limitedBody(req, (maxMB + 1) * 1024 * 1024, `Uploads are limited to ${maxMB} MB`)
      const form = await new Response(counted, { headers: { 'content-type': req.headers.get('content-type') ?? '' } }).formData().catch((err) => {
        throw err instanceof HttpError ? err : new HttpError(400, 'Expected multipart form data')
      })
      const files = form.getAll('files').filter((f) => typeof f !== 'string') as unknown as File[]
      if (!files.length) throw new HttpError(400, 'No files')
      const pane = form.get('pane')
      const paneId = typeof pane === 'string' && pane ? paneParam(pane) : undefined
      const total = form.get('total')
      if (typeof total === 'string') {
        const path = form.get('path')
        return json({ files: [await uploadPiece(req.params.id, paneId, files[0], { total: Number(total), offset: Number(form.get('offset') ?? 0), path: typeof path === 'string' ? path : undefined })] })
      }
      return json({ files: await uploadFiles(req.params.id, paneId, files) })
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
  // the session's folder: its files (read only) and its git working tree
  '/api/hosts/:id/panes/:pane/dir': {
    GET: api(async (req) => json(await listDir(req.params.id, paneParam(req.params.pane), q(req, 'path')))),
  },
  '/api/hosts/:id/panes/:pane/file': {
    GET: api(async (req) => json(await readFile(req.params.id, paneParam(req.params.pane), q(req, 'path')))),
  },
  '/api/hosts/:id/panes/:pane/git': {
    GET: api(async (req) => json(await gitStatus(req.params.id, paneParam(req.params.pane)))),
  },
  '/api/hosts/:id/panes/:pane/git/diff': {
    GET: api(async (req) => json(await gitDiff(req.params.id, paneParam(req.params.pane), q(req, 'path')))),
  },
  '/api/hosts/:id/panes/:pane/git/commit': {
    POST: api(async (req) => json(await gitCommit(req.params.id, paneParam(req.params.pane), (await body<{ message?: string }>(req)).message))),
  },
  '/api/hosts/:id/panes/:pane/git/push': {
    POST: api(async (req) => json(await gitPush(req.params.id, paneParam(req.params.pane)))),
  },
  '/api/hosts/:id/panes/:pane/fork': {
    POST: api(async (req) => json({ pane: await forkConversation(req.params.id, paneParam(req.params.pane)) })),
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
  '/api/hosts/:id/panes/:pane/ultracode': {
    POST: api(async (req) => {
      const b = await body<{ on: boolean }>(req)
      await setUltracode(req.params.id, paneParam(req.params.pane), !!b.on)
      return ok()
    }),
  },
  '/api/hosts/:id/panes/:pane/send': {
    POST: api(async (req) => {
      const { text, requestId, setting } = await body<{ text: string; requestId?: string; setting?: boolean }>(req)
      if (requestId !== undefined && (typeof requestId !== 'string' || !/^[\w-]{1,128}$/.test(requestId))) throw new HttpError(400, 'Invalid send id')
      const submit = () => sendMessage(req.params.id, paneParam(req.params.pane), String(text ?? ''), !!requestId, requestId, setting === true)
      if (requestId) await sendOnce(JSON.stringify([req.params.id, req.params.pane, requestId]), String(text ?? ''), submit)
      else await submit()
      return ok()
    }),
  },
  '/api/hosts/:id/panes/:pane/answer': {
    POST: api(async (req) => {
      const b = await body<{ option: number; text?: string; question?: string }>(req)
      await answer(req.params.id, paneParam(req.params.pane), Number(b.option), b.text, typeof b.question === 'string' ? b.question : undefined)
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
  '/api/hosts/:id/panes/:pane/end': {
    POST: api(async (req) => json(await endSession(req.params.id, paneParam(req.params.pane)))),
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
  // the agent's past conversations in the pane's folder; `agent` says whose when none is running
  '/api/hosts/:id/panes/:pane/conversations': {
    GET: api(async (req) => json(await paneConversations(req.params.id, paneParam(req.params.pane), q(req, 'agent') || undefined))),
  },
  // exits the running agent (the pane stays) and reopens it on another of its conversations
  '/api/hosts/:id/panes/:pane/switch': {
    POST: api(async (req) => {
      const b = await body<{ agent?: string; id?: string }>(req)
      return json(await switchConversation(req.params.id, paneParam(req.params.pane), b.agent || undefined, b.id))
    }),
  },
}

/** Starts watching machines and the housekeeping timers. */
export function startCore() {
  registry.start()
  startUploadJanitor()
  pruneChats()
  setInterval(() => ensureSessions().catch(() => {}), 30_000)
  setTimeout(() => ensureSessions().catch(() => {}), 5_000)
}
