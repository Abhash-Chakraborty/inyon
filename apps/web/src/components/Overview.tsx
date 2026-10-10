import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronRight, ArrowRight, Check, Gauge } from 'lucide-react'
import { AGENTS, type HostState } from '@tether/protocol'
import { type PaneRef, paneHref, paneTitle } from '../lib/overview.ts'
import { liveWindow, money, resetsIn, shortPath, timeAgo, tokens } from '../lib/format.ts'
import { api } from '../lib/api.ts'
import { haptic } from '../lib/haptics.ts'
import { toast, useStore } from '../lib/store.ts'
import { AgentLogo, useAgentAccent } from '../lib/skin.tsx'
import { HostDot, StatePill, backgroundText, shownState } from './ui/status.tsx'
import { Meter } from './ui/primitives.tsx'

/** A session waiting on you, with its answers as buttons. */
export function NeedsYouCard({ r }: { r: PaneRef }) {
  const a = r.pane.agent!
  const nav = useNavigate()
  const [busy, setBusy] = useState<number | null>(null)
  const [done, setDone] = useState(false)
  const answer = async (n: number) => {
    setBusy(n)
    try {
      await api.answer(r.host.config.id, r.pane.id, n)
      haptic('success')
      setDone(true)
      // a card still here after a moment means the agent is still asking: show the choices again
      setTimeout(() => setDone(false), 4000)
    } catch (e) {
      toast({ title: 'Could not answer', body: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(null)
    }
  }
  const opts = a.options ?? []
  const accent = useAgentAccent(a.kind)
  return (
    <div style={accent} className="animate-fade-in rounded-[16px] border border-accent/35 bg-accent-soft/40 p-4">
      <div className="flex items-center gap-3">
        <AgentLogo kind={a.kind} size={30} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14.5px] font-semibold tracking-tight">{paneTitle(r)}</div>
          <div className="truncate text-[12px] text-fg-3">
            {AGENTS[a.kind].name} · {r.host.config.name} · {shortPath(r.pane.cwd, 28)}
          </div>
        </div>
        <Link to={paneHref(r.host.config.id, r.pane.id)} className="hidden shrink-0 items-center gap-1 text-[12.5px] text-fg-2 hover:text-fg sm:flex">
          Open <ArrowRight className="size-3.5" />
        </Link>
      </div>
      {a.waitingFor && <div className="mt-3 rounded-[10px] border border-line bg-elev px-3 py-2 font-mono text-[12.5px] leading-relaxed break-words text-fg">{a.waitingFor}</div>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {done ? (
          <span className="flex h-8 items-center gap-1.5 text-[13px] text-ok"><Check className="size-4" /> Answered</span>
        ) : opts.length ? (
          opts.map((o, i) => (
            <button
              key={o.n}
              type="button"
              disabled={busy !== null}
              onClick={() => answer(o.n)}
              className={clsx(
                'h-8 max-w-full truncate rounded-[9px] px-3 text-[12.5px] font-medium transition-opacity disabled:opacity-50',
                i === 0 ? 'bg-accent text-accent-fg hover:opacity-90' : /^no\b/i.test(o.label) ? 'border border-line-strong text-danger hover:bg-danger-soft' : 'border border-line-strong hover:bg-hover',
              )}
            >
              {o.label}
            </button>
          ))
        ) : (
          <button type="button" onClick={() => nav(paneHref(r.host.config.id, r.pane.id))} className="h-8 rounded-[9px] bg-accent px-3 text-[12.5px] font-medium text-accent-fg">
            Answer
          </button>
        )}
      </div>
    </div>
  )
}

export function SessionCard({ r }: { r: PaneRef }) {
  const a = r.pane.agent!
  const st = a.status
  const pct = st?.contextPct
  return (
    <Link to={paneHref(r.host.config.id, r.pane.id)} className="group flex flex-col gap-3 rounded-[16px] border border-line bg-elev p-4 transition-colors hover:border-line-strong">
      <div className="flex items-center gap-2.5">
        <AgentLogo kind={a.kind} size={26} active={a.state === 'working'} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-3">{AGENTS[a.kind].name}</span>
        <StatePill state={shownState(a)} title={a.background} />
      </div>
      <div className="min-w-0">
        <div className="truncate text-[15px] font-semibold tracking-tight">{paneTitle(r)}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-fg-3">
          {r.host.config.name} · {shortPath(r.pane.cwd, 34)}
        </div>
      </div>
      <div className="truncate text-[12.5px] text-fg-2">
        {a.state === 'working' ? a.activity ?? 'Working…' : a.state === 'waiting' ? a.waitingFor : a.background ? backgroundText(a.background) : `Active ${timeAgo(r.window.activity * 1000)}`}
      </div>
      <div className="mt-auto flex items-center gap-2 text-[11.5px] text-fg-3">
        <span className="truncate font-mono">{[st?.model, st?.effort].filter(Boolean).join(' · ') || ' '}</span>
        {st?.costUsd !== undefined && <span className="tabular shrink-0">{money(st.costUsd)}</span>}
        {pct !== undefined && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5" title={`${tokens(st?.contextUsed)} of ${tokens(st?.contextSize)} tokens`}>
            <span className="tabular">{Math.round(pct)}%</span>
            <Meter value={pct} tone="auto" className="w-12" />
          </span>
        )}
      </div>
    </Link>
  )
}

/** Plan limits per machine, from the freshest agent status reported there. */
export function LimitsCard({ hosts }: { hosts: HostState[] }) {
  const rows = hosts.flatMap((h) => {
    const best = new Map<string, NonNullable<NonNullable<HostState['sessions'][number]['windows'][number]['panes'][number]['agent']>['status']>>()
    for (const s of h.sessions)
      for (const w of s.windows)
        for (const p of w.panes) {
          const st = p.agent?.status
          if (!st || !(st.fiveHour || st.sevenDay)) continue
          const k = p.agent!.kind
          if (!best.has(k) || best.get(k)!.updatedAt < st.updatedAt) best.set(k, st)
        }
    return [...best.entries()].map(([kind, st]) => ({ host: h, kind: kind as keyof typeof AGENTS, st }))
  })
  if (!rows.length) return null
  return (
    <section className="rounded-[16px] border border-line bg-elev p-4">
      <h2 className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
        <Gauge className="size-4 text-fg-3" /> Plan limits
      </h2>
      <div className="space-y-4">
        {rows.map(({ host, kind, st }) => (
          <div key={host.config.id + kind}>
            <div className="mb-2 flex items-center gap-2 text-[12.5px]">
              <AgentLogo kind={kind} size={16} />
              <span className="font-medium">{host.config.name}</span>
            </div>
            {([
              ['5-hour', liveWindow(st.fiveHour)],
              ['Weekly', liveWindow(st.sevenDay)],
            ] as const).map(([label, w]) =>
              w ? (
                <div key={label} className="mb-2">
                  <div className="mb-1 flex items-baseline text-[12px]">
                    <span className="text-fg-2">{label}</span>
                    <span className="ml-2 text-fg-3">{w.reset ? 'reset' : resetsIn(w.resetsAt)}</span>
                    <span className="tabular ml-auto font-medium">{Math.round(w.pct)}%</span>
                  </div>
                  <Meter value={w.pct} tone="auto" />
                </div>
              ) : null,
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * The coding CLIs on a machine: in colour when one is running there now, grey when it's only
 * installed. Hover says which is which.
 */
export function AgentBadges({ host, size = 18 }: { host: HostState; size?: number }) {
  if (!host.agents.length) return null
  const running = new Map<string, number>()
  for (const s of host.sessions) for (const w of s.windows) for (const p of w.panes) if (p.agent) running.set(p.agent.kind, (running.get(p.agent.kind) ?? 0) + 1)
  return (
    <span className="flex shrink-0 items-center gap-1.5 pt-1 pr-1">
      {host.agents.map((k) => {
        const n = running.get(k) ?? 0
        return (
          <span key={k} title={n ? `${AGENTS[k].name}: ${n} running` : `${AGENTS[k].name}: installed, not running`} className={clsx('relative flex', !n && 'opacity-35 grayscale')}>
            <AgentLogo kind={k} size={size} />
            {n > 1 && (
              <span className="tabular absolute -top-1.5 -right-1.5 flex h-[13px] min-w-[13px] items-center justify-center rounded-full bg-fg px-[3px] text-[8.5px] font-bold text-bg ring-2 ring-elev">
                {n}
              </span>
            )}
          </span>
        )
      })}
    </span>
  )
}

export function MachinesTable({ hosts }: { hosts: HostState[] }) {
  return (
    <>
    <div className="divide-y divide-line overflow-hidden rounded-[16px] border border-line bg-elev sm:hidden">
      {hosts.map((h) => {
        const panes = h.sessions.reduce((n, s) => n + s.windows.reduce((m, w) => m + w.panes.length, 0), 0)
        return (
          <Link key={h.config.id} to={`/machines/${encodeURIComponent(h.config.id)}`} className="flex items-center gap-3 px-4 py-3 active:bg-hover">
            <HostDot status={h.status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[14px] font-medium">{h.config.name}</span>
                <AgentBadges host={h} size={15} />
              </div>
              <div className="truncate text-[12px] text-fg-3">
                {h.status === 'error' ? h.error : h.status !== 'online' ? 'Connecting…' : h.tmux === 'missing' ? 'tmux not installed' : `${h.sessions.length} sessions · ${panes} panes${h.latencyMs !== undefined ? ` · ${h.latencyMs} ms` : ''}`}
              </div>
            </div>
            <ChevronRight className="size-4 shrink-0 text-fg-3" />
          </Link>
        )
      })}
    </div>
    <div className="hidden overflow-hidden rounded-[16px] border border-line bg-elev sm:block">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-[12px] text-fg-3">
              <th className="border-b border-line px-4 py-2.5 font-medium">Machine</th>
              <th className="border-b border-line px-4 py-2.5 font-medium" title="In colour: running now. Grey: installed.">Agents</th>
              <th className="border-b border-line px-4 py-2.5 font-medium">tmux</th>
              <th className="border-b border-line px-4 py-2.5 text-right font-medium">Latency</th>
            </tr>
          </thead>
          <tbody>
            {hosts.map((h) => {
              const panes = h.sessions.reduce((n, s) => n + s.windows.reduce((m, w) => m + w.panes.length, 0), 0)
              return (
                <tr key={h.config.id} className="hover:bg-hover/50">
                  <td className="border-b border-line/60 px-4 py-3">
                    <Link to={`/machines/${encodeURIComponent(h.config.id)}`} className="flex items-center gap-2.5">
                      <HostDot status={h.status} />
                      <div className="min-w-0">
                        <div className="font-medium">{h.config.name}</div>
                        <div className="truncate text-[11.5px] text-fg-3">
                          {h.status === 'error' ? h.error : h.config.kind === 'local' ? `This hub${h.os ? ` · ${h.os}` : ''}` : h.config.target}
                        </div>
                      </div>
                    </Link>
                  </td>
                  <td className="border-b border-line/60 px-4 py-3">
                    <div className="flex items-center gap-1">
                      {h.agents.length ? <AgentBadges host={h} /> : <span className="text-fg-3">—</span>}
                    </div>
                  </td>
                  <td className="border-b border-line/60 px-4 py-3 text-fg-2">
                    {h.status !== 'online' ? '—' : h.tmux === 'missing' ? 'Not installed' : `${h.sessions.length} sessions · ${panes} panes`}
                  </td>
                  <td className="tabular border-b border-line/60 px-4 py-3 text-right font-mono text-[12px] text-fg-2">{h.latencyMs !== undefined ? `${h.latencyMs} ms` : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
    </>
  )
}

export function ActivityFeed() {
  const activity = useStore((s) => s.activity)
  if (!activity.length) return null
  return (
    <section className="rounded-[16px] border border-line bg-elev p-4">
      <h2 className="mb-3 text-[13px] font-semibold">Recent activity</h2>
      <div className="space-y-3">
        {activity.slice(0, 8).map((e) => (
          <Link key={e.id} to={paneHref(e.host, e.pane)} className="flex gap-2.5">
            <AgentLogo kind={e.agent as any} size={18} />
            <div className="min-w-0">
              <div className="truncate text-[13px]">
                <span className="font-medium">{e.title}</span> <span className="text-fg-2">· {e.kind === 'waiting' ? 'needs you' : 'finished'}</span>
              </div>
              <div className="text-[11.5px] text-fg-3">{timeAgo(e.at)}</div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}
