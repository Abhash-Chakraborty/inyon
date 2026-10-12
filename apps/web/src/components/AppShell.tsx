import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { LayoutGrid, Monitor, Plus, Search, Settings, SquareTerminal, WifiOff } from 'lucide-react'
import { useStore } from '../lib/store.ts'
import { agentPanes, allPanes, paneHref, paneTitle, terminalName } from '../lib/overview.ts'
import { AgentLogo } from '../lib/skin.tsx'
import { HostDot, StateDot, shownState } from './ui/status.tsx'
import { MachineSheet, NewSessionSheet } from './Sheets.tsx'
import { isPhone } from '../lib/phone.ts'
import { Spinner } from './ui/primitives.tsx'

// the phone app connects to servers itself; the hub talks about its machines
const machinesLabel = isPhone() ? 'Computers' : 'Machines'

/** Inyon's mark: a Korean shield kite on its line (same art as public/icon.svg). The tile lifts a step on graphite. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={clsx('shrink-0', className ?? 'size-[26px]')} aria-hidden>
      <path d={SQUIRCLE} fill="var(--logo-tile)" />
      <path d={SQUIRCLE} transform="translate(.5 .5) scale(.984)" fill="none" stroke="#fff" strokeOpacity=".08" />
      <g fill="#F1F0EC">
        <path transform="rotate(-12 41 23)" fillRule="evenodd" d="M33.5 9H48.5A3.5 3.5 0 0 1 52 12.5V33.5A3.5 3.5 0 0 1 48.5 37H33.5A3.5 3.5 0 0 1 30 33.5V12.5A3.5 3.5 0 0 1 33.5 9ZM41 18.4A4.6 4.6 0 1 0 41 27.6A4.6 4.6 0 1 0 41 18.4Z" />
        <path d="M38.5 36.5C35 48 25 42 17.5 49.5" fill="none" stroke="#F1F0EC" strokeWidth="3.8" strokeLinecap="round" />
        <circle cx="15.5" cy="51" r="4" />
      </g>
    </svg>
  )
}
const SQUIRCLE = 'M25 0H39C60 0 64 4 64 25V39C64 60 60 64 39 64H25C4 64 0 60 0 39V25C0 4 4 0 25 0Z'

/** Quick switcher: type to jump to any session, terminal or machine. */
function QuickSwitch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const hosts = useStore((s) => s.hosts)
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const items = useMemo(() => {
    const panes = allPanes(hosts).map((r) => ({
      key: r.host.config.id + r.pane.id,
      label: r.pane.agent ? paneTitle(r) : `${terminalName(r) ?? `${r.session.name}:${r.window.index}`} ${r.pane.command}`,
      sub: `${r.host.config.name} · ${r.pane.cwd.replace(/^\/home\/[^/]+/, '~')}`,
      agent: r.pane.agent?.kind,
      terminal: !r.pane.agent,
      href: paneHref(r.host.config.id, r.pane.id),
    }))
    const t = q.toLowerCase()
    return panes.filter((p) => !t || `${p.label} ${p.sub}`.toLowerCase().includes(t)).slice(0, 12)
  }, [hosts, q])
  useEffect(() => {
    if (open) {
      setQ('')
      setI(0)
      setTimeout(() => input.current?.focus(), 10)
    }
  }, [open])
  if (!open) return null
  const go = (href: string) => {
    nav(href)
    onClose()
  }
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/45 px-4 pt-[12vh]" onClick={onClose}>
      <div className="animate-pop w-full max-w-lg overflow-hidden rounded-3xl border border-line bg-elev shadow-float" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="size-4 text-fg-3" />
          <input
            ref={input}
            value={q}
            onChange={(e) => (setQ(e.target.value), setI(0))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') (e.preventDefault(), setI((n) => Math.min(items.length - 1, n + 1)))
              if (e.key === 'ArrowUp') (e.preventDefault(), setI((n) => Math.max(0, n - 1)))
              if (e.key === 'Enter' && items[i]) go(items[i].href)
            }}
            placeholder="Jump to a session or terminal…"
            className="h-12 flex-1 bg-transparent text-[15px] placeholder:text-fg-3"
          />
          <kbd className="rounded-full border border-line px-1.5 font-mono text-[12px] text-fg-3 pointer-coarse:hidden">esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {items.map((it, n) => (
            <button key={it.key} type="button" onMouseEnter={() => setI(n)} onClick={() => go(it.href)} className={clsx('flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left', n === i && 'bg-hover')}>
              {it.terminal ? <AgentLogo size={22} /> : <AgentLogo kind={it.agent} size={22} />}
              <div className="min-w-0">
                <div className="truncate text-[13.5px] font-medium">{it.label}</div>
                <div className="truncate text-[12px] text-fg-3">{it.sub}</div>
              </div>
            </button>
          ))}
          {!items.length && <div className="px-3 py-6 text-center text-[13px] text-fg-3">Nothing matches</div>}
        </div>
      </div>
    </div>
  )
}

