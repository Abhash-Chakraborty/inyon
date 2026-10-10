import { AGENTS, type AgentCatalog, type AgentModel } from '@tether/protocol'
import type { Host } from '../hosts/host.ts'

/** `agy models` queries the signed-in CLI's catalog and prints id<TAB>display name. */
export function parseAgyModels(output: string): AgentModel[] {
  const families = new Map<string, AgentModel>()
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const row = line.match(/^([\w.-]+)\t(.+)$/)
    if (!row) continue
    const [, variant, display] = row
    const suffix = variant.match(/-(low|medium|high|xhigh|max|ultra)$/)
    const effort = suffix?.[1]
    // A fixed-medium model is still selectable by its full id.
    const id = effort && /^gemini-/.test(variant) ? variant.slice(0, -effort.length - 1) : variant
    const known = AGENTS.antigravity.models.find((m) => m.id === id)
    let model = families.get(id)
    if (!model) {
      model = { id, label: display.replace(/\s*\((low|medium|high|xhigh|max|ultra)\)$/i, '').trim(), context: known?.context, efforts: [], variants: {} }
      families.set(id, model)
    }
    if (effort && /^gemini-/.test(variant)) {
      if (!model.efforts!.includes(effort)) model.efforts!.push(effort)
      model.variants![effort] = variant
    }
  }
  const order = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  return [...families.values()].map((model) => ({ ...model, efforts: model.efforts!.sort((a, b) => order.indexOf(a) - order.indexOf(b)) }))
}

const cache = new Map<string, { at: number; value?: AgentCatalog; pending?: Promise<AgentCatalog> }>()

export async function agyModels(host: Pick<Host, 'id' | 'exec'>): Promise<AgentCatalog> {
  const now = Date.now()
  const previous = cache.get(host.id)
  if (previous?.pending) return previous.pending
  if (previous?.value && now - previous.at < 60_000) return previous.value
  const entry: { at: number; value?: AgentCatalog; pending?: Promise<AgentCatalog> } = { at: now }
  cache.set(host.id, entry)
  entry.pending = (async () => {
    try {
      const result = await host.exec('if command -v agy >/dev/null 2>&1; then agy models; else "$HOME/.local/bin/agy" models; fi', { timeoutMs: 20_000 })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'Antigravity model discovery failed')
      const models = parseAgyModels(result.stdout)
      if (!models.length) throw new Error('Antigravity returned no model catalog')
      return { models, source: 'cli' as const, updatedAt: Date.now() }
    } catch (error) {
      return { models: previous?.value?.models ?? AGENTS.antigravity.models.map((model) => ({ ...model, efforts: [] })), source: 'fallback' as const, updatedAt: previous?.value?.updatedAt ?? 0, error: (error as Error).message }
    }
  })()
  entry.value = await entry.pending
  entry.pending = undefined
  return entry.value
}
