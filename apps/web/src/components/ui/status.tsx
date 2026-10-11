import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { AGENTS, type AgentKind, type AgentState, type HostStatus } from '@tether/protocol'

/** The agent's own spinner glyphs (Claude's ✻ cycle, Codex's braille dots, …). */
export function AgentSpinner({ kind = 'claude', active, className }: { kind?: AgentKind; active?: boolean; className?: string }) {
  const frames = AGENTS[kind].spinner
  const [i, setI] = useState(Math.floor(frames.length / 2))
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setI((n) => (n + 1) % frames.length), kind === 'claude' ? 120 : 90)
    return () => clearInterval(t)
  }, [active, frames.length, kind])
  return (
    <span aria-hidden className={clsx('inline-flex select-none items-center justify-center font-mono leading-none text-accent', className)}>
      {frames[i % frames.length]}
    </span>
  )
}

/** What a session shows: an idle agent with shells or tasks still running counts as busy in the background. */
export type ShownState = AgentState | 'background' | 'offline'
/** On a machine that isn't answering, a session is shown as it was last seen: "Offline". */
export const shownState = (a: { state: AgentState; background?: string }, host?: { status: HostStatus }): ShownState =>
  host && host.status !== 'online' ? 'offline' : a.state === 'idle' && a.background ? 'background' : a.state

/** "1 background task" → "1 task running in the background" */
export const backgroundText = (bg: string) => `${bg.replace(/\bbackground /, '')} running in the background`

const stateMeta: Record<ShownState, { label: string; dot: string; pill: string }> = {
  // one fixed colour for "working" across every agent skin, with a ring that reads at a glance
  working: { label: 'Working', dot: 'bg-info live-ring', pill: 'text-info bg-info/12' },
  background: { label: 'Background', dot: 'bg-info pulse-soft', pill: 'text-info bg-info/10' },
  waiting: { label: 'Needs you', dot: 'bg-warn', pill: 'bg-warn-soft text-warn' },
  idle: { label: 'Idle', dot: 'bg-fg-3', pill: 'bg-sunken text-fg-2' },
  unknown: { label: 'Running', dot: 'bg-fg-3', pill: 'bg-sunken text-fg-2' },
  offline: { label: 'Offline', dot: 'bg-fg-3/50', pill: 'bg-sunken text-fg-3' },
}

/** One line about a machine: its sessions when online, when it was last seen when not. */
export function hostLine(h: { status: HostStatus; error?: string; lastSeen?: number; offlineSince?: number }, online: string) {
  if (h.status === 'online') return online
  if (h.lastSeen) return `Offline · last seen ${ago(h.lastSeen)}`
  // the reason, when there is one, beats a bare "Connecting…"
  return h.status === 'error' ? h.error ?? 'Not reachable' : h.error ?? 'Connecting…'
}

function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export function StatePill({ state, title, className }: { state: ShownState; title?: string; className?: string }) {
  const m = stateMeta[state]
  return (
    <span title={title} className={clsx('inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-[6px] px-2 text-[11.5px] font-medium', m.pill, className)}>
      <span className={clsx('size-1.5 rounded-full', m.dot)} />
      {m.label}
    </span>
  )
}

export function StateDot({ state, className }: { state: ShownState; className?: string }) {
  return <span className={clsx('inline-block size-[7px] shrink-0 rounded-full', stateMeta[state].dot, className)} />
}

export function HostDot({ status }: { status: HostStatus }) {
  return (
    <span
      className={clsx(
        'inline-block size-[7px] shrink-0 rounded-full',
        status === 'online' && 'bg-ok',
        status === 'connecting' && 'bg-fg-3 pulse-soft',
        status === 'error' && 'bg-danger',
      )}
    />
  )
}
