import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Laptop, Plug, Plus, Search, Server, WifiOff } from 'lucide-react'
import { useStore } from '../lib/store.ts'
import { agentPanes } from '../lib/overview.ts'
import { ActivityFeed, LimitsCard, MachinesTable, NeedsYouCard, SessionCard } from '../components/Overview.tsx'
import { Logo } from '../components/AppShell.tsx'
import { Button, Empty, Segmented, SectionLabel } from '../components/ui/primitives.tsx'
import { api } from '../lib/api.ts'
import { INTEGRATION_TEXT } from '../components/session/IntegrationNote.tsx'
import { toast } from '../lib/store.ts'
import type { AgentPaneInfo } from '@tether/protocol'
import { MachineSheet } from '../components/Sheets.tsx'
import { isPhone } from '../lib/phone.ts'

/** working, or idle with shells or tasks still running */
const busy = (a: AgentPaneInfo) => a.state === 'working' || (a.state === 'idle' && !!a.background)

export function Home() {
  const hosts = useStore((s) => s.hosts)
  const loaded = useStore((s) => s.hostsLoaded)
  const connected = useStore((s) => s.connected)
  const [filter, setFilter] = useState<'all' | 'working' | 'idle'>('all')
  const [adding, setAdding] = useState(false)
  const panes = agentPanes(hosts)
  const waiting = panes.filter((r) => r.pane.agent!.state === 'waiting')
  const rest = panes.filter((r) => r.pane.agent!.state !== 'waiting').filter((r) => filter === 'all' || (filter === 'working' ? busy(r.pane.agent!) : !busy(r.pane.agent!)))
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
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur-md">
        <div className="flex h-[52px] items-center gap-3 px-4 lg:px-7">
          <span className="md:hidden">
            <Logo />
          </span>
          <h1 className="text-[15px] font-semibold tracking-tight">Overview</h1>
          <span className="hidden text-[12.5px] text-fg-3 sm:inline">
            {hosts.length} {isPhone() ? 'computer' : 'machine'}{hosts.length === 1 ? '' : 's'} · {panes.length} agent session{panes.length === 1 ? '' : 's'} · {panesTotal} pane{panesTotal === 1 ? '' : 's'}
          </span>
          {!connected && (
            <span className="ml-auto flex items-center gap-1.5 text-[12px] text-warn">
              <WifiOff className="size-3.5" /> Reconnecting
            </span>
          )}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
            aria-label="Search"
            className="ml-auto flex size-8 items-center justify-center rounded-lg text-fg-2 hover:bg-hover md:hidden"
          >
            <Search className="size-[18px]" />
          </button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1280px] flex-wrap items-start gap-7 px-4 pt-6 pb-16 lg:px-7">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-7">
          {!loaded ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton h-[150px] rounded-[16px]" />
              ))}
            </div>
          ) : !hosts.length ? (
            <div className="rounded-[16px] border border-dashed border-line-strong">
              <Empty
                icon={isPhone() ? <Laptop className="size-5" /> : <Server className="size-5" />}
                title={isPhone() ? 'Connect your computer' : 'No machines yet'}
                action={
                  <Button variant="primary" onClick={() => setAdding(true)}>
                    <Plus className="size-3.5" /> {isPhone() ? 'Add a computer' : 'Add a machine'}
                  </Button>
                }
              >
                {isPhone()
                  ? 'See the coding agents on your laptop or server and talk to them from here. Run one command on it, then scan the code it shows.'
                  : 'Pair a machine or add one over SSH to see the coding agents running in tmux on it.'}
              </Empty>
            </div>
          ) : (
            <>
              <p className="text-[14px] text-fg-2">
                {waiting.length
                  ? `${waiting.length} session${waiting.length > 1 ? 's need' : ' needs'} you.`
                  : working
                    ? `${working} session${working > 1 ? 's are' : ' is'} working.`
                    : panes.length
                      ? 'All quiet. Every session is idle.'
                      : 'No agents are running right now.'}
              </p>

              {needsIntegration.map((h) => (
                <div key={h.config.id} className="flex items-center gap-3 rounded-[14px] border border-line bg-elev px-4 py-3">
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
                  <div className="grid grid-cols-1 gap-3">
                    {waiting.map((r) => (
                      <NeedsYouCard key={r.host.config.id + r.pane.id} r={r} />
                    ))}
                  </div>
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
                {rest.length ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
                    {rest.map((r) => (
                      <SessionCard key={r.host.config.id + r.pane.id} r={r} />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-[16px] border border-dashed border-line-strong">
                    <Empty title={panes.length ? 'Nothing here' : 'No agent sessions'}>
                      {panes.length ? 'Try another filter.' : `Start Claude Code, Codex or another agent in tmux on any ${isPhone() ? 'computer' : 'machine'}, or ${isPhone() ? 'tap + ' : 'press N '}to start one from here.`}
                    </Empty>
                  </div>
                )}
              </section>

              <section>
                <SectionLabel right={<Link to="/machines" className="-my-2 px-1 py-2 text-[12px] text-fg-2 hover:text-fg">Manage</Link>}>{isPhone() ? 'Computers' : 'Machines'}</SectionLabel>
                <MachinesTable hosts={hosts} />
              </section>
            </>
          )}
        </div>
        <MachineSheet open={adding} onClose={() => setAdding(false)} />
        <aside className="flex w-full flex-[1_1_280px] flex-col gap-4 lg:max-w-[340px]">
          <LimitsCard hosts={hosts} />
          <ActivityFeed />
        </aside>
      </div>
    </div>
  )
}
