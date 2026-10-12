import type { AgentCatalog, AgentModel } from '@inyon/protocol'
import { Host, shq } from '../hosts/host.ts'
import { parseEndpoint } from './opencode.ts'

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

export type OpenCodeSelection = { model?: string; variant?: string; agent?: string; messageID?: string }
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
  permissions() { return this.request('/permission') }
  reply(id: string, reply: 'once' | 'always' | 'reject') { return this.request(`/permission/${encodeURIComponent(id)}/reply`, 'POST', { reply }) }
  setPermissions(permission: OpenCodePermission[]) { return this.request(this.sessionPath(), 'PATCH', { permission }) }
  authorize(provider: string, method: number, inputs?: Record<string, string>) {
    return this.request(`/provider/${encodeURIComponent(provider)}/oauth/authorize`, 'POST', { method, inputs })
  }
  oauthCallback(provider: string, method: number, code?: string) {
    return this.request(`/provider/${encodeURIComponent(provider)}/oauth/callback`, 'POST', { method, code }, 120)
  }
  setApiKey(provider: string, key: string) {
    if (!key.trim()) throw new Error('API key is required')
    return this.request(`/auth/${encodeURIComponent(provider)}`, 'PUT', { type: 'api', key })
  }
}

/** Never return raw provider objects: they include provider.key/options/headers. */
export function openCodeCatalogFromProviders(payload: any): AgentCatalog {
  const connected = new Set<string>(Array.isArray(payload?.connected) ? payload.connected : [])
  const models: AgentModel[] = []
  for (const provider of Array.isArray(payload?.all) ? payload.all : []) {
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
export async function opencodeCatalog(host: Host, uri: string, directory?: string): Promise<AgentCatalog> {
  return openCodeCatalogFromProviders(await new OpenCodeClient(host, uri, directory).request('/provider'))
}
export async function opencodeCapabilities(host: Host, uri: string, directory?: string) {
  const client = new OpenCodeClient(host, uri, directory)
  const [providers, auth, agents, commands] = await Promise.all([client.request('/provider'), client.request('/provider/auth'), client.request('/agent'), client.request('/command')])
  return {
    catalog: openCodeCatalogFromProviders(providers),
    providers: (providers.all ?? []).map((p: any) => ({ id: p.id, name: p.name, connected: (providers.connected ?? []).includes(p.id) })),
    authMethods: auth,
    agents: (Array.isArray(agents) ? agents : []).filter((a: any) => !a.hidden && a.mode !== 'subagent').map((a: any) => ({ id: a.name, label: a.name, description: a.description, permission: a.permission })),
    commands: (Array.isArray(commands) ? commands : []).map((c: any) => ({ name: `/${c.name}`, description: c.description ?? '', source: c.source === 'mcp' ? 'plugin' : 'project' })),
    supportsGoal: false,
  }
}
