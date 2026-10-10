import type { HostConfig } from '@tether/protocol'
import { kv } from './platform/store.ts'

// ---------- hosts ----------

// the machine the core runs on, when it can run commands there (the hub can, the phone app can't)
let LOCAL: HostConfig | undefined
export const setLocalHost = (host: HostConfig | undefined) => void (LOCAL = host)

export function loadHosts(): HostConfig[] {
  const hosts = kv.get<HostConfig[]>('hosts') ?? []
  if (LOCAL && !hosts.some((h) => h.id === 'local')) hosts.unshift(LOCAL)
  return hosts
}

export function saveHosts(hosts: HostConfig[]) {
  kv.set('hosts', hosts)
}

// ---------- settings ----------

export interface HubSettings {
  uploads: { retentionDays: number; maxMB: number; longPasteLines: number }
  /** machines where Tether keeps a tmux session running */
  keepSession?: Record<string, boolean>
  /** resume idle Claude sessions that stopped reporting live numbers (off unless turned on) */
  autoResume?: boolean
}

const DEFAULT_SETTINGS: HubSettings = { uploads: { retentionDays: 7, maxMB: 100, longPasteLines: 40 } }

export function loadSettings(): HubSettings {
  const s = kv.get<Partial<HubSettings>>('settings') ?? {}
  return { ...DEFAULT_SETTINGS, ...s, uploads: { ...DEFAULT_SETTINGS.uploads, ...(s.uploads ?? {}) } }
}

export function saveSettings(s: HubSettings) {
  kv.set('settings', s)
}
