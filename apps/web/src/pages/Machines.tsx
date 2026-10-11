import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { AlertCircle, ChevronLeft, ChevronRight, FileCode2, HardDrive, Monitor, Pencil, Plug, Plus, RotateCcw, Save, Server, SquareTerminal, Trash2 } from 'lucide-react'
import { AGENTS, type AgentKind, type HostState } from '@tether/protocol'
import { api, type ConfigFile, type UploadUsage } from '../lib/api.ts'
import { toast, useStore } from '../lib/store.ts'
import { paneHref, paneTitle } from '../lib/overview.ts'
import { bytes, shortPath, timeAgo } from '../lib/format.ts'
import { INTEGRATION_TEXT } from '../components/session/IntegrationNote.tsx'
import { AgentLogo } from '../lib/skin.tsx'
import { Button, Empty, SectionLabel, Segmented, Spinner } from '../components/ui/primitives.tsx'
import { HostDot, StateDot, hostLine, shownState } from '../components/ui/status.tsx'
import { MachineSheet, NewSessionSheet, PairMachine } from '../components/Sheets.tsx'
import { Logo } from '../components/AppShell.tsx'
import { SetupPanel } from '../components/SetupPanel.tsx'
import { SignInSheet } from '../components/SignInSheet.tsx'
import { isPhone } from '../lib/phone.ts'
import { AgentBadges } from '../components/Overview.tsx'

function PageHeader({ title, back, right }: { title: React.ReactNode; back?: string; right?: React.ReactNode }) {
  return (
    <header className="pt-safe sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur-md">
      <div className="flex h-[52px] items-center gap-2 px-3 lg:px-7">
        {back ? (
          <Link to={back} aria-label="Back" className="inline-flex size-8 items-center justify-center rounded-lg text-fg-2 hover:bg-hover">
            <ChevronLeft className="size-5" />
          </Link>
        ) : (
          <span className="md:hidden">
            <Logo />
          </span>
        )}
        <h1 className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold tracking-tight">{title}</h1>
        {right}
      </div>
    </header>
  )
}

