import type { AgentCatalog, AgentModel } from '@inyon/protocol'
import type { Host } from '../hosts/host.ts'
import { OC_PATH } from './opencode-db.ts'

/**
 * Provider names as OpenCode's footer prints them after the model ("Big Pickle OpenCode"), for
 * the providers people connect most. A machine's own list (from `opencode auth login`'s catalogue
 * or a session's API) adds the rest as it's seen.
 */
const PROVIDER_NAMES: Record<string, string> = {
  opencode: 'OpenCode',
  'opencode-go': 'OpenCode Go',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'github-copilot': 'GitHub Copilot',
  google: 'Google',
  'google-vertex': 'Vertex',
  openrouter: 'OpenRouter',
  vercel: 'Vercel AI Gateway',
  xai: 'xAI',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  'amazon-bedrock': 'Amazon Bedrock',
  azure: 'Azure',
  'ollama-cloud': 'Ollama Cloud',
  lmstudio: 'LMStudio',
  zai: 'Z.AI',
  'zai-coding-plan': 'Z.AI Coding Plan',
  moonshotai: 'Moonshot AI',
  'kimi-code-plan-global': 'Kimi For Coding (kimi.ai)',
  minimax: 'MiniMax (minimax.io)',
  cerebras: 'Cerebras',
  togetherai: 'Together AI',
  'fireworks-ai': 'Fireworks AI',
  huggingface: 'Hugging Face',
  llama: 'Llama',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  nvidia: 'Nvidia',
  poe: 'Poe',
  gitlab: 'GitLab Duo',
  digitalocean: 'DigitalOcean',
}
/** names older OpenCode versions printed, kept so their footers still read */
const OLD_NAMES = ['OpenCode Zen']
const learned = new Map<string, string>()

/** Remembers provider names a machine reported, so footers naming them read right. */
export function noteProviderNames(names: Iterable<{ id: string; name: string }>) {
  for (const { id, name } of names) if (id && name) learned.set(id, name)
}
export const providerName = (id: string) => learned.get(id) ?? PROVIDER_NAMES[id] ?? id.replace(/(^|-)(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase())
const allNames = () => [...new Set([...learned.values(), ...Object.values(PROVIDER_NAMES), ...OLD_NAMES])].sort((a, b) => b.length - a.length)

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

/** agents OpenCode runs for itself, which its TUI never offers */
const INTERNAL_AGENTS = new Set(['compaction', 'summary', 'title'])

/** The agents `opencode agent list` prints ("build (primary)", then each one's permissions): the ones a session can switch to. */
export function parseOpenCodeAgents(text: string): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = []
  for (const m of text.matchAll(/^([\w.-]+) \((primary|all)\)\s*$/gm)) {
    if (INTERNAL_AGENTS.has(m[1]) || out.some((a) => a.id === m[1])) continue
    out.push({ id: m[1], label: m[1].charAt(0).toUpperCase() + m[1].slice(1) })
  }
  return out
}

const cache = new Map<string, { at: number; value: Promise<AgentCatalog> }>()
const settled = new Map<string, AgentCatalog>()

/** The models and agents OpenCode offers on this machine (about 3 s to ask, so kept for 10 minutes). */
export function opencodeCliModels(host: Pick<Host, 'id' | 'exec'>): Promise<AgentCatalog> {
  const hit = cache.get(host.id)
  if (hit && Date.now() - hit.at < 600_000) return hit.value
  const value = (async (): Promise<AgentCatalog> => {
    try {
      const r = await host.exec(`${OC_PATH}; opencode models --verbose 2>/dev/null; echo '@@AGENTS'; opencode agent list 2>/dev/null`, { timeoutMs: 45_000 })
      const [modelsText, agentsText = ''] = r.stdout.split('@@AGENTS\n')
      const models = parseOpenCodeModels(modelsText)
      if (!models.length) {
        cache.delete(host.id)
        return { models: [], source: 'cli', updatedAt: Date.now(), error: 'OpenCode listed no models. Connect a provider first.' }
      }
      const modes = parseOpenCodeAgents(agentsText)
      const catalog: AgentCatalog = { models, source: 'cli', updatedAt: Date.now(), ...(modes.length ? { modes } : {}) }
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

/** After a provider was connected or disconnected: the next ask reads the list again. */
export function forgetOpenCodeModels(hostId: string) {
  cache.delete(hostId)
  settled.delete(hostId)
}

/** The footer's "Model Name Provider Name" without a known provider's name. */
export const withoutProvider = (footer: string) => {
  for (const name of allNames()) if (footer.endsWith(` ${name}`)) return footer.slice(0, -name.length - 1)
  return footer
}

/**
 * Matches the footer's "Model Name Provider Name" to a catalog entry: the whole thing, then the
 * longest model name the footer starts with (two providers can offer the same model).
 */
export function modelFromFooter(models: AgentModel[], footer: string): AgentModel | undefined {
  const text = footer.trim().toLowerCase()
  const name = (m: AgentModel) => m.label.split(' · ').slice(1).join(' · ').toLowerCase()
  const provider = (m: AgentModel) => m.label.split(' · ')[0].toLowerCase()
  const exact = models.filter((m) => text === `${name(m)} ${provider(m)}`)
  if (exact.length) return exact[0]
  const byName = models.filter((m) => text === name(m) || text.startsWith(name(m) + ' ')).sort((a, b) => name(b).length - name(a).length)
  if (byName.length <= 1) return byName[0]
  // several providers offer the model: the one whose name ends the footer, else the first
  const longest = name(byName[0])
  return byName.filter((m) => name(m) === longest).find((m) => text.endsWith(` ${provider(m)}`)) ?? byName[0]
}

/** What to call the model in the footer: its catalog name when known, else the footer without the provider. */
export function footerModelName(models: AgentModel[] | undefined, footer: string) {
  const known = models && modelFromFooter(models, footer)
  return known ? known.label.split(' · ').slice(1).join(' · ') : withoutProvider(footer)
}
