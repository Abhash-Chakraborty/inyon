import crypto from 'node:crypto'
import { promptKey, type ChatInfo, type ScreenState, type CompanionClaimResult, type CompanionMe, type CompanionPairCode, type CompanionScope, type HostState, type PairedCompanion, type ServerMsg } from '@inyon/protocol'
import { HttpError, registry } from './hosts/registry.ts'
import { kv } from './platform/store.ts'
import { answer, currentScreen, sendMessage } from './claude/actions.ts'
import { watchers } from './claude/watcher.ts'
import { sendOnce } from './claude/send-receipts.ts'
import { body, json, paneParam } from './core.ts'
import { hubAbout, hubId } from './phones.ts'
import { servedFingerprint } from './tls.ts'

/**
 * Companion apps (Legato and the like), contract version 1. A companion pairs with a short code
 * the signed-in web app (or `inyon hub companion-code`) shows, and gets a bearer token with four
 * scopes: read the overview, watch chats, answer prompts and send text. Every request it makes
 * carries `X-Inyon-Contract`, and the hub checks its scope on every route and WebSocket frame; the
 * rest of the API answers 403. The token is kept as its hash only, as a phone's is.
 */

/** 1.1 only adds fields (the certificate's SHA-256 in the code and the claim), so it is still 1 on the wire */
export const CONTRACTS = [1]
export const CONTRACT = 1
export const SCOPES: CompanionScope[] = ['overview', 'chat', 'answer', 'send']
/** how long a code stays claimable */
export const COMPANION_CODE_TTL = 5 * 60_000
/** failed claims one address gets a minute, and all addresses together */
const CLAIMS_PER_MINUTE = 8
const ALL_CLAIMS_PER_MINUTE = 30
/** how often a companion's lastSeen is written */
const SEEN_EVERY = 60_000
/** no 0, O, 1, I or L: a code is read off one screen and typed into another */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

interface CompanionRecord {
  id: string
  name: string
  app?: string
  /** sha256 of the token, hex */
  tokenHash: string
  scopes: CompanionScope[]
  contractVersion: number
  pairedAt: number
  lastSeen: number
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
// byte lengths: a code with a non-ASCII letter has more bytes than characters, and timingSafeEqual throws on a mismatch
const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

let companions: CompanionRecord[] = kv.get<CompanionRecord[]>('companions') ?? []
const save = () => kv.set('companions', companions)

/** A refusal a companion can act on: the message to show, and a reason that stays the same. */
export const refuse = (status: number, reason: string, error: string, extra: Record<string, unknown> = {}) => json({ error, reason, ...extra }, { status })

// ---------- the code ----------

// one code at a time: a new one ends the last
let current: { code: string; expiresAt: number } | undefined

function newCode() {
  let out = ''
  while (out.length < 6) {
    // 248 is the largest multiple of 31 under 256, so every character is as likely
    for (const b of crypto.randomBytes(8)) if (b < 248 && out.length < 6) out += ALPHABET[b % ALPHABET.length]
  }
  return out
}

/** A fresh code for the web app or the inyon command to show. */
export function newCompanionCode(now = Date.now()): CompanionPairCode {
  current = { code: newCode(), expiresAt: now + COMPANION_CODE_TTL }
  const fp = servedFingerprint()
  return { ...current, ...(fp ? { tlsFingerprint: fp } : {}) }
}

const failures = new Map<string, { n: number; reset: number }>()
const allFailures = { n: 0, reset: 0 }

function countFailure(ip: string, now: number) {
  for (const [k, v] of failures) if (v.reset < now) failures.delete(k)
  const a = failures.get(ip) ?? { n: 0, reset: now + 60_000 }
  a.n++
  failures.set(ip, a)
  if (allFailures.reset < now) Object.assign(allFailures, { n: 0, reset: now + 60_000 })
  allFailures.n++
}

/** The code typed as it may come: any case, with spaces or a dash in it. */
const cleanCode = (s: unknown) => String(s ?? '').replace(/[\s-]+/g, '').toUpperCase()

/** A companion hands in the code. Wrong and expired codes read the same; failures are counted per address and in all. */
export function claimCompanion(ip: string, b: { code?: unknown; name?: unknown; app?: unknown }, now = Date.now()): Response {
  const a = failures.get(ip)
  if ((a && a.reset >= now && a.n >= CLAIMS_PER_MINUTE) || (allFailures.reset >= now && allFailures.n >= ALL_CLAIMS_PER_MINUTE)) {
    return refuse(429, 'rate-limit', 'Too many attempts. Try again in a minute.')
  }
  const code = cleanCode(b.code)
  if (!current || current.expiresAt <= now || !same(code, current.code)) {
    countFailure(ip, now)
    return refuse(401, 'bad-code', 'That code is not right or has expired. Make a new one in Inyon.')
  }
  current = undefined
  const token = crypto.randomBytes(32).toString('base64url')
  const name = String(b.name ?? '').trim().slice(0, 60) || 'Companion app'
  const app = typeof b.app === 'string' && b.app.trim() ? b.app.trim().slice(0, 60) : undefined
  companions.push({ id: crypto.randomBytes(6).toString('hex'), name, ...(app ? { app } : {}), tokenHash: sha256(token), scopes: [...SCOPES], contractVersion: CONTRACT, pairedAt: now, lastSeen: now })
  save()
  // a companion that pins the certificate gets it here too (contract 1.1)
  const fp = servedFingerprint()
  const result: CompanionClaimResult = { token, hubId: hubId(), scopes: [...SCOPES], contractVersion: CONTRACT, ...(fp ? { tlsFingerprint: fp } : {}) }
  return json(result)
}

// ---------- a companion's requests ----------

const bearer = (req: Request) => req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]

