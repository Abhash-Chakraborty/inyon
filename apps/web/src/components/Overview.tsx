import { memo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronRight, ArrowRight, Check, CircleX, Gauge, MoreHorizontal, SquareTerminal } from 'lucide-react'
import { AGENTS, type HostState } from '@inyon/protocol'
import { type PaneRef, paneHref, paneTitle } from '../lib/overview.ts'
import { liveWindow, money, resetsIn, shortPath, timeAgo, tokens } from '../lib/format.ts'
import { api } from '../lib/api.ts'
import { haptic } from '../lib/haptics.ts'
import { toast, useStore } from '../lib/store.ts'
import { AgentLogo } from '../lib/skin.tsx'
import { HostDot, StatePill, backgroundText, hostLine, shownState, sshAddress } from './ui/status.tsx'
import { Menu, Meter, openMenu } from './ui/primitives.tsx'
import { useLongPress } from '../lib/longPress.ts'
import { endSession } from '../lib/end.ts'
import { tmuxTarget } from '../lib/groups.ts'

/** The parts of a pane ref a card draws; the rest of the machine changing shouldn't redraw it. */
const samePane = (a: { r: PaneRef; showHost?: boolean }, b: { r: PaneRef; showHost?: boolean }) =>
  a.r.pane === b.r.pane && a.r.window === b.r.window && a.r.host.config === b.r.host.config && a.r.host.status === b.r.host.status && a.r.host.hostname === b.r.host.hostname && a.showHost === b.showHost

