import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.ts'
import type { Host } from '../hosts/host.ts'
import { OpenCodeClient, opencodeCapabilities, type OpenCodeSelection } from './opencode-api.ts'

/** TUI selections are local UI state; the server accepts explicit selections per prompt.
 * We persist dashboard overrides and let a later native user message supersede them.
 */
type Stored = { selection: OpenCodeSelection; afterMessage?: string }
export class OpenCodeSelections {
  private entries: Record<string, Stored> = {}
  constructor(private file = path.join(DATA_DIR, 'opencode-selections.json')) {
    try { this.entries = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  }
  private key(host: string, uri: string) { return JSON.stringify([host, uri]) }
  get(host: string, uri: string, messages: any[]): OpenCodeSelection {
    const latest = [...messages].reverse().find((m) => (m.info ?? m).role === 'user')?.info
    const native = openCodeSelectionFromMessages(messages)
    const saved = this.entries[this.key(host, uri)]
    if (!saved || (latest?.id && latest.id !== saved.afterMessage)) return native
    return { ...native, ...saved.selection, variant: saved.selection.variant }
  }
  put(host: string, uri: string, selection: OpenCodeSelection, messages: any[]) {
    const latest = [...messages].reverse().find((m) => (m.info ?? m).role === 'user')?.info
    this.entries[this.key(host, uri)] = { selection, afterMessage: latest?.id }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.entries), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}
export function openCodeSelectionFromMessages(messages: any[]): OpenCodeSelection {
  const selection: OpenCodeSelection = {}
  for (const row of messages) {
    const info = row.info ?? row
    const provider = info.model?.providerID ?? info.providerID
    const model = info.model?.modelID ?? info.modelID
    if (provider && model) selection.model = `${provider}/${model}`
    if (info.agent) selection.agent = info.agent
    // A new user turn can explicitly return to the default (no variant).
    if (info.role === 'user') selection.variant = info.variant
    else if (info.variant) selection.variant = info.variant
  }
  return selection
}
const selections = new OpenCodeSelections()
export async function opencodeSelection(host: Host, uri: string, directory?: string) {
  const client = new OpenCodeClient(host, uri, directory)
  const messages = await client.request(`/session/${encodeURIComponent(client.session)}/message`)
  return selections.get(host.id, uri, Array.isArray(messages) ? messages : [])
}
export async function setOpenCodeSelection(host: Host, uri: string, change: OpenCodeSelection, directory?: string) {
  const client = new OpenCodeClient(host, uri, directory)
  const [capabilities, messages] = await Promise.all([opencodeCapabilities(host, uri, directory), client.request(`/session/${encodeURIComponent(client.session)}/message`)])
  const rows = Array.isArray(messages) ? messages : []
  const selection = { ...selections.get(host.id, uri, rows), ...change }
  const model = capabilities.catalog.models.find((m) => m.id === selection.model)
  if (change.model && !model) throw new Error('This OpenCode model is not available from a connected provider')
  if (change.model && !('variant' in change) && selection.variant && !model?.efforts?.includes(selection.variant)) selection.variant = undefined
  if (selection.variant && !model?.efforts?.includes(selection.variant)) throw new Error('This OpenCode model does not support that reasoning variant')
  if (selection.agent && !capabilities.agents.some((a: any) => a.id === selection.agent)) throw new Error('This OpenCode agent is unavailable')
  selections.put(host.id, uri, selection, rows)
  liveCache.delete(JSON.stringify([host.id, uri, directory]))
  return selection
}

const liveCache = new Map<string, { at: number; pending: Promise<ReturnType<typeof liveValue>> }>()
function liveValue(states: any, permissions: any, selection: OpenCodeSelection, session: string) {
  const pending = (Array.isArray(permissions) ? permissions : []).find((p: any) => p.sessionID === session)
  const state = states?.[session]?.type
  return { working: state === 'busy' || state === 'retry', retrying: state === 'retry', permission: pending, selection }
}
/** Coalesce screen redraw bursts; one authoritative status refresh per second per session. */
export function opencodeLive(host: Host, uri: string, directory?: string) {
  const key = JSON.stringify([host.id, uri, directory])
  const cached = liveCache.get(key)
  if (cached && Date.now() - cached.at < 1000) return cached.pending
  const client = new OpenCodeClient(host, uri, directory)
  const pending = Promise.all([
    client.request('/session/status', 'GET', undefined, 3),
    client.request('/permission', 'GET', undefined, 3),
    client.session ? opencodeSelection(host, uri, directory) : Promise.resolve({}),
  ]).then(([states, permissions, selection]) => liveValue(states, permissions, selection, client.session))
  liveCache.set(key, { at: Date.now(), pending })
  if (liveCache.size > 100) for (const [id, entry] of liveCache) if (Date.now() - entry.at > 60_000) liveCache.delete(id)
  return pending
}