/** The companion a request comes from, by its bearer token. */
export function companionFor(req: Request, now = Date.now()): CompanionRecord | undefined {
  const token = bearer(req)
  if (!token) return
  const hash = sha256(token)
  const c = companions.find((x) => same(x.tokenHash, hash))
  if (c && now - c.lastSeen >= SEEN_EVERY) {
    c.lastSeen = now
    save()
  }
  return c
}

/** 426 unless the request names a contract this hub speaks, in its header or (a WebSocket) `?contract=`. */
export function contractRefusal(req: Request, fromQuery?: string | null): Response | undefined {
  const given = (req.headers.get('x-inyon-contract') ?? fromQuery ?? '').trim()
  if (CONTRACTS.some((v) => String(v) === given)) return
  const error = given
    ? `This hub doesn't support companion contract ${given.slice(0, 20)}. It supports ${CONTRACTS.join(', ')}.`
    : `Send the X-Inyon-Contract header. This hub supports companion contract ${CONTRACTS.join(', ')}.`
  return refuse(426, 'contract', error, { supported: CONTRACTS })
}

export const SCOPE_REFUSED = "Companion apps can't use this"

/** What a companion may call, and with which scope; every other route refuses it. */
export interface CompanionRoute {
  scope?: CompanionScope
  run: (req: Request & { params: Record<string, string> }, c: CompanionRecord) => Response | Promise<Response>
}

/**
 * A companion's request on a route: 426 for a contract this hub doesn't speak, 403 for a route
 * (or a scope) that isn't its, else the route's companion handler.
 */
export async function asCompanion(req: Request & { params: Record<string, string> }, c: CompanionRecord, route?: CompanionRoute): Promise<Response> {
  const refused = contractRefusal(req)
  if (refused) return refused
  if (!route || (route.scope && !c.scopes.includes(route.scope))) return refuse(403, 'scope', SCOPE_REFUSED)
  try {
    return await route.run(req, c)
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, { status: err.status })
    console.error(err)
    return json({ error: String((err as Error)?.message ?? err) }, { status: 500 })
  }
}

export const companionMe = (c: CompanionRecord): CompanionMe => ({ id: c.id, name: c.name, ...(c.app ? { app: c.app } : {}), scopes: c.scopes, contractVersion: c.contractVersion, hub: hubAbout() })

// ---------- answer and send ----------

/** Why a pane can't be acted on now: gone, or its machine isn't reachable. */
function paneProblem(hostId: string, paneId: string) {
  const rt = registry.get(hostId)
  if (!rt || !registry.findPane(hostId, paneId)) return refuse(409, 'pane-gone', 'That session is gone.')
  if (rt.state.status !== 'online') return refuse(409, 'offline', `${rt.host.config.name} isn't reachable right now.`)
}

/** An answer to the question the companion saw, by its key: anything else on screen now is "already answered". */
const companionAnswer: CompanionRoute['run'] = async (req, c) => {
  const b = await body<{ option?: unknown; key?: unknown; text?: unknown }>(req)
  const host = req.params.id!
  const pane = paneParam(req.params.pane!)
  if (typeof b.key !== 'string' || !b.key) return refuse(400, 'bad-request', 'Send the prompt key from chat.screen with the answer.')
  const option = typeof b.option === 'number' && Number.isInteger(b.option) && b.option >= 0 ? b.option : undefined
  if (option === undefined) return refuse(400, 'bad-request', 'option must be the number of a choice.')
  const text = typeof b.text === 'string' ? b.text : undefined
  const gone = paneProblem(host, pane)
  if (gone) return gone
  const p = (await currentScreen(host, pane)).prompt
  if (!p || promptKey(p) !== b.key) return refuse(409, 'already-answered', 'That question was already answered, or is no longer on screen.')
  if (!(option === 0 ? p.confirm : p.options.some((o) => o.n === option))) return refuse(400, 'bad-option', `That question has no option ${option}.`)
  // an answer picks a choice; typed words go only into the question's own free-text choice, and
  // they're text sent to the agent, so they need the send scope and its rules
  const typed = text?.trim() ? text : undefined
  if (typed) {
    if (option !== p.freeTextOption) return refuse(400, 'bad-request', 'Text goes only with the question’s free-text choice.')
    if (!c.scopes.includes('send')) return refuse(403, 'scope', 'Typing an answer needs the send permission.')
    const refused = textRefusal(typed)
    if (refused) return refused
  }
  try {
    await answer(host, pane, option, typed, b.key)
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) return refuse(409, 'already-answered', 'That question was already answered, or is no longer on screen.')
    if (err instanceof HttpError && err.status === 404) return refuse(409, 'pane-gone', 'That session is gone.')
    throw err
  }
  return json({ ok: true })
}

