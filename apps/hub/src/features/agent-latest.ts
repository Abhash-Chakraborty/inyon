import { AGENTS, AGENT_KINDS, type AgentKind } from '@inyon/protocol'

/**
 * The newest published version of each agent, from its npm package's `latest` tag. Asked at most
 * once an hour per package, with a short timeout, and a failed lookup is remembered for a few
 * minutes so a machine's Setup tab never waits on a registry that's down. Nothing about the user
 * or the machine goes out: the request is the package name alone.
 */

const REGISTRY = 'https://registry.npmjs.org'
const TTL = 60 * 60_000
const FAIL_TTL = 5 * 60_000
const TIMEOUT = 4000

interface Entry {
  version?: string
  at: number
}

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<string | undefined>>()

/** The digits of a version: "v2.1.296 (Claude Code)" and "codex-cli 0.49.0" both parse. */
export function parseVersion(s: string | undefined): number[] | undefined {
  const m = String(s ?? '').replace(/^\s*v/i, '').match(/\d+(?:\.\d+)+/)
  return m ? m[0].split('.').map(Number) : undefined
}

/** -1 when a is older than b, 1 when newer, 0 when equal or when either can't be read. */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

/** The package's latest version, or undefined when the registry can't say right now. */
export function latestNpmVersion(pkg: string, get: typeof fetch = fetch, now = Date.now): Promise<string | undefined> {
  const hit = cache.get(pkg)
  if (hit && now() - hit.at < (hit.version ? TTL : FAIL_TTL)) return Promise.resolve(hit.version)
  const pending = inflight.get(pkg)
  if (pending) return pending
  const p = (async () => {
    let version: string | undefined
    try {
      const res = await get(`${REGISTRY}/${pkg}/latest`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) })
      const body = res.ok ? ((await res.json().catch(() => undefined)) as { version?: unknown } | undefined) : undefined
      if (typeof body?.version === 'string' && parseVersion(body.version)) version = body.version.trim()
    } catch {
      // unreachable, slow or not JSON: the agent simply has no "latest" until the next try
    }
    cache.set(pkg, { version, at: now() })
    inflight.delete(pkg)
    return version
  })()
  inflight.set(pkg, p)
  return p
}

/** The latest version of every agent with a package, looked up in parallel. Never throws. */
export async function latestAgentVersions(get: typeof fetch = fetch): Promise<Partial<Record<AgentKind, string>>> {
  const out: Partial<Record<AgentKind, string>> = {}
  await Promise.all(
    AGENT_KINDS.map(async (k) => {
      const pkg = AGENTS[k].latest?.npm
      if (!pkg) return
      const v = await latestNpmVersion(pkg, get)
      if (v) out[k] = v
    }),
  )
  return out
}

/** For tests. */
export function forgetLatest() {
  cache.clear()
  inflight.clear()
}
