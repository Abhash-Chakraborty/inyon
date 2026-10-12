import { useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import {
  ChevronLeft, Layers, MessageSquare, MoreHorizontal, PanelRight, RadioTower, RotateCcw, Shrink, SquareTerminal, Trash2, Copy, ExternalLink, Power, Pencil, LogOut, Shield,
} from 'lucide-react'
import type { SessionModel } from './useSession.ts'
import { RenameSheet } from './RenameSheet.tsx'
import { contextOf, UsageSummary, useTick } from './Usage.tsx'
import { AgentLogo } from '../../lib/skin.tsx'
import { liveWindow, openLink, shortPath, tokens } from '../../lib/format.ts'
import { paneTitle, terminalName } from '../../lib/overview.ts'
import { IconButton, Menu } from '../ui/primitives.tsx'
import { StateDot, StatePill, shownState } from '../ui/status.tsx'

/** Tiny ring showing how full the context window is. */
function ContextRing({ pct, warn }: { pct?: number; warn?: boolean }) {
  const v = Math.max(0, Math.min(100, pct ?? 0))
  const r = 8
  const c = 2 * Math.PI * r
  const color = warn || v >= 85 ? 'var(--danger)' : v >= 60 ? 'var(--warn)' : 'var(--accent)'
  return (
    <span className="relative flex size-[18px] shrink-0 items-center justify-center" aria-hidden>
      <svg viewBox="0 0 20 20" className="absolute inset-0 -rotate-90">
        <circle cx="10" cy="10" r={r} fill="none" stroke="var(--line-strong)" strokeWidth="2.2" />
        <circle cx="10" cy="10" r={r} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} />
      </svg>
    </span>
  )
}

/**
 * Context and limits in one chip. Hover (or keyboard focus) shows the full breakdown; a click
 * opens the usage panel, which is also where phones get it.
 */
function UsageChip({ s, onOpen }: { s: SessionModel; onOpen: () => void }) {
  const { status, info } = s
  const ctx = contextOf(status, info)
  const five = liveWindow(status?.fiveHour)
  const stopped = s.ref?.pane.agent?.statusStopped
  return (
    <div className="group/usage relative">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Usage and limits"
        className="flex h-8 items-center gap-2 rounded-full px-1.5 font-mono text-[12px] text-fg-2 hover:bg-hover md:px-2.5"
      >
        <ContextRing pct={ctx.pct} warn={stopped} />
        <span className="tabular hidden sm:inline">{ctx.pct !== undefined ? `${Math.round(ctx.pct)}%` : tokens(ctx.used)}</span>
        {five && <span className="tabular hidden text-fg-3 lg:inline">· 5h {Math.round(five.pct)}%</span>}
      </button>
      <div className="pointer-events-none invisible absolute right-0 top-full z-30 w-[290px] pt-2 opacity-0 transition-opacity duration-150 group-hover/usage:pointer-events-auto group-hover/usage:visible group-hover/usage:opacity-100 group-focus-within/usage:visible group-focus-within/usage:opacity-100 max-md:hidden">
        <div className="rounded-3xl border border-line bg-elev p-4 shadow-float">
          <UsageSummary status={status} info={info} agentInfo={s.ref?.pane.agent} />
        </div>
      </div>
    </div>
  )
}