function Sidebar({ onNew, onSearch }: { onNew: () => void; onSearch: () => void }) {
  const hosts = useStore((s) => s.hosts)
  const connected = useStore((s) => s.connected)
  const loc = useLocation()
  const agents = agentPanes(hosts)
  const terminals = allPanes(hosts).filter((r) => !r.pane.agent)
  const item = (active: boolean) =>
    clsx(
      'relative flex h-9 items-center gap-2.5 rounded-full px-3 text-[13.5px] transition-colors',
      active
        ? 'bg-elev font-medium text-fg shadow-card ring-1 ring-line'
        : 'text-fg-2 hover:bg-hover/70 hover:text-fg',
    )

  return (
    <aside className="hidden w-[240px] shrink-0 flex-col border-r border-line bg-sidebar md:flex lg:w-[264px]">
      <div className="flex h-[60px] items-center gap-2.5 px-5">
        <Logo />
        <span className="text-[17px] font-semibold tracking-[-0.04em]">Inyon</span>
        {!connected && <WifiOff className="ml-auto size-4 text-warn" aria-label="Reconnecting" />}
      </div>
      <div className="space-y-1 px-3">
        <button type="button" onClick={onSearch} className="mb-2 flex h-9 w-full items-center gap-2 rounded-full border border-line bg-elev px-3 text-[13px] text-fg-3 shadow-card hover:border-line-strong">
          <Search className="size-3.5" />
          Search or jump to…
          <kbd className="ml-auto rounded-full border border-line px-2 font-mono text-[12px]">⌘K</kbd>
        </button>
        <button type="button" onClick={onNew} className={item(false)}>
          <Plus className="size-4" /> New session
          <kbd className="ml-auto font-mono text-[12px] text-fg-3">N</kbd>
        </button>
        <NavLink to="/" end className={({ isActive }) => item(isActive)}>
          <LayoutGrid className="size-4" /> Overview
        </NavLink>
        <NavLink to="/machines" className={({ isActive }) => item(isActive)}>
          <Monitor className="size-4" /> {machinesLabel}
        </NavLink>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {agents.length > 0 && (
          <>
            <div className="px-3 pt-6 pb-2 text-[12px] font-medium text-fg-3">Sessions</div>
            {agents.map((r) => {
              const href = paneHref(r.host.config.id, r.pane.id)
              return (
                <Link key={`${r.host.config.id}${r.pane.id}`} to={href} className={item(loc.pathname === href)}>
                  <AgentLogo kind={r.pane.agent!.kind} size={17} active={r.pane.agent!.state === 'working'} />
                  <span className="min-w-0 flex-1 truncate">{paneTitle(r)}</span>
                  <StateDot state={shownState(r.pane.agent!, r.host)} />
                </Link>
              )
            })}
          </>
        )}
        {terminals.length > 0 && (
          <>
            <div className="px-3 pt-6 pb-2 text-[12px] font-medium text-fg-3">Terminals</div>
            {terminals.map((r) => {
              const href = paneHref(r.host.config.id, r.pane.id)
              return (
                <Link key={`${r.host.config.id}${r.pane.id}`} to={href} className={item(loc.pathname === href)}>
                  <SquareTerminal className="size-4 shrink-0 text-fg-3" />
                  <span className="min-w-0 flex-1 truncate">
                    {terminalName(r) ?? `${r.session.name}:${r.window.index}`} <span className="text-fg-3">{r.pane.command}</span>
                  </span>
                </Link>
              )
            })}
          </>
        )}
      </nav>
      <div className="space-y-1 border-t border-line p-3">
        <NavLink to="/settings" className={({ isActive }) => item(isActive)}>
          <Settings className="size-4" /> Settings
        </NavLink>
        <Link to="/machines" className="flex min-w-0 items-center gap-2 overflow-hidden px-3 pt-1.5 font-mono text-[12px] text-fg-3 hover:text-fg-2">
          {hosts.slice(0, 3).map((h) => (
            <span key={h.config.id} className="flex min-w-0 items-center gap-1" title={`${h.config.name}: ${h.status}`}>
              <HostDot status={h.status} />
              <span className="max-w-[64px] truncate">{h.config.name}</span>
            </span>
          ))}
          {hosts.length > 3 && <span className="shrink-0">+{hosts.length - 3}</span>}
        </Link>
      </div>
    </aside>
  )
}

