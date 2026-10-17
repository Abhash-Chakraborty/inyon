import type { AgentModel, ScreenState } from '@inyon/protocol'
import type { Host } from '../hosts/host.ts'
import { OpenCodeClient, type OpenCodeSelection } from './opencode-api.ts'
import { modelFromFooter } from './opencode-models.ts'

/**
 * What a prompt sent through the API should run with. The terminal's footer is the truth: whatever
 * it shows (agent, model, variant) is what OpenCode itself would use for the next message. The
 * server's own idea of the session's model (`/session/{id}`) is only what the last message ran
 * with, so it stands in when the footer can't be read, with the last message after that.
 */
export function selectionFromFooter(screen: Pick<ScreenState, 'model' | 'effort' | 'mode'>, models: AgentModel[]): OpenCodeSelection | undefined {
  if (!screen.model) return undefined
  const model = modelFromFooter(models, screen.model)
  if (!model) return undefined
  return { model: model.id, variant: screen.effort, agent: screen.mode }
}

/** The agent and model the session last ran with, from the server. */
export async function storedSelection(client: OpenCodeClient): Promise<OpenCodeSelection> {
  const info = await client.info().catch(() => undefined)
  const model = info?.model
  return {
    model: model?.providerID && model?.id ? `${model.providerID}/${model.id}` : undefined,
    variant: typeof model?.variant === 'string' ? model.variant : undefined,
    agent: typeof info?.agent === 'string' ? info.agent : undefined,
  }
}

/** The last user message's agent, model and variant, for a session the server knows nothing more about. */
export function selectionFromMessages(messages: any[]): OpenCodeSelection {
  const selection: OpenCodeSelection = {}
  for (const row of messages) {
    const info = row.info ?? row
    const provider = info.model?.providerID ?? info.providerID
    const model = info.model?.modelID ?? info.modelID
    if (provider && model) selection.model = `${provider}/${model}`
    if (info.agent) selection.agent = info.agent
    // a new user turn can go back to the default (no variant)
    if (info.role === 'user') selection.variant = info.model?.variant ?? info.variant
    else if (info.variant) selection.variant = info.variant
  }
  return selection
}

const liveCache = new Map<string, { at: number; pending: Promise<ReturnType<typeof liveValue>> }>()
/** `children` are the session's subagent sessions: their work shows as background, their questions as waiting. */
export function liveValue(states: any, permissions: any, session: string, children: Set<string> = new Set()) {
  const pending = (Array.isArray(permissions) ? permissions : []).find((p: any) => p.sessionID === session || children.has(p.sessionID))
  const busy = (type?: string) => type === 'busy' || type === 'retry'
  const state = states?.[session]?.type
  const agents = [...children].filter((id) => busy(states?.[id]?.type)).length
  return { working: busy(state), retrying: state === 'retry', permission: pending, background: agents ? `${agents} ${agents === 1 ? 'agent' : 'agents'}` : null }
}
/** Whether the session is busy, what runs under it and what permission it waits for, from its server; one ask per second per session. */
export function opencodeLive(host: Host, uri: string, directory?: string) {
  const key = JSON.stringify([host.id, uri, directory])
  const cached = liveCache.get(key)
  if (cached && Date.now() - cached.at < 1000) return cached.pending
  const client = new OpenCodeClient(host, uri, directory)
  const pending = Promise.all([
    client.request('/session/status', 'GET', undefined, 3),
    client.request('/permission', 'GET', undefined, 3),
    client.session ? client.request('/session', 'GET', undefined, 3).catch(() => []) : Promise.resolve([]),
  ]).then(([states, permissions, sessions]) => {
    const children = new Set<string>((Array.isArray(sessions) ? sessions : []).filter((s: any) => s?.parentID === client.session && typeof s.id === 'string').map((s: any) => s.id))
    return liveValue(states, permissions, client.session, children)
  })
  liveCache.set(key, { at: Date.now(), pending })
  if (liveCache.size > 100) for (const [id, entry] of liveCache) if (Date.now() - entry.at > 60_000) liveCache.delete(id)
  return pending
}
