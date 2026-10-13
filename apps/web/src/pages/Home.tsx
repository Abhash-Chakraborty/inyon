import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Link } from 'react-router-dom'
import { ChevronRight, Laptop, Plug, Plus, Search, Server, WifiOff } from 'lucide-react'
import { useStore } from '../lib/store.ts'
import { agentPanes } from '../lib/overview.ts'
import { ActivityFeed, LimitsCard, MachinesTable, NeedsYouCard, SessionCard } from '../components/Overview.tsx'
import { Logo } from '../components/AppShell.tsx'
import { Button, Empty, Segmented, SectionLabel } from '../components/ui/primitives.tsx'
import { api } from '../lib/api.ts'
import { INTEGRATION_TEXT } from '../components/session/IntegrationNote.tsx'
import { toast } from '../lib/store.ts'
import type { AgentPaneInfo } from '@inyon/protocol'
import { MachineSheet } from '../components/Sheets.tsx'
import { isPhone } from '../lib/phone.ts'
import { isHosted } from '../lib/base.ts'
import { InstallCard } from '../components/InstallCard.tsx'
import { PullRefresh } from '../components/ui/PullRefresh.tsx'
import { refreshAll } from '../lib/refresh.ts'
import { groupPanes, loadFolded, saveFolded } from '../lib/groups.ts'
import { FilterInput } from '../components/ui/FilterInput.tsx'
import { AnimatedList } from '../components/ui/AnimatedList.tsx'
import { MachineIcon, machineKindOf } from '../components/ui/MachineIcon.tsx'

/** Past this many agent sessions the overview gets a search box. */
const SEARCH_FROM = 6

/** working, or idle with shells or tasks still running */
const busy = (a: AgentPaneInfo) => a.state === 'working' || (a.state === 'idle' && !!a.background)