function TabBar({ onNew }: { onNew: () => void }) {
  const waiting = useStore((s) => agentPanes(s.hosts).filter((r) => r.pane.agent!.state === 'waiting').length)
  const tab = ({ isActive }: { isActive: boolean }) => clsx('flex flex-col items-center gap-0.5 py-1.5 text-[12px] font-medium', isActive ? 'text-fg' : 'text-fg-3')
  return (
    <nav className="pb-safe grid shrink-0 grid-cols-4 items-center border-t border-line bg-bg px-2 pt-1 md:hidden">
      <NavLink to="/" end className={tab}>
        <span className="relative">
          <LayoutGrid className="size-[21px]" />
          {waiting > 0 && <span className="absolute -top-1 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1 text-[12px] leading-none font-semibold text-black">{waiting}</span>}
        </span>
        Overview
      </NavLink>
      <button type="button" onClick={onNew} aria-label="New session" className="flex justify-center">
        <span className="press flex h-10 w-14 items-center justify-center rounded-full bg-fg text-bg">
          <Plus className="size-5" strokeWidth={2.4} />
        </span>
      </button>
      <NavLink to="/machines" className={tab}>
        <Monitor className="size-[21px]" />
        {machinesLabel}
      </NavLink>
      <NavLink to="/settings" className={tab}>
        <Settings className="size-[21px]" />
        Settings
      </NavLink>
    </nav>
  )
}

/**
 * Which page is showing, for the page-in animation. Sessions share one key: moving between them, or
 * between a session's chat and terminal, keeps the page mounted (and its scroll and state).
 */
export const pageKey = (path: string) => (path.startsWith('/m/') ? 'session' : path.replace(/\/+$/, '') || '/')

export function AppShell() {
  const [newOpen, setNewOpen] = useState(false)
  const [search, setSearch] = useState(false)
  const loc = useLocation()
  const inSession = /\/p\//.test(loc.pathname)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable || (e.target as HTMLElement)?.closest?.('.xterm')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearch(true)
      } else if (!typing && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'n') {
        setNewOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const online = useStore((s) => s.hosts.some((h) => h.status === 'online'))

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar onNew={() => setNewOpen(true)} onSearch={() => setSearch(true)} />
      <main className="flex min-w-0 flex-1 flex-col">
        {/* each page settles in: a short fade and an 8px rise */}
        <div key={pageKey(loc.pathname)} className="animate-page flex min-h-0 flex-1 flex-col">
          <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner className="size-5" /></div>}>
            <Outlet />
          </Suspense>
        </div>
        {!inSession && <TabBar onNew={() => setNewOpen(true)} />}
      </main>
      {/* nothing to start a session on yet: + adds a machine instead of an empty form */}
      {online ? <NewSessionSheet open={newOpen} onClose={() => setNewOpen(false)} /> : <MachineSheet open={newOpen} onClose={() => setNewOpen(false)} />}
      <QuickSwitch open={search} onClose={() => setSearch(false)} />
    </div>
  )
}
