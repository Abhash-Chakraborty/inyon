import type { AgentCatalog, AgentModel } from '@inyon/protocol'
import { Host, shq } from '../hosts/host.ts'
import { parseEndpoint } from './opencode.ts'
import { noteProviderNames } from './opencode-models.ts'

/** The CLI owns execution/auth; this adapter speaks its documented local server API.
 * https://opencode.ai/docs/server/ and packages/sdk/js/src/v2/gen/types.gen.ts
 */
export class OpenCodeApiError extends Error {
  constructor(public status: number, public path: string) {
    // Do not reflect server response bodies: auth/config endpoints can contain credentials.
    super(status ? `OpenCode ${path} returned HTTP ${status}` : `Could not reach OpenCode ${path}`)
  }
}

export async function opencodeRequest(host: Host, url: string, method = 'GET', body?: unknown, timeoutSeconds = 12): Promise<any> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username || parsed.password) {
    throw new Error('OpenCode API must use its local loopback server')
  }
  const r = await host.exec(`curl -sS --max-time ${timeoutSeconds} -X ${shq(method)} -H 'content-type: application/json' ${body === undefined ? '' : '--data-binary @- '}--write-out '\\n%{http_code}' ${shq(url)}`, {
    input: body === undefined ? undefined : JSON.stringify(body), timeoutMs: (timeoutSeconds + 2) * 1000,
  })
  const split = r.stdout.lastIndexOf('\n')
  const status = Number(r.stdout.slice(split + 1))
  if (r.code !== 0 || !status || status < 200 || status >= 300) throw new OpenCodeApiError(r.code ? 0 : status, parsed.pathname)
  const text = r.stdout.slice(0, split)
  if (!text.trim()) return undefined
  try { return JSON.parse(text) } catch { throw new Error(`OpenCode ${parsed.pathname} returned invalid JSON`) }
}

/** What a prompt runs with, as the TUI's footer shows it: "provider/model", the variant, the agent. */
export type OpenCodeSelection = { model?: string; variant?: string; agent?: string }
export type OpenCodePermission = { permission: string; pattern: string; action: 'allow' | 'deny' | 'ask' }
export function openCodeModel(id: string) {
  const slash = id.indexOf('/')
  if (slash < 1 || slash === id.length - 1) throw new Error('Choose an OpenCode provider/model')
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
}