/** A session waiting on you, with its answers as buttons. */
export const NeedsYouCard = memo(function NeedsYouCard({ r }: { r: PaneRef }) {
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
  return (
    <div className="animate-fade-in rounded-3xl border border-warn/35 bg-elev p-5 shadow-card">
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
      {a.waitingFor && <div className="mt-4 rounded-2xl border border-line bg-sunken px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed break-words text-fg">{a.waitingFor}</div>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {done ? (
          <span className="flex h-8 items-center gap-1.5 text-[13px] text-fg-2"><Check className="size-4" /> Answered</span>
        ) : opts.length ? (
          opts.map((o, i) => (
            <button
              key={o.n}
              type="button"
              disabled={busy !== null}
              onClick={() => answer(o.n)}
              className={clsx(
                'press h-9 max-w-full truncate rounded-full px-4 text-[13px] font-medium disabled:opacity-50',
                i === 0 ? 'bg-fg text-bg hover:opacity-90' : /^no\b/i.test(o.label) ? 'border border-line-strong text-danger hover:bg-danger-soft' : 'border border-line-strong hover:bg-hover',
              )}
            >
              {o.label}
            </button>
          ))
        ) : (
          <button type="button" onClick={() => nav(paneHref(r.host.config.id, r.pane.id))} className="press h-9 rounded-full bg-fg px-4 text-[13px] font-medium text-bg hover:opacity-90">
            Answer
          </button>
        )}
      </div>
    </div>
  )
}, samePane)

/**
 * An agent session as a card. The whole card opens it; ⋯ (shown on hover with a mouse, always on a
 * touch screen) and a long-press offer the actions that don't need the session open.
 */
export const SessionCard = memo(function SessionCard({ r, showHost = true }: { r: PaneRef; showHost?: boolean }) {
  const a = r.pane.agent!
  const st = a.status
  const pct = st?.contextPct
  const nav = useNavigate()
  const href = paneHref(r.host.config.id, r.pane.id)
  const menu = `card:${r.host.config.id}:${r.pane.id}`
  const press = useLongPress(() => openMenu(menu))
  return (
    <div {...press} className="group relative flex flex-col gap-3 rounded-3xl border border-line bg-elev p-4 shadow-card transition-colors [-webkit-touch-callout:none] hover:border-line-strong sm:gap-4 sm:p-5">
      <Link to={href} aria-label={paneTitle(r)} className="absolute inset-0 rounded-3xl" />
      <div className="pointer-events-none flex items-center gap-2.5">
        <AgentLogo kind={a.kind} size={26} active={a.state === 'working'} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-3">{AGENTS[a.kind].name}</span>
        <StatePill state={shownState(a, r.host)} title={a.background} />
        <span className="pointer-events-auto relative -my-1 -mr-1.5">
          <Menu
            name={menu}
            align="end"
            width={220}
            items={[
              { key: 'open', label: 'Open', icon: <ArrowRight className="size-4" />, onSelect: () => nav(href) },
              { key: 'terminal', label: 'Open terminal', icon: <SquareTerminal className="size-4" />, onSelect: () => nav(paneHref(r.host.config.id, r.pane.id, 'terminal')) },
              { key: 'end', label: 'End session…', icon: <CircleX className="size-4" />, danger: true, onSelect: () => void endSession(r) },
            ]}
            trigger={({ toggle, ref, open }) => (
              <button
                ref={ref}
                type="button"
                onClick={toggle}
                aria-label={`Actions for ${paneTitle(r)}`}
                className={clsx(
                  'flex size-8 items-center justify-center rounded-full text-fg-3 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 pointer-coarse:opacity-100',
                  open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
              >
                <MoreHorizontal className="size-4" />
              </button>
            )}
          />
        </span>
      </div>
      <div className="pointer-events-none min-w-0">
        <div className="truncate text-[17px] font-semibold tracking-[-0.03em]">{paneTitle(r)}</div>
        <div className="mt-1 truncate font-mono text-[12px] text-fg-3">
          {[showHost && r.host.config.name, tmuxTarget(r), shortPath(r.pane.cwd, 34)].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div className="pointer-events-none truncate text-[13.5px] text-fg-2">
        {a.state === 'working' ? a.activity ?? 'Working…' : a.state === 'waiting' ? a.waitingFor : a.background ? backgroundText(a.background) : `Active ${timeAgo(r.window.activity * 1000)}`}
      </div>
      <div className="pointer-events-none mt-auto flex items-center gap-2 border-t border-line pt-3.5 font-mono text-[12px] text-fg-3">
        <span className="truncate">{[st?.model, st?.effort].filter(Boolean).join(' · ') || ' '}</span>
        {st?.costUsd !== undefined && <span className="tabular shrink-0">{money(st.costUsd)}</span>}
        {pct !== undefined && (
          <span className="pointer-events-auto ml-auto flex shrink-0 items-center gap-1.5" title={`${tokens(st?.contextUsed)} of ${tokens(st?.contextSize)} tokens`}>
            <span className="tabular">{Math.round(pct)}%</span>
            <Meter value={pct} tone="auto" className="w-12" />
          </span>
        )}
      </div>
    </div>
  )
}, samePane)

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
    <section className="rounded-3xl border border-line bg-elev shadow-card p-5">
      <h2 className="mb-4 flex items-center gap-2 text-[15px] font-semibold tracking-[-0.02em]">
        <Gauge className="size-4 text-fg-3" /> Plan limits
      </h2>
      <div className="space-y-4">
        {rows.map(({ host, kind, st }) => (
          <div key={host.config.id + kind}>
            <div className="mb-2.5 flex items-center gap-2 text-[13px]">
              <AgentLogo kind={kind} size={16} />
              <span className="font-medium">{host.config.name}</span>
            </div>
            {([
              ['5-hour', liveWindow(st.fiveHour)],
              ['Weekly', liveWindow(st.sevenDay)],
            ] as const).map(([label, w]) =>
              w ? (
                <div key={label} className="mb-2">
                  <div className="mb-1.5 flex items-baseline text-[12.5px]">
                    <span className="text-fg-2">{label}</span>
                    <span className="ml-2 font-mono text-[12px] text-fg-3">{w.reset ? 'reset' : resetsIn(w.resetsAt)}</span>
                    <span className="tabular ml-auto font-mono text-[12px] font-medium">{Math.round(w.pct)}%</span>
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
          <span key={k} title={n ? `${AGENTS[k].name}: ${n} running` : `${AGENTS[k].name}: installed, not running`} className={clsx('flex items-center gap-1', !n && 'opacity-35 grayscale')}>
            <AgentLogo kind={k} size={size} />
            {n > 1 && <span className="tabular font-mono text-[12px] text-fg-3">{n}</span>}
          </span>
        )
      })}
    </span>
  )
}

export function MachinesTable({ hosts }: { hosts: HostState[] }) {
  return (
    <>
    <div className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-elev shadow-card sm:hidden">
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
              <div className="truncate font-mono text-[12px] text-fg-3">
                {hostLine(h, h.tmux === 'missing' ? 'tmux not installed' : `${plural(h.sessions.length, 'session')} · ${plural(panes, 'pane')}${h.latencyMs !== undefined ? ` · ${h.latencyMs} ms` : ''}`)}
              </div>
            </div>
            <ChevronRight className="size-4 shrink-0 text-fg-3" />
          </Link>
        )
      })}
    </div>
    <div className="hidden overflow-hidden rounded-3xl border border-line bg-elev shadow-card sm:block">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-[12px] text-fg-3">
              <th className="border-b border-line px-5 py-3 font-medium">Machine</th>
              <th className="border-b border-line px-5 py-3 font-medium" title="In colour: running now. Grey: installed.">Agents</th>
              <th className="border-b border-line px-5 py-3 font-medium">tmux</th>
              <th className="border-b border-line px-5 py-3 text-right font-medium">Latency</th>
            </tr>
          </thead>
          <tbody>
            {hosts.map((h) => {
              const panes = h.sessions.reduce((n, s) => n + s.windows.reduce((m, w) => m + w.panes.length, 0), 0)
              return (
                <tr key={h.config.id} className="hover:bg-hover/50">
                  <td className="border-b border-line/60 px-5 py-3.5">
                    <Link to={`/machines/${encodeURIComponent(h.config.id)}`} className="flex items-center gap-2.5">
                      <HostDot status={h.status} />
                      <div className="min-w-0">
                        <div className="font-medium">{h.config.name}</div>
                        <div className="truncate font-mono text-[12px] text-fg-3">
                          {h.status === 'error' ? h.error : h.config.kind === 'local' ? `This hub${h.os ? ` · ${h.os}` : ''}` : sshAddress(h.config, hosts)}
                        </div>
                      </div>
                    </Link>
                  </td>
                  <td className="border-b border-line/60 px-5 py-3.5">
                    <div className="flex items-center gap-1">
                      {h.agents.length ? <AgentBadges host={h} /> : <span className="text-fg-3">—</span>}
                    </div>
                  </td>
                  <td className="border-b border-line/60 px-5 py-3.5 text-fg-2">
                    {h.status !== 'online' ? (h.lastSeen ? 'Offline' : '—') : h.tmux === 'missing' ? 'Not installed' : `${plural(h.sessions.length, 'session')} · ${plural(panes, 'pane')}`}
                  </td>
                  <td className="tabular border-b border-line/60 px-5 py-3.5 text-right font-mono text-[12px] text-fg-2">{h.latencyMs !== undefined ? `${h.latencyMs} ms` : '—'}</td>
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
    <section className="rounded-3xl border border-line bg-elev shadow-card p-5">
      <h2 className="mb-4 text-[15px] font-semibold tracking-[-0.02em]">Recent activity</h2>
      <div className="space-y-3">
        {activity.slice(0, 8).map((e) => (
          <Link key={e.id} to={paneHref(e.host, e.pane)} className="flex gap-2.5">
            <AgentLogo kind={e.agent as any} size={18} />
            <div className="min-w-0">
              <div className="truncate text-[13px]">
                <span className="font-medium">{e.title}</span> <span className="text-fg-2">· {e.kind === 'waiting' ? 'needs you' : 'finished'}</span>
              </div>
              <div className="font-mono text-[12px] text-fg-3">{timeAgo(e.at)}</div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