export function Home() {
  const hosts = useStore((s) => s.hosts)
  const loaded = useStore((s) => s.hostsLoaded)
  const connected = useStore((s) => s.connected)
  const [filter, setFilter] = useState<'all' | 'working' | 'idle'>('all')
  const [adding, setAdding] = useState(false)
  const [reloading, setReloading] = useState(false)
  const reload = () => {
    setReloading(true)
    // long enough to see the turn, however fast the hub answers
    Promise.allSettled([refreshAll(), new Promise((r) => setTimeout(r, 600))]).then(() => setReloading(false))
  }
  const panes = agentPanes(hosts)
  const waiting = panes.filter((r) => r.pane.agent!.state === 'waiting')
  const [q, setQ] = useState('')
  const [folded, setFolded] = useState(loadFolded)
  const toggle = (key: string) =>
    setFolded((f) => {
      const n = new Set(f)
      const k = `home:${key}`
      if (n.has(k)) n.delete(k)
      else n.add(k)
      saveFolded(n)
      return n
    })
  // the cards below "Needs you", grouped by machine; a search looks through every machine
  const groups = useMemo(
    () => groupPanes(hosts, { query: q, keep: (r) => !!r.pane.agent && r.pane.agent.state !== 'waiting' && (filter === 'all' || (filter === 'working' ? busy(r.pane.agent) : !busy(r.pane.agent))) }),
    [hosts, q, filter],
  )
  const homeFolded = useMemo(() => new Set([...folded].filter((k) => k.startsWith('home:')).map((k) => k.slice(5))), [folded])
  const working = panes.filter((r) => busy(r.pane.agent!)).length
  const needsIntegration = hosts.filter((h) => h.status === 'online' && (h.integration === 'missing' || h.integration === 'removed' || h.integration === 'outdated') && h.agents.includes('claude'))
  const panesTotal = hosts.reduce((n, h) => n + h.sessions.reduce((m, s) => m + s.windows.reduce((k, w) => k + w.panes.length, 0), 0), 0)

  const enable = async (id: string) => {
    try {
      await api.integration(id, true)
      toast({ title: 'Claude integration on', body: 'Restart running Claude sessions to get live limits and exact matching.', tone: 'success' })
    } catch (e) {
      toast({ title: 'Could not enable', body: (e as Error).message, tone: 'error' })
    }
  }

  return (
    <PullRefresh onRefresh={refreshAll} className="min-h-0 flex-1 overflow-y-auto">
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-bg">
        <div className="flex h-[52px] items-center gap-3 px-4 lg:px-8">
          <span className="md:hidden">
            <Logo />
          </span>
          <span className="font-mono text-[12px] text-fg-3 max-md:hidden">
            {hosts.length} {isPhone() ? 'computer' : 'machine'}{hosts.length === 1 ? '' : 's'} · {panes.length} agent session{panes.length === 1 ? '' : 's'} · {panesTotal} pane{panesTotal === 1 ? '' : 's'}
          </span>
          {!connected && (
            <span className="ml-auto flex items-center gap-1.5 text-[12px] text-warn">
              <WifiOff className="size-3.5" /> Reconnecting
            </span>
          )}
          {/* with a mouse there is no pull to refresh: the mark turns once here instead */}
          <button
            type="button"
            onClick={reload}
            aria-label="Refresh"
            title="Refresh"
            className={clsx('flex size-8 items-center justify-center rounded-full text-fg-2 hover:bg-hover max-md:hidden', connected && 'ml-auto')}
          >
            <span className={clsx('flex', reloading && 'turn-once')}>
              <Logo className="size-[18px]" />
            </span>
          </button>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
            aria-label="Search"
            className="ml-auto flex size-8 items-center justify-center rounded-full text-fg-2 hover:bg-hover relative after:absolute after:-inset-1 md:hidden"
          >
            <Search className="size-[18px]" />
          </button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1280px] flex-wrap items-start gap-8 px-4 pt-4 pb-16 md:pt-8 lg:px-8 lg:pt-12">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5 md:gap-9">
          {!loaded ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton h-[170px] rounded-3xl" />
              ))}
            </div>
          ) : !hosts.length ? (
            <div className="rounded-3xl border border-dashed border-line-strong">
              <Empty
                icon={isPhone() ? <Laptop className="size-5" /> : <Server className="size-5" />}
                title={isPhone() ? 'Connect your computer' : 'No machines yet'}
                action={
                  <Button variant="primary" onClick={() => setAdding(true)}>
                    <Plus className="size-3.5" /> {isPhone() ? 'Add a computer' : 'Add a machine'}
                  </Button>
                }
              >
                {isHosted()
                  ? 'See the coding agents on your laptop or server and talk to them from here. Run one command on it, then scan the code it shows with your phone\u2019s camera, or type it here.'
                  : isPhone()
                  ? 'See the coding agents on your laptop or server and talk to them from here. Run one command on it, then scan the code it shows.'
                  : 'Pair a machine or add one over SSH to see the coding agents running in tmux on it.'}
              </Empty>
            </div>
          ) : (
            <>
              {isHosted() && <InstallCard />}
              <div>
              <h1 className="text-[1.75rem] leading-[0.95] font-semibold tracking-[-0.04em] md:text-[44px] md:tracking-[-0.045em]">Overview</h1>
              <p className="mt-1.5 truncate text-[14px] text-fg-2 md:mt-3 md:text-[15px]">
                {waiting.length
                  ? `${waiting.length} session${waiting.length > 1 ? 's need' : ' needs'} you.`
                  : working
                    ? `${working} session${working > 1 ? 's are' : ' is'} working.`
                    : panes.length
                      ? 'All quiet. Every session is idle.'
                      : 'No agents are running right now.'}
              </p>
              </div>

              {needsIntegration.map((h) => (
                <div key={h.config.id} className="flex items-center gap-3 rounded-3xl border border-line bg-elev px-5 py-3.5 shadow-card">
                  <Plug className="size-4 shrink-0 text-fg-3" />
                  <p className="min-w-0 flex-1 text-[13px] text-fg-2">
                    <span className="font-medium text-fg">{h.config.name}:</span>{' '}
                    {h.integration === 'missing' ? 'turn on the integration for live usage limits, context and cost, instant updates and exact session matching.' : INTEGRATION_TEXT[h.integration]}
                  </p>
                  <Button size="sm" variant="primary" onClick={() => enable(h.config.id)}>
                    {h.integration === 'outdated' ? 'Update' : 'Turn on'}
                  </Button>
                </div>
              ))}

              {waiting.length > 0 && (
                <section>
                  <SectionLabel>
                    <span className="flex items-center gap-2">
                      <span className="size-1.5 rounded-full bg-warn" /> Needs you
                    </span>
                  </SectionLabel>
                  <AnimatedList className="grid grid-cols-1 gap-3" items={waiting.map((r) => ({ key: r.host.config.id + r.pane.id, node: <NeedsYouCard r={r} /> }))} />
                </section>
              )}

              <section>
                <SectionLabel
                  right={
                    panes.length > 3 && (
                      <Segmented
                        size="sm"
                        value={filter}
                        onChange={setFilter}
                        options={[
                          { v: 'all', label: 'All' },
                          { v: 'working', label: 'Working' },
                          { v: 'idle', label: 'Idle' },
                        ]}
                      />
                    )
                  }
                >
                  Agent sessions
                </SectionLabel>
                {panes.length > SEARCH_FROM && <FilterInput value={q} onChange={setQ} placeholder={`Search ${panes.length} sessions`} className="mb-3" />}
                {groups.length ? (
                  hosts.length > 1 ? (
                    <div className="flex flex-col gap-2">
                      {groups.map((g) => {
                        const open = !!q || !homeFolded.has(g.key)
                        return (
                          <div key={g.key}>
                            <button type="button" onClick={() => toggle(g.key)} aria-expanded={open} className="-mx-2 flex h-10 w-[calc(100%+1rem)] items-center gap-2 rounded-full px-2 text-left hover:bg-hover/60">
                              <ChevronRight className={clsx('size-4 shrink-0 text-fg-3 transition-transform duration-200', open && 'rotate-90')} />
                              <MachineIcon kind={machineKindOf(g.host)} size={16} className={clsx('shrink-0', g.host.status === 'online' ? 'text-fg-2' : 'text-fg-3')} />
                              <span className={clsx('truncate text-[14px] font-medium', g.host.status !== 'online' && 'text-fg-2')}>{g.host.config.name}</span>
                              {g.host.status !== 'online' && <span className="shrink-0 text-[12px] text-fg-3">{g.host.status === 'error' ? 'Offline' : 'Connecting'}</span>}
                              <span className="tabular ml-auto shrink-0 font-mono text-[12px] text-fg-3">{g.panes}</span>
                            </button>
                            <div className="expand" data-open={open}>
                              <div inert={!open}>
                                <AnimatedList
                                  className="grid grid-cols-1 gap-3 pt-2 pb-3 sm:grid-cols-[repeat(auto-fill,minmax(300px,1fr))] sm:gap-4"
                                  items={g.sessions.flatMap((sg) => sg.panes).map((r) => ({ key: r.host.config.id + r.pane.id, node: <SessionCard r={r} showHost={false} /> }))}
                                />
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <AnimatedList
                      className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(300px,1fr))] sm:gap-4"
                      items={groups.flatMap((g) => g.sessions.flatMap((sg) => sg.panes)).map((r) => ({ key: r.host.config.id + r.pane.id, node: <SessionCard r={r} /> }))}
                    />
                  )
                ) : (
                  <div className="rounded-3xl border border-dashed border-line-strong">
                    <Empty title={panes.length ? 'Nothing here' : 'No agent sessions'}>
                      {panes.length ? (q ? `No session matches “${q}”.` : 'Try another filter.') : `Start Claude Code, Codex or another agent in tmux on any ${isPhone() ? 'computer' : 'machine'}, or ${isPhone() ? 'tap + ' : 'press N '}to start one from here.`}
                    </Empty>
                  </div>
                )}
              </section>

              <section>
                <SectionLabel right={<Link to="/machines" className="-my-2 px-1 py-2 text-[13px] text-fg-2 hover:text-fg">Manage →</Link>}>{isPhone() ? 'Computers' : 'Machines'}</SectionLabel>
                <MachinesTable hosts={hosts} />
              </section>
            </>
          )}
        </div>
        <MachineSheet open={adding} onClose={() => setAdding(false)} />
        <aside className="flex w-full flex-[1_1_280px] flex-col gap-4 lg:max-w-[340px] lg:pt-[92px]">
          <LimitsCard hosts={hosts} />
          <ActivityFeed />
        </aside>
      </div>
    </PullRefresh>
  )
}