export class OpenCodeClient {
  readonly base: string
  readonly session: string
  constructor(readonly host: Host, uri: string, readonly directory?: string) {
    const ep = parseEndpoint(uri)
    if (!ep) throw new Error('Invalid OpenCode endpoint')
    this.base = ep.base
    this.session = ep.session
  }
  request(path: string, method = 'GET', body?: unknown, timeoutSeconds?: number) {
    const query = this.directory ? `?directory=${encodeURIComponent(this.directory)}` : ''
    return opencodeRequest(this.host, `${this.base}${path}${query}`, method, body, timeoutSeconds)
  }
  private sessionPath(suffix = '') {
    if (!this.session) throw new Error('OpenCode has no selected session')
    return `/session/${encodeURIComponent(this.session)}${suffix}`
  }
  prompt(text: string, selection: OpenCodeSelection = {}, files: { type: 'file'; mime: string; url: string; filename?: string }[] = []) {
    const { model, ...rest } = selection
    return this.request(this.sessionPath('/prompt_async'), 'POST', { ...rest, ...(model ? { model: openCodeModel(model) } : {}), parts: [{ type: 'text', text }, ...files] })
  }
  // Shell/command responses complete only when execution finishes; callers must not blindly retry a timeout.
  shell(command: string, agent: string, model?: string) {
    if (!command.trim() || !agent) throw new Error('A shell command and OpenCode agent are required')
    return this.request(this.sessionPath('/shell'), 'POST', { command, agent, ...(model ? { model: openCodeModel(model) } : {}) }, 300)
  }
  command(command: string, args: string, selection: OpenCodeSelection = {}) {
    return this.request(this.sessionPath('/command'), 'POST', { ...selection, command: command.replace(/^\//, ''), arguments: args }, 300)
  }
  abort() { return this.request(this.sessionPath('/abort'), 'POST') }
  status() { return this.request('/session/status') }
  /** the conversation itself: title, agent and model last used, tokens, cost, share link, what /undo reverted */
  info() { return this.request(this.sessionPath()) }
  messages() { return this.request(this.sessionPath('/message')) }
  /** /undo: back to before `messageID` (its files too); /redo puts it back */
  revert(messageID: string) { return this.request(this.sessionPath('/revert'), 'POST', { messageID }, 60) }
  unrevert() { return this.request(this.sessionPath('/unrevert'), 'POST', undefined, 60) }
  share() { return this.request(this.sessionPath('/share'), 'POST', undefined, 60) }
  unshare() { return this.request(this.sessionPath('/share'), 'DELETE', undefined, 60) }
  summarize(model: string) { return this.request(this.sessionPath('/summarize'), 'POST', openCodeModel(model), 300) }
  permissions() { return this.request('/permission') }
  reply(id: string, reply: 'once' | 'always' | 'reject') { return this.request(`/permission/${encodeURIComponent(id)}/reply`, 'POST', { reply }) }
  setPermissions(permission: OpenCodePermission[]) { return this.request(this.sessionPath(), 'PATCH', { permission }) }
  /** questions the agent asked (its question tool), one request per tool call */
  questions() { return this.request('/question') }
  /** one array of chosen labels (or a typed answer) per question, in order */
  replyQuestion(id: string, answers: string[][]) { return this.request(`/question/${encodeURIComponent(id)}/reply`, 'POST', { answers }) }
  rejectQuestion(id: string) { return this.request(`/question/${encodeURIComponent(id)}/reject`, 'POST') }
  /** shows a session in the terminal, after one was created here */
  selectSession(sessionID: string) { return this.request('/tui/select-session', 'POST', { sessionID }) }
  /** drops the server's cached state for the folder (providers, credentials): read again on the next request; the terminal carries on */
  dispose() { return this.request('/instance/dispose', 'POST') }
}

/** Never return raw provider objects: they include provider.key/options/headers. */
export function openCodeCatalogFromProviders(payload: any): AgentCatalog {
  const connected = new Set<string>(Array.isArray(payload?.connected) ? payload.connected : [])
  const models: AgentModel[] = []
  const all = Array.isArray(payload?.all) ? payload.all : []
  noteProviderNames(all.filter((p: any) => typeof p?.id === 'string' && typeof p?.name === 'string'))
  for (const provider of all) {
    if (typeof provider.id !== 'string' || !connected.has(provider.id)) continue
    for (const [key, value] of Object.entries(provider.models ?? {})) {
      const model = value as any
      if (!model || model.status === 'deprecated') continue
      const id = typeof model.id === 'string' ? model.id : key
      models.push({ id: `${provider.id}/${id}`, label: `${provider.name ?? provider.id} · ${model.name ?? id}`,
        context: typeof model.limit?.context === 'number' ? model.limit.context : undefined,
        efforts: Object.entries(model.variants ?? {}).filter(([, config]) => !(config as any)?.disabled).map(([name]) => name),
      })
    }
  }
  return { models, source: 'cli', updatedAt: Date.now() }
}

/** The agents a session can switch to: the primary ones, custom ones included; never the hidden internal ones. */
export function openCodeAgentsFrom(payload: any): { id: string; label: string }[] {
  return (Array.isArray(payload) ? payload : [])
    .filter((a: any) => typeof a?.name === 'string' && !a.hidden && a.mode !== 'subagent')
    .map((a: any) => ({ id: a.name, label: a.name.charAt(0).toUpperCase() + a.name.slice(1) }))
}

/** The models of every connected provider, and the agents, from a session's own server. */
export async function opencodeCatalog(host: Host, uri: string, directory?: string): Promise<AgentCatalog> {
  const client = new OpenCodeClient(host, uri, directory)
  const [providers, agents] = await Promise.all([client.request('/provider'), client.request('/agent').catch(() => [])])
  const modes = openCodeAgentsFrom(agents)
  const catalog = { ...openCodeCatalogFromProviders(providers), ...(modes.length ? { modes } : {}) }
  recent.set(client.base, { at: Date.now(), catalog })
  return catalog
}

const recent = new Map<string, { at: number; catalog: AgentCatalog }>()

/** The same, kept for a minute: the footer is matched against it on every screen read. */
export async function opencodeCatalogCached(host: Host, uri: string, directory?: string): Promise<AgentCatalog> {
  const ep = parseEndpoint(uri)
  const hit = ep && recent.get(ep.base)
  if (hit && Date.now() - hit.at < 60_000) return hit.catalog
  return opencodeCatalog(host, uri, directory)
}

/** After a provider was connected or disconnected on the machine: ask again next time. */
export function forgetOpenCodeCatalogs() {
  recent.clear()
}
