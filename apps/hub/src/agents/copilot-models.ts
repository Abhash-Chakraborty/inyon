import type { AgentCatalog, AgentModel } from '@tether/protocol'
import { shq, type Host } from '../hosts/host.ts'
import { copilotCatalogScript } from './copilot-rpc-sh.ts'
import { PATHS } from '../features/setup.ts'

export function parseCopilotModels(payload: unknown): AgentModel[] {
  const rows = Array.isArray(payload) ? payload : (payload as any)?.models
  if (!Array.isArray(rows)) throw new Error('Invalid Copilot model catalog')
  const models: AgentModel[] = [{ id: 'auto', label: 'Auto', note: 'Copilot chooses an available model for each task', efforts: [] }]
  for (const m of rows) {
    if (!m || typeof m.id !== 'string' || m.id === 'auto' || m.policy?.state === 'disabled' || m.model_picker_enabled === false) continue
    models.push({ id: m.id, label: m.name || m.id, context: m.capabilities?.limits?.max_context_window_tokens || undefined, efforts: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.filter((e: unknown) => typeof e === 'string') : [] })
  }
  return models
}

// Read-only official SDK transport. This starts no conversation and submits no inference.
// The helper runs on the selected host so its own CLI credentials remain on that host.

const cache = new Map<string, { at: number; value: Promise<AgentCatalog> }>()
export async function copilotModels(host: Pick<Host, 'id' | 'exec'>): Promise<AgentCatalog> {
  const old = cache.get(host.id)
  if (old && Date.now() - old.at < 60_000) return old.value
  const value = (async (): Promise<AgentCatalog> => {
    try {
      // node and copilot are often only on PATH in a login shell (nvm, ~/.local/bin)
      const result = await host.exec(`${PATHS}; node -e ${shq(copilotCatalogScript)}`, { timeoutMs: 22_000 })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'Copilot catalog unavailable')
      return { models: parseCopilotModels(JSON.parse(result.stdout)), source: 'cli', updatedAt: Date.now() }
    } catch (error) {
      return { models: parseCopilotModels([]), source: 'fallback', updatedAt: 0, error: (error as Error).message }
    }
  })()
  cache.set(host.id, { at: Date.now(), value })
  return value
}