/** C0 controls but tab and the line ends, DEL and C1: the bytes that work as keys (Ctrl-U, Esc, a paste's end) rather than text. */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/

/**
 * Why a companion's text can't be typed into a session, or undefined when it can: only printable
 * text, tabs and line breaks, and no line that starts with / or ! (an agent's command, a shell).
 */
export function textRefusal(text: string) {
  if (CONTROL.test(text)) return refuse(400, 'bad-request', 'Companion apps send printable text: no control characters or escape sequences.')
  if (text.split(/[\r\n]/).some((line) => /^[/!]/.test(line.trimStart()))) return refuse(403, 'scope', 'Companion apps send plain text, not / or ! commands.')
}

/** Why the hub's send didn't land, from what it said: the same messages in both hubs. */
export function sendReason(message: string) {
  if (/waiting for an answer/i.test(message)) return 'prompt-open'
  if (/No agent is running/i.test(message)) return 'no-agent'
  if (/input is not visible|when it finishes working/i.test(message)) return 'busy'
  return 'not-landed'
}

/** Plain text into a session, closed-loop: 200 says how far it got, 409 why it didn't land. */
const companionSend: CompanionRoute['run'] = async (req, c) => {
  const b = await body<{ text?: unknown; requestId?: unknown }>(req)
  const host = req.params.id!
  const pane = paneParam(req.params.pane!)
  if (typeof b.text !== 'string' || !b.text.trim()) return refuse(400, 'bad-request', 'Message is empty')
  const text = b.text
  const refused = textRefusal(text)
  if (refused) return refused
  if (b.requestId !== undefined && (typeof b.requestId !== 'string' || !/^[\w-]{1,128}$/.test(b.requestId))) return refuse(400, 'bad-request', 'Invalid send id')
  const gone = paneProblem(host, pane)
  if (gone) return gone
  if (!registry.findPane(host, pane)?.pane.agent) return refuse(409, 'no-agent', 'No agent is running in this pane')
  const id = b.requestId ? `companion-${b.requestId}` : `companion-${crypto.randomUUID()}`
  try {
    const submit = () => sendMessage(host, pane, text, false, id)
    if (b.requestId) await sendOnce(JSON.stringify(['companion', c.id, host, pane, b.requestId]), text, submit)
    else await submit()
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    if (err instanceof HttpError && err.status === 404) return refuse(409, 'pane-gone', 'That session is gone.')
    if (err instanceof HttpError && err.status === 400) return refuse(400, 'bad-request', message)
    return refuse(409, err instanceof HttpError && err.status === 409 ? sendReason(message) : 'not-landed', message)
  }
  const state = watchers.peek(host, pane)?.delivery(id)?.state
  return json({ ok: true, state: state === 'delivered' || state === 'queued' ? state : 'sent' })
}

/**
 * The overview as a companion gets it: enough to list sessions and label them. Who each machine
 * is, never how the hub reaches it (SSH target, key file, relays); no folders, transcripts,
 * process ids or the agent's numbers.
 */
export const COMPANION_HOST = ['config', 'status', 'sessions'] as const
export const COMPANION_SESSION = ['id', 'name', 'windows'] as const
export const COMPANION_WINDOW = ['id', 'index', 'name', 'active', 'panes'] as const
export const COMPANION_PANE = ['id', 'index', 'active', 'title', 'label', 'dead', 'agent'] as const
export const COMPANION_AGENT = ['kind', 'state', 'mode', 'waitingFor', 'options', 'activity'] as const

export const companionHosts = (hosts: HostState[]) =>
  hosts.map((h) => ({
    ...pick(h, COMPANION_HOST),
    config: { id: h.config.id, name: h.config.name, kind: h.config.kind },
    sessions: h.sessions.map((s) => ({
      ...pick(s, COMPANION_SESSION),
      windows: s.windows.map((w) => ({
        ...pick(w, COMPANION_WINDOW),
        panes: w.panes.map((p) => ({ ...pick(p, COMPANION_PANE), ...(p.agent ? { agent: pick(p.agent, COMPANION_AGENT) } : {}) })),
      })),
    })),
  }))

