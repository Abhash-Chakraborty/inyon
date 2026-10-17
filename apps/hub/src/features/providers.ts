import type { OpenCodeProvider, ProvidersReport } from '@inyon/protocol'
import { shq, type Host } from '../hosts/host.ts'
import { HttpError, registry } from '../hosts/registry.ts'
import { OC_PATH } from '../agents/opencode-db.ts'
import { forgetOpenCodeModels, noteProviderNames, providerName } from '../agents/opencode-models.ts'
import { OpenCodeClient, forgetOpenCodeCatalogs, opencodeRequest } from '../agents/opencode-api.ts'
import { parseEndpoint, viaOpenCodeApi } from '../agents/opencode.ts'

/**
 * OpenCode's model providers on a machine: which are connected, connecting one more, and
 * disconnecting. Connecting runs OpenCode's own `opencode auth login` on the machine (features/
 * signin.ts drives it from the app), so a key typed in the app goes to that command and nowhere
 * else; the hub never reads a credential back. Disconnecting is `opencode auth logout`.
 */

/** the order OpenCode's own picker opens with, before the rest alphabetically */
const POPULAR = ['opencode', 'openai', 'github-copilot', 'google', 'anthropic', 'openrouter', 'vercel']
const ID = /^[\w.-]{1,64}$/

interface Catalogue {
  providers: { id: string; name: string; env: string[] }[]
  connected: string[]
}

export interface AuthList {
  credentials: { name: string; type: string }[]
  env: { name: string; variable: string }[]
}

/**
 * `opencode auth list`: saved credentials ("●  DeepSeek api"), then providers reached through
 * environment variables ("●  Groq GROQ_API_KEY"). Names are OpenCode's display names.
 */
export function parseAuthList(text: string): AuthList {
  const out: AuthList = { credentials: [], env: [] }
  let section: 'credentials' | 'env' | undefined
  for (const raw of text.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const line = raw.trim()
    if (/^┌\s+Credentials\b/.test(line)) section = 'credentials'
    else if (/^┌\s+Environment\b/.test(line)) section = 'env'
    else if (/^└/.test(line)) section = undefined
    const m = section && line.match(/^[●◇◆■]\s+(.+?)\s+(\S+)$/)
    if (!m) continue
    if (section === 'credentials') out.credentials.push({ name: m[1], type: m[2] })
    else out.env.push({ name: m[1], variable: m[2] })
  }
  return out
}

/** Only ids, names, environment variables and the connected list are kept: a provider entry also carries its key. */
export function catalogueFrom(payload: any): Catalogue {
  const providers = (Array.isArray(payload?.all) ? payload.all : [])
    .filter((p: any) => typeof p?.id === 'string' && ID.test(p.id))
    .map((p: any) => ({ id: p.id, name: typeof p.name === 'string' && p.name ? p.name : providerName(p.id), env: Array.isArray(p.env) ? p.env.filter((e: unknown) => typeof e === 'string') : [] }))
  noteProviderNames(providers)
  return { providers, connected: Array.isArray(payload?.connected) ? payload.connected.filter((c: unknown) => typeof c === 'string') : [] }
}

/**
 * Starts OpenCode's server for a moment in an empty folder, reads its provider list and stops
 * it. About four seconds, so the answer is kept for ten minutes; a session's own server is
 * used instead when the machine has one.
 */
export const CATALOGUE_SH = `${OC_PATH}
d=$(mktemp -d) || exit 1
cd "$d" || exit 1
opencode serve --hostname 127.0.0.1 --port 0 >"$d/log" 2>&1 &
pid=$!
port=
for i in $(seq 1 120); do
  sleep 0.25
  port=$(grep -o 'http://127.0.0.1:[0-9]*' "$d/log" 2>/dev/null | head -1 | sed 's/.*://')
  [ -n "$port" ] && curl -s -m 1 "http://127.0.0.1:$port/global/health" 2>/dev/null | grep -q healthy && break
  port=
done
[ -n "$port" ] && curl -s -m 30 "http://127.0.0.1:$port/provider"
kill "$pid" 2>/dev/null; sleep 0.3; kill -9 "$pid" 2>/dev/null
cd / && rm -rf "$d"`

const catalogues = new Map<string, { at: number; value: Promise<Catalogue> }>()

function catalogue(host: Host, uri?: string, cwd?: string): Promise<Catalogue> {
  const hit = catalogues.get(host.id)
  if (hit && Date.now() - hit.at < 600_000) return hit.value
  const value = (async () => {
    const ep = uri ? parseEndpoint(uri) : undefined
    if (ep) {
      const live = await opencodeRequest(host, `${ep.base}/provider${cwd ? `?directory=${encodeURIComponent(cwd)}` : ''}`).catch(() => undefined)
      if (live) return catalogueFrom(live)
    }
    const r = await host.exec(CATALOGUE_SH, { timeoutMs: 90_000 })
    let payload: any
    try {
      payload = JSON.parse(r.stdout.trim())
    } catch {
      throw new HttpError(503, "OpenCode's provider list couldn't be read on that machine. Is OpenCode installed there?")
    }
    return catalogueFrom(payload)
  })()
  catalogues.set(host.id, { at: Date.now(), value })
  value.catch(() => catalogues.delete(host.id))
  return value
}

