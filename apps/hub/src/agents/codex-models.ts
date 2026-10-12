import { AGENTS, type AgentCatalog, type AgentModel } from '@inyon/protocol'
import type { Host } from '../hosts/host.ts'

/**
 * Codex caches the account's model list in ~/.codex/models_cache.json (what /model shows): the
 * "list" models, each with its reasoning levels and context window. Hidden ones stay hidden.
 */
export function parseCodexModels(json: string): AgentModel[] {
  const data = JSON.parse(json)
  const rows: any[] = Array.isArray(data?.models) ? data.models : []
  return rows
    .filter((m) => m?.slug && (m.visibility ?? 'list') === 'list')
    .map((m) => ({
      id: String(m.slug),
      label: String(m.display_name ?? m.slug),
      note: typeof m.description === 'string' ? m.description.replace(/\.$/, '') : undefined,
      context: typeof m.context_window === 'number' ? m.context_window : undefined,
      efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l: any) => String(l?.effort ?? l)).filter(Boolean) : undefined,
      defaultEffort: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : undefined,
    }))
}

const cache = new Map<string, { at: number; value: AgentCatalog }>()

export async function codexModels(host: Host): Promise<AgentCatalog> {
  const hit = cache.get(host.id)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  const fallback = (error?: string): AgentCatalog => ({ models: AGENTS.codex.models, source: 'fallback', updatedAt: 0, ...(error && { error }) })
  let value: AgentCatalog
  try {
    const r = await host.exec('cat "${CODEX_HOME:-$HOME/.codex}/models_cache.json" 2>/dev/null')
    const models = r.stdout.trim() ? parseCodexModels(r.stdout) : []
    value = models.length ? { models, source: 'cli', updatedAt: Date.now() } : fallback('Codex has not cached its model list yet')
  } catch (e) {
    value = fallback((e as Error).message)
  }
  cache.set(host.id, { at: Date.now(), value })
  return value
}