const overview: CompanionRoute['run'] = () => json({ hosts: companionHosts(registry.overview()) })

/** The routes a companion may call, by path and method. */
export const companionRoutes: Record<string, Partial<Record<'GET' | 'POST', CompanionRoute>>> = {
  '/api/overview': { GET: { scope: 'overview', run: overview } },
  '/api/hosts/:id/panes/:pane/answer': { POST: { scope: 'answer', run: companionAnswer } },
  '/api/hosts/:id/panes/:pane/send': { POST: { scope: 'send', run: companionSend } },
}

// ---------- the WebSocket ----------

/** What a companion may send on /ws, and the scope each needs. */
const INBOUND: Record<string, CompanionScope | null> = { ping: null, 'sub.overview': 'overview', 'sub.chat': 'chat', 'unsub.chat': 'chat' }

/** Why a companion's frame is refused (the socket closes with 4403 and this), or undefined when it may go on. */
export function inboundRefusal(raw: string, scopes: CompanionScope[]): string | undefined {
  let t: unknown
  try {
    t = (JSON.parse(raw) as { t?: unknown } | null)?.t
  } catch {}
  const name = typeof t === 'string' ? t : ''
  if (Object.hasOwn(INBOUND, name)) {
    const need = INBOUND[name]
    if (!need || scopes.includes(need)) return
  }
  return `Not for companion apps: ${name.slice(0, 40) || 'an unreadable frame'}`
}

const pick = <T extends object>(o: T, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => (o as Record<string, unknown>)[k] !== undefined).map((k) => [k, (o as Record<string, unknown>)[k]]))

/** A chat's details as a companion gets them: no drafts, queue, send texts, links or paths. */
export const COMPANION_INFO = ['hostId', 'paneId', 'agent', 'title', 'model', 'mode', 'running', 'status', 'turn', 'sends'] as const
export const COMPANION_SEND = ['id', 'state', 'at'] as const
/** A chat's screen as a companion gets it: the question and the agent's state, not the input box's text. */
export const COMPANION_SCREEN = ['inputVisible', 'prompt', 'working', 'activity', 'since', 'mode', 'model', 'effort', 'dialog', 'width'] as const

export function companionInfo(info: ChatInfo) {
  const v = pick(info, COMPANION_INFO)
  if (info.sends) v.sends = info.sends.map((s) => pick(s, COMPANION_SEND))
  return v
}

export function companionScreen(screen: ScreenState) {
  const v = pick(screen, COMPANION_SCREEN)
  if (screen.prompt) v.prompt = { ...screen.prompt, key: promptKey(screen.prompt) }
  return v
}

/**
 * What a companion gets of a message to the app: the overview, notices, a chat's info and screen
 * (its question with the key to answer it by), and pong. Chat history, live text, drafts and
 * terminal data never go to a companion.
 */
export function companionFrame(msg: ServerMsg, scopes: CompanionScope[]): unknown {
  const can = (s: CompanionScope) => scopes.includes(s)
  switch (msg.t) {
    case 'pong':
      return msg
    case 'overview':
      return can('overview') ? { ...msg, hosts: companionHosts(msg.hosts) } : undefined
    case 'notify':
      return can('overview') ? msg : undefined
    case 'chat.info':
    case 'chat.reset':
      return can('chat') ? { t: 'chat.info', key: msg.key, info: companionInfo(msg.info) } : undefined
    case 'chat.screen':
      return can('chat') ? { t: 'chat.screen', key: msg.key, screen: companionScreen(msg.screen) } : undefined
  }
}

// ---------- the list and removal ----------

// a token is only checked when a connection opens, so removing a companion has to close the ones it has
const sockets = new Map<{ close(code?: number, reason?: string): void }, string>()

export function holdCompanionSocket(id: string, socket: { close(code?: number, reason?: string): void }) {
  sockets.set(socket, id)
  return () => void sockets.delete(socket)
}

export const listCompanions = (): PairedCompanion[] =>
  companions.map(({ id, name, app, scopes, contractVersion, pairedAt, lastSeen }) => ({ id, name, ...(app ? { app } : {}), scopes, contractVersion, pairedAt, lastSeen }))

/** Forgets a companion: its token stops working now, and its connections are closed. */
export function revokeCompanion(id: string) {
  if (!companions.some((c) => c.id === id)) return false
  companions = companions.filter((c) => c.id !== id)
  save()
  for (const [socket, c] of sockets) {
    if (c !== id) continue
    sockets.delete(socket)
    try {
      socket.close(4001, 'Companion removed')
    } catch {}
  }
  return true
}

export type { CompanionRecord }
