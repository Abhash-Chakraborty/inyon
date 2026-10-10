import type { AgentCatalog, AgentKind, ChatItem, SlashCommand } from '@tether/protocol'
import { hubOrigin } from './hub.ts'
import { isPhone, phone } from './phone.ts'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** The hub over HTTP in a browser; the core running inside the phone app. */
async function send(req: Request): Promise<Response> {
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
    if (res.status === 401 && !url.endsWith('/login')) window.dispatchEvent(new Event('tether:signed-out'))
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
  hostKey: string
  auth: 'phone-key' | 'password' | 'key'
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface HubSettings {
  uploads: { retentionDays: number; maxMB: number; longPasteLines: number }
  autoResume?: boolean
}

export const api = {
  session: () => request<{ authed: boolean; setup?: boolean; setupCode?: boolean }>('GET', '/api/session'),
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
  updateHost: (id: string, b: Record<string, unknown>) => request('PATCH', h(id), b),
  repair: (id: string) => request<{ id: string; token: string; command: string; commands?: { unix: string; windows: string } }>('POST', `${h(id)}/pair`, { origin: hubOrigin() }),
  pair: (name: string) => request<{ id: string; token: string; command: string; commands?: { unix: string; windows: string } }>('POST', '/api/hosts/pair', { name, origin: hubOrigin() }),
  removeHost: (id: string) => request('DELETE', h(id)),
  integration: (id: string, enable: boolean) => request('POST', `${h(id)}/integration`, { enable }),
  launch: (id: string, b: { session?: string; name?: string; cwd?: string; agent: AgentKind | 'shell'; model?: string; mode?: string; prompt?: string }) =>
    request<{ pane: string }>('POST', `${h(id)}/launch`, b),
  send: (host: string, pane: string, text: string, requestId?: string) => request('POST', `${panePath(host, pane)}/send`, { text, requestId }, 310_000),
  answer: (host: string, pane: string, option: number, text?: string) => request('POST', `${panePath(host, pane)}/answer`, { option, text }),
  interrupt: (host: string, pane: string) => request('POST', `${panePath(host, pane)}/interrupt`),
  rename: (host: string, pane: string, name: string) => request('PUT', `${panePath(host, pane)}/name`, { name }),
  reconnect: (host: string, pane: string) => request('POST', `${panePath(host, pane)}/reconnect`),
  restart: (host: string, pane: string) => request('POST', `${panePath(host, pane)}/restart`),
  exit: (host: string, pane: string) => request('POST', `${panePath(host, pane)}/exit`),
  keys: (host: string, pane: string, keys: string[]) => request('POST', `${panePath(host, pane)}/keys`, { keys }),
  rewind: (host: string, pane: string, text?: string) => request('POST', `${panePath(host, pane)}/rewind`, { text }, 60_000),
  mode: (host: string, pane: string, mode: string) => request('POST', `${panePath(host, pane)}/mode`, { mode }),
  rc: (host: string, pane: string, on: boolean) => request('POST', `${panePath(host, pane)}/rc`, { on }),
  input: (host: string, pane: string, text: string) => request('POST', `${panePath(host, pane)}/input`, { text }),
  stopTask: (host: string, task: { id: string; path?: string }) => request<{ stopped: boolean; detail: string }>('POST', `${h(host)}/tasks/stop`, { id: task.id, path: task.path }),
  start: (host: string, pane: string, agent: AgentKind, resume?: string) => request('POST', `${panePath(host, pane)}/start`, { agent, resume }),
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
  settings: () => request<HubSettings>('GET', '/api/settings'),
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

  /** Uploads with progress (fetch can't report upload progress). */
  upload(host: string, pane: string | undefined, file: File, onProgress?: (fraction: number) => void): Promise<Uploaded> {
    const form = new FormData()
    form.append('files', file, file.name)
    if (pane) form.append('pane', paneSlug(pane))
    // in the phone app the file goes over SSH from here; the core reports when it's all there
    if (isPhone()) {
      return send(new Request(new URL(`${h(host)}/uploads`, location.href), { method: 'POST', body: form })).then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.files?.[0]) throw new ApiError(res.status, data.error ?? `Upload failed (${res.status})`)
        onProgress?.(1)
        return data.files[0] as Uploaded
      })
    }
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
