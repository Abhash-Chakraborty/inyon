import type { AgentCatalog, AgentModel } from '@tether/protocol'
import type { Host } from '../hosts/host.ts'
import { OC_PATH } from './opencode-db.ts'

/** Provider names as OpenCode's footer prints them after the model ("Big Pickle OpenCode Zen"). */
const PROVIDER_NAMES: Record<string, string> = {
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'github-copilot': 'GitHub Copilot',
  google: 'Google',
  'google-vertex': 'Google Vertex',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  'amazon-bedrock': 'Amazon Bedrock',
  azure: 'Azure',
  ollama: 'Ollama',
}
export const providerName = (id: string) => PROVIDER_NAMES[id] ?? id.replace(/(^|-)(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase())

/**
 * `opencode models --verbose` prints "provider/model" and then the model as pretty JSON, for every
 * provider that's connected. That JSON also carries request headers and provider options, which
 * can hold keys, so only the id, name, context size and variant names are kept.
 */
export function parseOpenCodeModels(text: string): AgentModel[] {
  const out: AgentModel[] = []
  const parts = text.split(/^([A-Za-z0-9._-]+\/\S+)[ \t]*$/m)
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i]
    let m: any
    try {
      m = JSON.parse(parts[i + 1])
    } catch {
      continue
    }
    if (!m || m.status === 'deprecated') continue
    const provider = id.slice(0, id.indexOf('/'))
    const name = typeof m.name === 'string' && m.name ? m.name : id.slice(provider.length + 1)
    out.push({
      id,
      label: `${providerName(provider)} · ${name}`,
      context: typeof m.limit?.context === 'number' ? m.limit.context : undefined,
      efforts: Object.entries(m.variants ?? {}).filter(([, v]) => !(v as any)?.disabled).map(([k]) => k),
    })
  }
  return out
}

const cache = new Map<string, { at: number; value: Promise<AgentCatalog> }>()
const settled = new Map<string, AgentCatalog>()

/** The models OpenCode offers on this machine (about 3 s to ask, so kept for 10 minutes). */
export function opencodeCliModels(host: Pick<Host, 'id' | 'exec'>): Promise<AgentCatalog> {
  const hit = cache.get(host.id)
  if (hit && Date.now() - hit.at < 600_000) return hit.value
  const value = (async (): Promise<AgentCatalog> => {
    try {
      const r = await host.exec(`${OC_PATH}; opencode models --verbose 2>/dev/null`, { timeoutMs: 30_000 })
      const models = parseOpenCodeModels(r.stdout)
      if (!models.length) {
        cache.delete(host.id)
        return { models: [], source: 'cli', updatedAt: Date.now(), error: 'OpenCode listed no models. Connect a provider with /connect in the terminal.' }
      }
      const catalog: AgentCatalog = { models, source: 'cli', updatedAt: Date.now() }
      settled.set(host.id, catalog)
      return catalog
    } catch (e) {
      cache.delete(host.id)
      return { models: [], source: 'cli', updatedAt: Date.now(), error: (e as Error).message }
    }
  })()
  cache.set(host.id, { at: Date.now(), value })
  return value
}

/** The last catalog fetched for a machine, without waiting. */
export const peekOpenCodeModels = (hostId: string) => settled.get(hostId)

/** The footer's "Model Name Provider Name" without a known provider's name. */
export const withoutProvider = (footer: string) => {
  for (const name of Object.values(PROVIDER_NAMES)) if (footer.endsWith(` ${name}`)) return footer.slice(0, -name.length - 1)
  return footer
}

/** Matches the footer's "Model Name Provider Name" to a catalog entry. */
export function modelFromFooter(models: AgentModel[], footer: string): AgentModel | undefined {
  const text = footer.trim().toLowerCase()
  const name = (m: AgentModel) => m.label.split(' · ').pop()!.toLowerCase()
  const provider = (m: AgentModel) => m.label.split(' · ')[0].toLowerCase()
  return (
    models.find((m) => text === `${name(m)} ${provider(m)}`) ??
    models.filter((m) => text === name(m) || text.startsWith(name(m) + ' ')).sort((a, b) => name(b).length - name(a).length)[0]
  )
}
