import type { AgentCatalog, AgentKind, ChatItem, SlashCommand } from '@inyon/protocol'
import { hubOrigin } from './hub.ts'
import { isPhone, phone } from './phone.ts'
import { isHubHost, splitHostId, type PairedHub } from './hubs.ts'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** The paired hub a request about one of its machines belongs to, and its address there. */
function hubTarget(url: URL): { hub: PairedHub; url: string } | undefined {
  const m = url.pathname.match(/^\/api\/hosts\/([^/]+)(.*)$/)
  if (!m) return
  const { hub, id } = splitHostId(decodeURIComponent(m[1]!))
  if (!hub) return
  return { hub, url: `${hub.url}/api/hosts/${encodeURIComponent(id)}${m[2]}${url.search}` }
}

/**
 * A request about one of a paired hub's machines goes to that hub, with the phone's token. The
 * body goes as bytes read in advance: handed on as a stream, Chromium (and so the Android app)
 * sends it only over HTTP/2 and fails it on a hub's HTTP/1.1 before it leaves the phone.
 */
async function toHub(req: Request, { hub, url }: { hub: PairedHub; url: string }): Promise<Response> {
  const headers = new Headers(req.headers)
  headers.set('authorization', `Bearer ${hub.token}`)
  const body = req.body ? await req.arrayBuffer() : undefined
  try {
    return await fetch(url, { method: req.method, headers, body, credentials: 'omit', signal: req.signal })
  } catch {
    // nothing came back: name the hub rather than say the browser's "Failed to fetch"
    if (req.signal.aborted) throw new ApiError(0, `${hub.name} took too long to answer`)
    throw new ApiError(0, `Couldn't reach ${hub.name}. Check this phone's connection to it.`)
  }
}

/** The hub over HTTP in a browser; the core running inside the phone app; a paired hub for its machines. */
async function send(req: Request): Promise<Response> {
  const hub = hubTarget(new URL(req.url))
  if (hub) return toHub(req, hub)
  if (!isPhone()) return fetch(req)
  const rt = await phone()
  // an in-process call can't be cut off, but the caller's timeout still applies
  return new Promise((resolve, reject) => {
    req.signal.addEventListener('abort', () => reject(new ApiError(0, 'The server took too long to answer')), { once: true })
    rt.fetch(req).then(resolve, reject)
  })
}