export function MachinesPage() {
  const hosts = useStore((s) => s.hosts)
  // a pairing link opened from outside (a QR code scanned with the camera) lands here
  const [params, setParams] = useSearchParams()
  const pairLink = params.get('pair') ?? undefined
  const [sheet, setSheet] = useState(!!pairLink)
  const close = () => {
    setSheet(false)
    if (pairLink) setParams({}, { replace: true })
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <PageHeader title="Machines" right={<Button size="sm" variant="primary" onClick={() => setSheet(true)}><Plus className="size-3.5" /> {isPhone() ? 'Add' : 'Add machine'}</Button>} />
      <div className="mx-auto max-w-[880px] space-y-3 px-4 py-6 lg:px-7">
        {hosts.map((h) => (
          <Link key={h.config.id} to={`/machines/${encodeURIComponent(h.config.id)}`} className="flex items-center gap-4 rounded-[16px] border border-line bg-elev p-4 transition-colors hover:border-line-strong">
            <span className="flex size-10 items-center justify-center rounded-[11px] border border-line bg-sunken">
              {h.config.kind === 'local' ? <Server className="size-[18px] text-fg-2" /> : <Monitor className="size-[18px] text-fg-2" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[15px] font-semibold">{h.config.name}</span>
                <HostDot status={h.status} />
              </div>
              <div className="truncate text-[12.5px] text-fg-3">
                {waitingToPair(h) ? 'Waiting for its pairing command' : hostLine(h, `${h.config.kind === 'local' ? 'This hub' : h.config.kind === 'node' ? h.hostname ?? 'Paired machine' : h.config.kind === 'link' ? h.hostname ?? 'Laptop' : h.config.target} · ${h.sessions.length} tmux session${h.sessions.length === 1 ? '' : 's'} · ${h.latencyMs ?? '?'} ms`)}
              </div>
            </div>
            {/* on a phone the address needs the room more; the server page lists the agents */}
            <span className="hidden sm:contents">
              <AgentBadges host={h} size={20} />
            </span>
            <ChevronRight className="size-4 text-fg-3" />
          </Link>
        ))}
      </div>
      <MachineSheet open={sheet} onClose={close} link={pairLink} />
    </div>
  )
}

/** A machine added with a pairing command that hasn't run it yet. */
const waitingToPair = (h: HostState) => h.config.kind === 'node' && !h.config.pairedAt && h.status !== 'online'

type Tab = 'sessions' | 'setup' | 'config' | 'uploads' | 'integration'

export function MachinePage() {
  const id = decodeURIComponent(useParams().host!)
  const host = useStore((s) => s.hosts.find((h) => h.config.id === id))
  const needsSetup = !!host && host.status === 'online' && (host.tmux !== 'ok' || !host.agents.length)
  const [tab, setTab] = useState<Tab>(needsSetup ? 'setup' : 'sessions')
  const [edit, setEdit] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const nav = useNavigate()
  if (!host) return <div className="flex flex-1 items-center justify-center"><Spinner /></div>
  const remove = async () => {
    if (!confirm(`Remove ${host.config.name}? Its tmux sessions keep running.`)) return
    try {
      await api.removeHost(host.config.id)
      nav('/machines')
    } catch (e) {
      toast({ title: 'Could not remove', body: (e as Error).message, tone: 'error' })
    }
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <PageHeader
        back="/machines"
        title={
          <span className="flex items-center gap-2">
            <HostDot status={host.status} /> {host.config.name}
          </span>
        }
        right={
          <div className="flex gap-1.5">
            {!waitingToPair(host) && <Button size="sm" onClick={() => setNewOpen(true)}><Plus className="size-3.5" /> New session</Button>}
            <Button size="sm" variant="ghost" onClick={() => setEdit(true)} aria-label="Rename or edit"><Pencil className="size-3.5" /> <span className="hidden sm:inline">{host.config.kind === 'ssh' ? 'Edit' : 'Rename'}</span></Button>
            {host.config.kind !== 'local' && <Button size="sm" variant="ghost" onClick={remove} aria-label="Remove"><Trash2 className="size-3.5" /></Button>}
          </div>
        }
      />
      <div className="mx-auto max-w-[1100px] px-4 py-5 lg:px-7">
        <p className="mb-4 text-[13px] text-fg-3">
          {host.config.kind === 'local'
            ? 'This hub'
            : host.config.kind === 'node'
              ? waitingToPair(host) ? 'Not paired yet' : `Paired machine${host.hostname ? ` · ${host.hostname}` : ''}`
              : host.config.kind === 'link'
                ? `Laptop${host.hostname ? ` · ${host.hostname}` : ''}`
                : `ssh ${host.config.target}${host.config.port ? ` -p ${host.config.port}` : ''}`}
          {host.nodeVersion && ` · tether-node ${host.nodeVersion}`}
          {host.os && ` · ${host.os}`}
          {host.latencyMs !== undefined && ` · ${host.latencyMs} ms`}
        </p>
        {host.status === 'error' && (
          <div className="mb-4 flex items-start gap-2 rounded-[12px] bg-danger-soft px-3.5 py-3 text-[13px] text-danger">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span className="break-words">{host.error}</span>
          </div>
        )}
        {waitingToPair(host) ? (
          <div className="max-w-[560px] rounded-[14px] border border-line p-4">
            <PairMachine existing={host.config.id} />
          </div>
        ) : (
        <>
        <div className="mb-5">
          <div className="no-scrollbar overflow-x-auto">
            <Segmented value={tab} onChange={setTab} options={[{ v: 'sessions', label: 'Sessions' }, { v: 'setup', label: needsSetup ? 'Setup ·' : 'Setup' }, { v: 'config', label: 'Config' }, { v: 'uploads', label: 'Uploads' }, { v: 'integration', label: 'Integration' }]} />
          </div>
        </div>
        {tab === 'sessions' && <SessionsTab host={host} />}
        {tab === 'setup' && <SetupPanel host={host} />}
        {tab === 'config' && <ConfigTab host={host} />}
        {tab === 'uploads' && <UploadsCard host={host} />}
        {tab === 'integration' && <IntegrationCard host={host} />}
        </>
        )}
      </div>
      <MachineSheet open={edit} edit={host.config} onClose={() => setEdit(false)} />
      <NewSessionSheet open={newOpen} hostId={host.config.id} onClose={() => setNewOpen(false)} />
    </div>
  )
}

function SessionsTab({ host }: { host: HostState }) {
  if (host.status !== 'online') return <Empty title="Not connected">Sessions appear once the machine is reachable.</Empty>
  if (!host.sessions.length) return <Empty icon={<SquareTerminal className="size-5" />} title="No tmux sessions">Start one with New session.</Empty>
  return (
    <div className="space-y-4">
      {host.sessions.map((s) => (
        <section key={s.id} className="overflow-hidden rounded-[16px] border border-line bg-elev">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[12.5px]">
            <span className="font-semibold">{s.name}</span>
            {s.attached > 0 && <span className="rounded-[5px] bg-sunken px-1.5 py-px text-[11px] text-fg-3">attached</span>}
            <span className="ml-auto text-fg-3">{s.windows.length} window{s.windows.length === 1 ? '' : 's'}</span>
          </div>
          {s.windows.flatMap((w) =>
            w.panes.map((p) => {
              const r = { host, session: s, window: w, pane: p }
              return (
                <Link key={p.id} to={paneHref(host.config.id, p.id)} className="flex items-center gap-3 border-b border-line/60 px-4 py-2.5 last:border-0 hover:bg-hover/50">
                  {p.agent ? <AgentLogo kind={p.agent.kind} size={20} /> : <SquareTerminal className="size-4 text-fg-3" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium">
                      <span className="mr-2 font-mono text-[11.5px] text-fg-3">{w.index}.{p.index}</span>
                      {p.agent ? paneTitle(r) : p.command}
                    </div>
                    <div className="truncate text-[11.5px] text-fg-3">{shortPath(p.cwd, 50)}</div>
                  </div>
                  {p.agent && <StateDot state={shownState(p.agent, host)} />}
                  <ChevronRight className="size-4 text-fg-3" />
                </Link>
              )
            }),
          )}
        </section>
      ))}
    </div>
  )
}

/** Agent config files on the machine: list, edit with validation, save with backup. */
function ConfigTab({ host }: { host: HostState }) {
  const [files, setFiles] = useState<ConfigFile[] | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [orig, setOrig] = useState('')
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const id = host.config.id

  useEffect(() => {
    api.configs(id).then((f) => {
      setFiles(f)
      if (!sel) setSel(f.find((x) => x.exists)?.path ?? f[0]?.path ?? null)
    }).catch((e) => toast({ title: 'Could not list config files', body: e.message, tone: 'error' }))
  }, [id])

  useEffect(() => {
    if (!sel) return
    setLoading(true)
    api.readConfig(id, sel).then((r) => (setOrig(r.content), setText(r.content))).catch((e) => toast({ title: 'Could not read', body: e.message, tone: 'error' })).finally(() => setLoading(false))
  }, [sel])

  const cur = files?.find((f) => f.path === sel)
  const jsonError = useMemo(() => {
    if (cur?.format !== 'json' || !text.trim()) return ''
    try {
      JSON.parse(text)
      return ''
    } catch (e) {
      return (e as Error).message
    }
  }, [text, cur?.format])
  const dirty = text !== orig

  const save = async () => {
    if (!sel) return
    setSaving(true)
    try {
      await api.writeConfig(id, sel, text)
      setOrig(text)
      toast({ title: 'Saved', body: 'A backup of the previous version was kept next to the file. Running sessions pick changes up after a restart.', tone: 'success' })
      api.configs(id).then(setFiles)
    } catch (e) {
      toast({ title: 'Could not save', body: (e as Error).message, tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  if (!files) return <div className="flex justify-center py-10"><Spinner /></div>
  if (!files.length) return <Empty icon={<FileCode2 className="size-5" />} title="No agent config files">Install an agent on this machine and its config files show up here.</Empty>
  const groups = [...new Set(files.map((f) => f.agent))]
  return (
    <div className="flex flex-wrap gap-4">
      <nav className="w-full shrink-0 space-y-3 md:w-[280px]">
        {groups.map((g) => (
          <div key={g}>
            <div className="mb-1 flex items-center gap-2 px-1.5 text-[12px] font-semibold">
              <AgentLogo kind={g} size={16} /> {AGENTS[g].name}
            </div>
            {files.filter((f) => f.agent === g).map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => (dirty && !confirm('Discard unsaved changes?') ? null : setSel(f.path))}
                className={clsx('flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px]', sel === f.path ? 'bg-hover' : 'hover:bg-hover/60')}
              >
                <span className={clsx('min-w-0 flex-1 truncate', !f.exists && 'text-fg-3')}>{f.label}</span>
                <span className="shrink-0 text-[11px] text-fg-3">{f.exists ? bytes(f.size) : 'new'}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="min-w-0 flex-[999_1_480px]">
        <div className="overflow-hidden rounded-[14px] border border-line bg-elev">
          <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{sel?.replace(/^\/home\/[^/]+/, '~')}</span>
            {cur?.mtime && <span className="hidden shrink-0 text-[11.5px] text-fg-3 sm:inline">changed {timeAgo(cur.mtime * 1000)}</span>}
          </div>
          {loading ? (
            <div className="flex justify-center py-16"><Spinner /></div>
          ) : (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              className="block h-[52dvh] w-full resize-none bg-code px-3.5 py-3 font-mono text-[12.5px] leading-[1.65] text-fg"
              placeholder={cur?.exists ? '' : 'This file does not exist yet. Saving creates it.'}
            />
          )}
          <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
            <span className={clsx('min-w-0 flex-1 truncate text-[12px]', jsonError ? 'text-danger' : dirty ? 'text-warn' : 'text-fg-3')}>
              {jsonError ? `Invalid JSON: ${jsonError}` : dirty ? 'Unsaved changes' : cur?.format === 'json' ? 'Valid JSON' : 'Saved'}
            </span>
            <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setText(orig)}><RotateCcw className="size-3.5" /> Discard</Button>
            <Button size="sm" variant="primary" disabled={!dirty || !!jsonError} loading={saving} onClick={save}><Save className="size-3.5" /> Save</Button>
          </div>
        </div>
        <p className="mt-2 text-[11.5px] text-fg-3">Every save keeps the previous version as a .tether-bak file next to it (the last five).</p>
      </div>
    </div>
  )
}

export function UploadsCard({ host, compact }: { host: HostState; compact?: boolean }) {
  const [usage, setUsage] = useState<UploadUsage | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    if (host.status === 'online') api.uploadUsage(host.config.id).then(setUsage).catch(() => {})
  }, [host.config.id, host.status])
  const clean = async (days: number) => {
    if (days === 0 && !confirm(`Delete every uploaded file on ${host.config.name}?`)) return
    setBusy(String(days))
    try {
      setUsage(await api.cleanUploads(host.config.id, days))
      toast({ title: 'Uploads cleaned', tone: 'success' })
    } catch (e) {
      toast({ title: 'Could not clean', body: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className={clsx('rounded-[14px] border border-line bg-elev p-4', compact && 'p-3.5')}>
      <div className="flex items-center gap-2.5">
        <HardDrive className="size-4 text-fg-3" />
        <span className="text-[13.5px] font-semibold">{host.config.name}</span>
        <span className="tabular ml-auto text-[12.5px] text-fg-2">{usage ? `${bytes(usage.bytes)} · ${usage.files} files` : host.status === 'online' ? '…' : 'offline'}</span>
      </div>
      {usage && (
        <>
          <div className="mt-1 truncate font-mono text-[11.5px] text-fg-3">{usage.dir.replace(/^\/home\/[^/]+/, '~')}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => clean(7)} loading={busy === '7'} disabled={!usage.files}>Clean older than 7 days{usage.expired ? ` (${usage.expired})` : ''}</Button>
            <Button size="sm" variant="danger" onClick={() => clean(0)} loading={busy === '0'} disabled={!usage.files}>Delete all</Button>
          </div>
        </>
      )}
    </div>
  )
}

function IntegrationCard({ host }: { host: HostState }) {
  const [busy, setBusy] = useState(false)
  const [signIn, setSignIn] = useState<AgentKind | null>(null)
  const on = host.integration === 'installed'
  const toggle = async () => {
    setBusy(true)
    try {
      await api.integration(host.config.id, !on)
      toast({ title: on ? 'Integration turned off' : 'Integration on', body: on ? undefined : 'Restart running Claude sessions to pick it up.', tone: 'success' })
    } catch (e) {
      toast({ title: 'Failed', body: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="max-w-2xl space-y-4">
      <div className="rounded-[16px] border border-line bg-elev p-5">
        <div className="flex items-center gap-3">
          <Plug className={clsx('size-5', on ? 'text-ok' : 'text-fg-3')} />
          <div className="flex-1">
            <div className="text-[15px] font-semibold">Claude Code integration</div>
            <div className="text-[12.5px] text-fg-3">{on ? 'On' : host.integration === 'missing' ? 'Off' : host.integration === 'unknown' ? 'Unknown' : INTEGRATION_TEXT[host.integration]}</div>
          </div>
          <Button variant={on ? 'danger' : 'primary'} onClick={toggle} loading={busy} disabled={host.status !== 'online'}>
            {on ? 'Turn off' : host.integration === 'outdated' ? 'Update' : 'Turn on'}
          </Button>
        </div>
        <ul className="mt-4 space-y-2 text-[13px] leading-relaxed text-fg-2">
          <li>• Adds a tiny hook that records which tmux pane runs which session, for exact matching and instant updates.</li>
          <li>• Wraps your status line so Tether sees model, effort, context window, cost and 5-hour/weekly limits. Your status line still shows exactly as before.</li>
          <li>• Backs up <span className="font-mono text-[12px]">~/.claude/settings.json</span> first. Turning it off restores your original status line.</li>
        </ul>
      </div>
      <SectionLabel>Agents installed on this machine</SectionLabel>
      <div className="flex flex-wrap gap-2">
        {host.agents.length ? host.agents.map((k) => {
          const signedIn = host.signedIn?.includes(k)
          return (
            <span key={k} className="flex items-center gap-2 rounded-[10px] border border-line bg-elev py-1.5 pr-1.5 pl-3 text-[13px]">
              <AgentLogo kind={k} size={18} /> {AGENTS[k].name}
              {host.signedIn && (signedIn ? (
                <span className="pr-1.5 text-[12px] text-fg-3">· signed in</span>
              ) : (
                <Button size="xs" variant="primary" onClick={() => setSignIn(k)} disabled={host.status !== 'online'}>Sign in</Button>
              ))}
            </span>
          )
        }) : <span className="text-[13px] text-fg-3">None on PATH</span>}
      </div>
      <SignInSheet hostId={host.config.id} hostName={host.config.name} agent={signIn} onClose={() => setSignIn(null)} />
    </div>
  )
}