/** Header for a session: identity, usage at a glance and the view switch. Controls live in the composer. */
export function SessionHeader({
  s,
  view,
  setView,
  panelOpen,
  togglePanel,
  openSheet,
}: {
  s: SessionModel
  view: 'chat' | 'terminal'
  setView: (v: 'chat' | 'terminal') => void
  panelOpen: boolean
  togglePanel: () => void
  openSheet: (which: 'controls' | 'activity') => void
}) {
  useTick(15_000)
  const { ref, def, info, agent, actions } = s
  const [renaming, setRenaming] = useState(false)
  const title = ref?.pane.label || info?.title || (ref ? (ref.pane.agent ? paneTitle(ref) : terminalName(ref) ?? paneTitle(ref)) : 'Session')
  const busy = (info?.tasks.filter((t) => t.status === 'running').length ?? 0) + (info?.subagents.filter((x) => x.status === 'running').length ?? 0)

  const subtitle = [def?.name ?? 'Terminal', ref?.host.config.name, ref && `${ref.session.name}:${ref.window.index}`, shortPath(info?.cwd ?? ref?.pane.cwd, 28)]
    .filter(Boolean)
    .join(' · ')

  return (
    <header className="pt-safe z-10 shrink-0 border-b border-line bg-bg">
      <div className="flex h-[60px] items-center gap-1.5 px-2 sm:px-5">
        <Link to="/" aria-label="Back" className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-hover relative after:absolute after:-inset-1 md:hidden">
          <ChevronLeft className="size-5" />
        </Link>
        {/* phones name the agent in the subtitle; the title gets the room */}
        <AgentLogo kind={agent} size={26} active={s.screen?.working ?? ref?.pane.agent?.state === 'working'} className="max-sm:hidden" />
        <div className="min-w-0 flex-1 pl-1">
          <h1 className="flex items-center gap-1.5 text-[16px] font-semibold leading-tight tracking-[-0.03em]">
            {ref?.pane.agent && <StateDot state={shownState(ref.pane.agent, ref.host)} className="sm:hidden" />}
            <button type="button" onClick={() => ref && setRenaming(true)} title="Rename" className="group/title flex min-w-0 items-center gap-1.5 text-left">
              <span className="truncate">{title}</span>
              <Pencil className="size-3 shrink-0 text-fg-3 opacity-0 transition-opacity group-hover/title:opacity-100 max-md:hidden" />
            </button>
          </h1>
          <p className="mt-0.5 truncate font-mono text-[12px] text-fg-3">{subtitle}</p>
        </div>
        {ref?.pane.agent && (
          <span className="hidden sm:block">
            <StatePill state={shownState(ref.pane.agent, ref.host)} title={ref.pane.agent.background} />
          </span>
        )}
        {agent && <UsageChip s={s} onOpen={() => openSheet('controls')} />}
        {def?.set.rc && info?.rc && (
          <Menu
            header="Remote Control is on"
            align="end"
            width={240}
            items={[
              { key: 'open', label: agent === 'antigravity' ? 'Open in Antigravity' : 'Open on claude.ai', icon: <ExternalLink className="size-4" />, onSelect: () => openLink(info.rc!.url) },
              { key: 'off', label: 'Turn off', icon: <Power className="size-4" />, danger: true, onSelect: () => actions.rc(false) },
            ]}
            trigger={({ toggle, ref: r, open }) => (
              <button ref={r} type="button" onClick={toggle} title="Remote Control is on" className={clsx('flex size-8 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-hover hover:text-fg', open && 'bg-hover text-fg')}>
                <RadioTower className="size-4" />
              </button>
            )}
          />
        )}
        <div role="group" aria-label="View" className="flex shrink-0 rounded-full border border-line bg-sunken p-0.5">
          {(['chat', 'terminal'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-label={v === 'chat' ? 'Chat' : 'Terminal'}
              className={clsx('flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium transition-colors', view === v ? 'bg-elev text-fg shadow-card ring-1 ring-line' : 'text-fg-3 hover:text-fg-2')}
            >
              {v === 'chat' ? <MessageSquare className="size-3.5" /> : <SquareTerminal className="size-3.5" />}
              <span className="hidden lg:inline">{v === 'chat' ? 'Chat' : 'Terminal'}</span>
            </button>
          ))}
        </div>
        {agent && (
          <span className="min-[1180px]:hidden">
            <IconButton label="Running tasks, subagents and changes" onClick={() => openSheet('activity')}>
              <span className="relative">
                <Layers className="size-[17px]" />
                {busy > 0 && <span className="absolute -top-1 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-fg px-1 text-[12px] leading-none font-semibold text-bg">{busy}</span>}
              </span>
            </IconButton>
          </span>
        )}
        {agent && (
          <span className="hidden min-[1180px]:block">
            <IconButton label={panelOpen ? 'Hide side panel' : 'Show side panel'} active={panelOpen} onClick={togglePanel}>
              <PanelRight className="size-4" />
            </IconButton>
          </span>
        )}
        {agent && def && (
          // phones get the same actions in the session controls sheet
          <span className="md:hidden">
            <IconButton label="More" onClick={() => openSheet('controls')}>
              <MoreHorizontal className="size-[17px]" />
            </IconButton>
          </span>
        )}
        {agent && def && (
          <Menu
            align="end"
            width={240}
            items={[
              { key: 'controls', label: 'Session controls…', icon: <Shield className="size-4" />, onSelect: () => openSheet('controls') },
              def.set.rc && !info?.rc && { key: 'rc', label: 'Turn on Remote Control', icon: <RadioTower className="size-4" />, onSelect: () => actions.rc(true) },
              def.set.compact && { key: 'compact', label: 'Compact context', icon: <Shrink className="size-4" />, onSelect: actions.compact },
              (agent === 'claude' || agent === 'antigravity' || agent === 'codex' || agent === 'opencode') && { key: 'rewind', label: agent === 'opencode' ? 'Undo last message…' : 'Rewind…', icon: <RotateCcw className="size-4" />, onSelect: actions.rewind },
              { key: 'rename', label: 'Rename…', icon: <Pencil className="size-4" />, onSelect: () => setRenaming(true) },
              { key: 'copy', label: 'Copy session ID', icon: <Copy className="size-4" />, onSelect: actions.copyId },
              def.set.clear && { key: 'clear', label: 'Clear conversation', icon: <Trash2 className="size-4" />, danger: true, onSelect: actions.clear },
              { key: 'exit', label: `Exit ${def.name}`, icon: <LogOut className="size-4" />, danger: true, onSelect: actions.exit },
            ].filter((it: any) => it && (!s.screen?.prompt || it.key === 'rename' || it.key === 'copy')) as any}
            trigger={({ toggle, ref: r }) => (
              <button ref={r} type="button" onClick={toggle} aria-label="More" className="hidden size-8 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-hover md:flex">
                <MoreHorizontal className="size-4" />
              </button>
            )}
          />
        )}
      </div>
      {ref && (
        <RenameSheet
          key={String(renaming)}
          host={ref.host.config.id}
          pane={ref.pane.id}
          current={title}
          agent={!!ref.pane.agent}
          open={renaming}
          onClose={() => setRenaming(false)}
        />
      )}
    </header>
  )
}