async function authList(host: Host): Promise<AuthList> {
  const r = await host.exec(`${OC_PATH}; opencode auth list 2>/dev/null`, { timeoutMs: 30_000 })
  return parseAuthList(r.stdout)
}

/** A provider's id from the name `auth list` prints, through the catalogue. */
const idFor = (cat: Catalogue, name: string) => cat.providers.find((p) => p.name === name)?.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function mergeProviders(cat: Catalogue, auth: AuthList): OpenCodeProvider[] {
  const byId = new Map<string, OpenCodeProvider>()
  for (const p of cat.providers) byId.set(p.id, { id: p.id, name: p.name, connected: false, env: p.env.length ? p.env : undefined })
  for (const c of auth.credentials) {
    const id = idFor(cat, c.name)
    const p = byId.get(id) ?? { id, name: c.name, connected: false }
    byId.set(id, { ...p, connected: true, via: 'credential', type: c.type })
  }
  for (const e of auth.env) {
    const id = idFor(cat, e.name)
    const p = byId.get(id)
    if (p?.connected) continue
    byId.set(id, { ...(p ?? { id, name: e.name, connected: false }), connected: true, via: 'env', env: [e.variable] })
  }
  // connected without a saved credential: OpenCode's own free models, or a key in its config file
  for (const id of cat.connected) {
    const p = byId.get(id)
    if (p && !p.connected) byId.set(id, { ...p, connected: true })
  }
  const rank = (p: OpenCodeProvider) => (p.connected ? 0 : POPULAR.includes(p.id) ? 1 : 2)
  return [...byId.values()].sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? POPULAR.indexOf(a.id) - POPULAR.indexOf(b.id) : a.name.localeCompare(b.name)))
}

/** The pane's own OpenCode server, when it runs one. */
function apiPane(hostId: string, paneId?: string) {
  const pane = paneId ? registry.findPane(hostId, paneId)?.pane : undefined
  const uri = pane?.agent?.kind === 'opencode' && viaOpenCodeApi(pane.agent.transcriptPath) ? pane.agent.transcriptPath : undefined
  return { uri, cwd: pane?.cwd }
}

export async function listProviders(hostId: string, paneId?: string): Promise<ProvidersReport> {
  const host = registry.host(hostId)
  const { uri, cwd } = apiPane(hostId, paneId)
  try {
    const [cat, auth] = await Promise.all([catalogue(host, uri, cwd), authList(host)])
    return { providers: mergeProviders(cat, auth), updatedAt: Date.now() }
  } catch (e) {
    return { providers: [], updatedAt: Date.now(), error: (e as Error).message }
  }
}

/** Runs `opencode auth login -p <provider>` on the machine, out of sight; the sign-in sheet drives it. */
export async function connectProvider(hostId: string, provider: string) {
  if (!ID.test(provider)) throw new HttpError(400, 'Unknown provider')
  const { startSignIn } = await import('./signin.ts')
  return startSignIn(hostId, 'opencode', { provider })
}

/** `opencode auth logout <provider>`; a provider connected through the environment can't be, and says so. */
export async function disconnectProvider(hostId: string, provider: string) {
  if (!ID.test(provider)) throw new HttpError(400, 'Unknown provider')
  const host = registry.host(hostId)
  const r = await host.exec(`${OC_PATH}; opencode auth logout ${shq(provider)} 2>&1`, { timeoutMs: 30_000 })
  const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, '')
  if (!/Logout successful/.test(out)) {
    const auth = await authList(host).catch(() => undefined)
    const env = auth?.env.find((e) => e.name.toLowerCase() === provider.toLowerCase() || idFor({ providers: [], connected: [] }, e.name) === provider)
    if (env) throw new HttpError(409, `${env.name} is connected through ${env.variable} in the machine's environment. Unset it there to disconnect.`)
    throw new HttpError(409, /No credentials found/.test(out) ? 'That provider has no saved credential to remove' : out.trim().split('\n').pop() || 'OpenCode did not log out')
  }
  await afterCredentialChange(hostId)
}

/**
 * A credential was added or removed on the machine: Inyon's lists are read again, and sessions
 * Inyon started (the ones with their own server) are told to reload theirs. A running plain
 * `opencode` reads credentials when it starts, so it sees the change after a restart.
 */
export async function afterCredentialChange(hostId: string) {
  catalogues.delete(hostId)
  forgetOpenCodeModels(hostId)
  forgetOpenCodeCatalogs()
  const rt = registry.get(hostId)
  if (rt) {
    const panes = rt.state.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes))
    const seen = new Set<string>()
    await Promise.all(panes.map(async (p) => {
      const a = p.agent
      if (a?.kind !== 'opencode' || !viaOpenCodeApi(a.transcriptPath) || a.state === 'working') return
      const base = parseEndpoint(a.transcriptPath!)?.base
      if (!base || seen.has(`${base} ${p.cwd}`)) return
      seen.add(`${base} ${p.cwd}`)
      await new OpenCodeClient(rt.host, a.transcriptPath!, p.cwd).dispose().catch(() => {})
    }))
  }
  registry.refresh(hostId, 200)
}