async function request<T>(method: string, url: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await send(new Request(new URL(url, location.href), {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  }))
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // a paired hub refusing the phone's token doesn't sign this app out
    if (res.status === 401 && !url.endsWith('/login') && !hubTarget(new URL(url, location.href))) window.dispatchEvent(new Event('inyon:signed-out'))
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`)
  }
  return data as T
}

/** Pane ids travel without the leading "%". */
export const paneSlug = (pane: string) => pane.replace(/^%/, '')
export const paneFromSlug = (slug: string) => (slug.startsWith('%') ? slug : `%${slug}`)

const h = (id: string) => `/api/hosts/${encodeURIComponent(id)}`
const panePath = (host: string, pane: string) => `${h(host)}/panes/${paneSlug(pane)}`
const qs = (o: Record<string, string>) => `?${new URLSearchParams(o)}`

export interface Uploaded {
  name: string
  path: string
  size: number
  type: string
}

export interface UploadUsage {
  bytes: number
  files: number
  expired: number
  dir: string
}

export interface ConfigFile {
  agent: AgentKind
  label: string
  path: string
  format: 'json' | 'toml' | 'md'
  exists: boolean
  size: number
  mtime?: number
}

export interface SetupCheck {
  id: string
  label: string
  ok: boolean
  detail?: string
  fix?: { label: string; action: string }
  manual?: string
}

export interface SignInScreen {
  lines: string[]
  links: string[]
  code?: string
  input?: { label: string; secret?: boolean }
  exit?: number
  menu?: { question?: string; options: { n: number; label: string; detail?: string; selected: boolean }[] }
}

export interface SetupReport {
  os: string
  pkg?: string
  sudo: boolean
  checks: SetupCheck[]
  agents: { kind: AgentKind; installed: boolean; version?: string; signedIn: boolean }[]
  keepSession: boolean
}

export interface ServerForm {
  name: string
  target: string
  port?: number
  /** set when the phone connects itself; a paired computer checks the key on its own */
  hostKey?: string
  auth?: 'phone-key' | 'password' | 'key' | 'none'
  /** the paired computer that opens the connection ('' for the phone itself) */
  via?: string
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface HubSettings {
  uploads: { retentionDays: number; maxMB: number; longPasteLines: number }
  autoResume?: boolean
}

/** The hub's own update (hub mode only; see apps/hub/src/features/hub-update.ts). */
export interface HubUpdate {
  current: string
  latest?: string
  behind?: number
  canUpdate: boolean
  reason?: string
  checkedAt: number
  running?: boolean
  error?: string
  log?: string
  restartNeeded?: boolean
}

export const api = {
  /** `version` and `commit` say what the hub runs, once signed in */
  session: () => request<{ authed: boolean; setup?: boolean; setupCode?: boolean; version?: string; commit?: string }>('GET', '/api/session'),
  // a new hub: the first visit picks the password
  createPassword: (password: string, code?: string) => request<{ ok: boolean }>('POST', '/api/setup', { password, code }),
  changePassword: (current: string, next: string) => request<{ ok: boolean }>('POST', '/api/password', { current, next }),
  login: (password: string) => request<{ ok: boolean }>('POST', '/api/login', { password }),
  logout: () => request('POST', '/api/logout').catch(() => {}),
  addHost: (b: { name: string; target: string; port?: number; identityFile?: string }) => request<{ id: string }>('POST', '/api/hosts', b),
  // the phone app: servers it SSHes into itself
  addServer: (b: ServerForm) => request<{ id: string }>('POST', '/api/hosts', b),
  editServer: (id: string, b: Partial<ServerForm>) => request('PATCH', h(id), b),
  probe: (target: string, port?: number) => request<{ fingerprint: string; keyType: string }>('POST', '/api/phone/probe', { target, port }, 20_000),
  phoneKey: () => request<{ publicKey: string }>('GET', '/api/phone/key'),
  pairLaptop: (link: string) => request<{ id: string }>('POST', '/api/phone/pair', { link }, 60_000),
  updateHost: (id: string, b: Record<string, unknown>) => request('PATCH', h(id), b),
  repair: (id: string) => request<{ id: string; token: string; command: string; commands?: { unix: string; windows: string } }>('POST', `${h(id)}/pair`, { origin: hubOrigin() }),
  pair: (name: string) => request<{ id: string; token: string; command: string; commands?: { unix: string; windows: string } }>('POST', '/api/hosts/pair', { name, origin: hubOrigin() }),
  removeHost: (id: string) => request('DELETE', h(id)),
  integration: (id: string, enable: boolean) => request('POST', `${h(id)}/integration`, { enable }),
  /** brings the machine's inyon up to date (it restarts and reconnects by itself) */
  nodeUpdate: (id: string) => request('POST', `${h(id)}/node/update`),
  launch: (id: string, b: { session?: string; name?: string; cwd?: string; agent: AgentKind | 'shell'; model?: string; mode?: string; prompt?: string }) =>
    request<{ pane: string }>('POST', `${h(id)}/launch`, b),
  send: (host: string, pane: string, text: string, requestId?: string) => request('POST', `${panePath(host, pane)}/send`, { text, requestId }, 310_000),
  /** a model, effort or goal change from the app's controls: sent like a message, never shown as one */
  setting: (host: string, pane: string, text: string) => request('POST', `${panePath(host, pane)}/send`, { text, setting: true }, 310_000),
  /** `question` is the promptKey of the question shown, so an answer that arrives late isn't taken for the next one */
  answer: (host: string, pane: string, option: number, text?: string, question?: string) =>
    request('POST', `${panePath(host, pane)}/answer`, { option, text, question }),
  interrupt: (host: string, pane: string) => request('POST', `${panePath(host, pane)}/interrupt`),
  rename: (host: string, pane: string, name: string) => request('PUT', `${panePath(host, pane)}/name`, { name }),
  reconnect: (host: string, pane: string) => request('POST', `${panePath(host, pane)}/reconnect`),
  restart: (host: string, pane: string) => request('POST', `${panePath(host, pane)}/restart`),
  exit: (host: string, pane: string) => request('POST', `${panePath(host, pane)}/exit`),
  /** the agent exits, then its tmux pane closes (and its window or session, if that was the last) */
  end: (host: string, pane: string) => request<{ closed: 'pane' | 'window' | 'session' }>('POST', `${panePath(host, pane)}/end`),
  keys: (host: string, pane: string, keys: string[]) => request('POST', `${panePath(host, pane)}/keys`, { keys }),
  rewind: (host: string, pane: string, text?: string) => request('POST', `${panePath(host, pane)}/rewind`, { text }, 60_000),
  mode: (host: string, pane: string, mode: string) => request('POST', `${panePath(host, pane)}/mode`, { mode }),
  rc: (host: string, pane: string, on: boolean) => request('POST', `${panePath(host, pane)}/rc`, { on }),
  input: (host: string, pane: string, text: string) => request('POST', `${panePath(host, pane)}/input`, { text }),
  stopTask: (host: string, task: { id: string; path?: string }) => request<{ stopped: boolean; detail: string }>('POST', `${h(host)}/tasks/stop`, { id: task.id, path: task.path }),
  start: (host: string, pane: string, agent: AgentKind, resume?: string) => request('POST', `${panePath(host, pane)}/start`, { agent, resume }),
  refresh: () => request<{ ok: true }>('POST', '/api/refresh', undefined, 15_000),
  commands: (host: string, pane: string) => request<SlashCommand[]>('GET', `${panePath(host, pane)}/commands`),
  models: (host: string, pane: string) => request<AgentCatalog>('GET', `${panePath(host, pane)}/models`, undefined, 25_000),
  files: (host: string, pane: string) => request<{ cwd: string; files: string[] }>('GET', `${panePath(host, pane)}/files`),
  signIn: (id: string, agent: AgentKind) => request<{ pane: string }>('POST', `${h(id)}/signin`, { agent }),
  signInScreen: (id: string, pane: string) => request<SignInScreen>('GET', `${h(id)}/signin/${paneSlug(pane)}`),
  signInSend: (id: string, pane: string, b: { text?: string; keys?: string[]; option?: number }) => request('POST', `${h(id)}/signin/${paneSlug(pane)}`, b),
  signInStop: (id: string, pane: string) => request('DELETE', `${h(id)}/signin/${paneSlug(pane)}`),
  setup: (id: string) => request<SetupReport>('GET', `${h(id)}/setup`),
  runSetup: (id: string, action: string) => request<{ ok: boolean; output?: string; pane?: string }>('POST', `${h(id)}/setup`, { action }),
  keepSession: (id: string, keepSession: boolean) => request('POST', `${h(id)}/setup`, { keepSession }),
  hubUpdate: (refresh = false) => request<HubUpdate>('GET', `/api/hub/update${refresh ? '?refresh=1' : ''}`, undefined, 60_000),
  startHubUpdate: () => request<{ started: boolean }>('POST', '/api/hub/update'),
  settings: () => request<HubSettings>('GET', '/api/settings'),
  push: (b: { subscription: PushSubscriptionJSON; vapid: { privateJwk: JsonWebKey; subject: string }; done: boolean }) => request('POST', '/api/push', b),
  unpush: (endpoint: string) => request('DELETE', '/api/push', { endpoint }),
  pushTest: (endpoint: string) => request<{ sent: number }>('POST', '/api/push/test', { endpoint }, 30_000),
  saveSettings: (s: Partial<HubSettings>) => request<HubSettings>('PUT', '/api/settings', s),
  uploadUsage: (id: string) => request<UploadUsage>('GET', `${h(id)}/uploads`),
  cleanUploads: (id: string, olderThanDays: number) => request<UploadUsage>('POST', `${h(id)}/uploads/clean`, { olderThanDays }),
  configs: (id: string) => request<ConfigFile[]>('GET', `${h(id)}/configs`),
  readConfig: (id: string, path: string) => request<{ path: string; content: string }>('GET', `${h(id)}/config${qs({ path })}`),
  writeConfig: (id: string, path: string, content: string) => request('PUT', `${h(id)}/config`, { path, content }),
  subagents: (id: string, transcript: string) =>
    request<{ agentId: string; toolUseId?: string; type?: string; description?: string; path: string }[]>('GET', `${h(id)}/subagents${qs({ transcript })}`),
  transcript: (id: string, path: string) => request<ChatItem[]>('GET', `${h(id)}/transcript${qs({ path })}`),
  taskOutput: (id: string, task: { id: string; path?: string }) => request<{ path: string; output: string }>('GET', `${h(id)}/task-output${qs({ path: task.path ?? '', id: task.id })}`),

  // ---- phones paired with this hub (the hub's web app shows the code; the app claims it) ----
  /** A one-time code for a phone to pair with this hub; needs a recent sign-in. */
  phonePair: (origin: string) => request<{ id: string; code: string; link: string; expiresAt: number }>('POST', '/api/phones/pair', { origin }),
  phones: () => request<{ id: string; name: string; pairedAt: number; lastSeen?: number; thisPhone?: boolean }[]>('GET', '/api/phones'),
  forgetPhone: (id: string) => request<unknown>('DELETE', `/api/phones/${encodeURIComponent(id)}`),

  /** Uploads with progress (fetch can't report upload progress). */
  upload(host: string, pane: string | undefined, file: File, onProgress?: (fraction: number) => void): Promise<Uploaded> {
    const form = new FormData()
    form.append('files', file, file.name)
    if (pane) form.append('pane', paneSlug(pane))
    // in the phone app the file goes over SSH from here, a piece at a time: a whole video at once
    // runs the app out of memory. A big file goes to the hub in pieces too, so it never holds it whole,
    // and so does any file for a paired hub's machine, since only a request through send() finds that hub.
    if (isPhone() || file.size > UPLOAD_PIECE || isHubHost(host)) return uploadInPieces(host, pane, file, onProgress)
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${h(host)}/uploads`)
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
      xhr.onload = () => {
        let data: any = {}
        try {
          data = JSON.parse(xhr.responseText)
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300 && data.files?.[0]) resolve(data.files[0])
        else reject(new ApiError(xhr.status, data.error ?? `Upload failed (${xhr.status})`))
      }
      xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'))
      xhr.send(form)
    })
  },
}

