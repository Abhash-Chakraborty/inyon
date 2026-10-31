import type { HostState, HostStatus } from '@inyon/protocol'
import { causeOf, connLog, dropped, setPowerSource, watchPage } from './connlog.ts'
import { nativePower } from './native.ts'
import { useStore } from './store.ts'

/**
 * Keeps the connection log (connlog.ts) for every computer and machine, from the machine list:
 * one that goes from online to anything else dropped, with its own error as the reason, and one
 * that comes back is up again. Hubs are logged where their sockets are (socket.ts).
 */
export function followHosts(hosts: HostState[], seen: Map<string, { status: HostStatus; error?: string }>) {
  const ids = new Set<string>()
  for (const h of hosts) {
    const id = h.config.id
    ids.add(id)
    const about = { kind: h.config.kind === 'link' ? ('computer' as const) : ('machine' as const), name: h.config.name }
    const was = seen.get(id)
    seen.set(id, { status: h.status, error: h.error })
    if (h.status === 'online') {
      if (was?.status !== 'online') connLog.up(id, about)
      continue
    }
    const cause = causeOf(h.error)
    if (was?.status === 'online') dropped(id, about, cause, { detail: h.error })
    // still down, and it says something new: another failed try
    else if (was && h.error && h.error !== was.error && connLog.get(id)?.up === false) connLog.down(id, about, cause, { detail: h.error })
    // first seen down with a reason of its own (not paired, say); a hub that's out of reach is the hub's drop
    else if (!was && h.error && cause !== 'hub-down') dropped(id, about, cause, { detail: h.error })
  }
  for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id)
}

let installed = false
export function installConnWatch() {
  if (installed) return
  installed = true
  watchPage()
  setPowerSource(nativePower)
  const seen = new Map<string, { status: HostStatus; error?: string }>()
  useStore.subscribe((s, prev) => {
    // the copy this device kept paints first; only what the hub or the phone's core says counts
    if (s.hosts === prev.hosts || s.hostsStale) return
    followHosts(s.hosts, seen)
  })
}
