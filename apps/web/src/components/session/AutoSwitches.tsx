import { CalendarClock, Shrink } from 'lucide-react'
import type { AgentKind, HostState } from '@inyon/protocol'
import { api } from '../../lib/api.ts'
import { autoRules, canAutomate, toast, useStore } from '../../lib/store.ts'
import { markFor } from '../../lib/organize.ts'
import { Toggle } from '../ui/primitives.tsx'

/** The threshold the hub compacts at when nobody picked one. */
export const COMPACT_AT = 85

/** Agents whose stop on a plan limit the hub can see (Claude Code's StopFailure hook). */
const CARRIES_ON: AgentKind[] = ['claude']

/**
 * From 0.27, two things the hub does for this session on its own: carry on once a plan limit it
 * stopped on resets, and compact before the context fills. Each follows the hub's rule for every
 * session (Settings › Live numbers) until it's switched here.
 */
export function AutoSwitches({ host, pane, agent, compact }: { host?: HostState; pane?: string; agent?: AgentKind; compact: boolean }) {
  // the whole record, so the switches follow every change the hub sends
  const organize = useStore((s) => s.organize)
  if (!host || !pane || !agent || !canAutomate(host.config.id)) return null
  const hostId = host.config.id
  const carries = CARRIES_ON.includes(agent)
  if (!carries && !compact) return null
  const mark = markFor(organize, hostId, pane)
  const rules = autoRules(hostId)
  const carryOn = mark?.carryOn ?? !!rules?.carryOn
  const autoCompact = mark?.autoCompact ?? !!rules?.autoCompact
  const at = rules?.compactAt ?? COMPACT_AT
  const set = async (patch: { carryOn?: boolean; autoCompact?: boolean }) => {
    try {
      await api.organize(hostId, pane, patch)
    } catch (e) {
      toast({ title: 'Could not change the session', body: (e as Error).message, tone: 'error' })
    }
  }
  return (
    <section className="divide-y divide-line rounded-3xl border border-line bg-elev shadow-card">
      {carries && (
        <div className="flex items-center gap-3 px-3.5 py-3">
          <CalendarClock className="size-4 shrink-0 text-fg-3" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium">Carry on after a limit</div>
            <div className="text-[12px] text-fg-3">{carryOn ? 'Sends “continue” a minute after the plan limit resets' : 'Off'}</div>
          </div>
          <Toggle on={carryOn} onChange={(v) => void set({ carryOn: v })} label="Carry on after a limit" />
        </div>
      )}
      {compact && (
        <div className="flex items-center gap-3 px-3.5 py-3">
          <Shrink className="size-4 shrink-0 text-fg-3" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium">Compact before it fills</div>
            <div className="text-[12px] text-fg-3">{autoCompact ? `At ${at}% of the context, once the agent is idle` : 'Off'}</div>
          </div>
          <Toggle on={autoCompact} onChange={(v) => void set({ autoCompact: v })} label="Compact before it fills" />
        </div>
      )}
    </section>
  )
}