export const UPLOAD_PIECE = 2 * 1024 * 1024

/**
 * Runs `fn` again when the connection hiccups (a link dropping, a server busy): up to three more
 * tries, waiting longer each time. Refusals (bad input, too large, not allowed) fail at once.
 */
/** A dropped connection or a busy server, as opposed to a refusal that a retry won't change. */
export function isTransient(err: unknown) {
  // fetch throws a TypeError when the network is gone
  if (err instanceof TypeError) return true
  if (!(err instanceof ApiError)) return false
  return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500
}

export async function withRetries<T>(fn: () => Promise<T>, waits = [700, 2000, 5000]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (!isTransient(err) || i >= waits.length) throw err
      await new Promise((r) => setTimeout(r, waits[i]))
    }
  }
}

async function uploadInPieces(host: string, pane: string | undefined, file: File, onProgress?: (fraction: number) => void): Promise<Uploaded> {
  let saved: Uploaded | undefined
  for (let at = 0; at < file.size || at === 0; at += UPLOAD_PIECE) {
    const form = new FormData()
    form.append('files', new File([file.slice(at, at + UPLOAD_PIECE)], file.name, { type: file.type }), file.name)
    if (pane) form.append('pane', paneSlug(pane))
    form.append('total', String(file.size))
    form.append('offset', String(at))
    if (saved) form.append('path', saved.path)
    saved = await withRetries(async () => {
      const res = await send(new Request(new URL(`${h(host)}/uploads`, location.href), { method: 'POST', body: form }))
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.files?.[0]) throw new ApiError(res.status, data.error ?? `Upload failed (${res.status})`)
      return data.files[0] as Uploaded
    })
    onProgress?.(file.size ? Math.min(1, (at + UPLOAD_PIECE) / file.size) : 1)
  }
  return saved!
}
