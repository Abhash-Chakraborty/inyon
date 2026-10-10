import { copilotModels } from '../agents/copilot-models.ts'
import { opencodeCatalog } from '../agents/opencode-api.ts'
import { AGENTS, type AgentCatalog } from '@tether/protocol'
import { registry, HttpError } from '../hosts/registry.ts'
import { agyModels } from '../agents/antigravity-models.ts'
import { codexModels } from '../agents/codex-models.ts'
import { opencodeCliModels } from '../agents/opencode-models.ts'

export async function listModels(hostId: string, paneId: string): Promise<AgentCatalog> {
  const pane = registry.findPane(hostId, paneId)?.pane
  if (!pane?.agent) throw new HttpError(404, 'No agent is running in this pane')
  if (pane.agent.kind === 'antigravity') return agyModels(registry.host(hostId))
  if (pane.agent.kind === 'opencode') {
    // started without --port: no API, so ask the CLI
    if (!pane.agent.transcriptPath?.startsWith('opencode://')) return opencodeCliModels(registry.host(hostId))
    return opencodeCatalog(registry.host(hostId), pane.agent.transcriptPath, pane.cwd)
  }
  if (pane.agent.kind === 'copilot') return copilotModels(registry.host(hostId))
  if (pane.agent.kind === 'codex') return codexModels(registry.host(hostId))
  return { models: AGENTS[pane.agent.kind].models, source: 'fallback', updatedAt: 0 }
}
