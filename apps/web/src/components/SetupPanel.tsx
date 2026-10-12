import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { Check, Copy, Download, ExternalLink, LogIn, RefreshCw, TriangleAlert } from 'lucide-react'
import { AGENTS, type AgentKind, type HostState } from '@inyon/protocol'
import { api, type SetupReport } from '../lib/api.ts'
import { toast } from '../lib/store.ts'
import { paneHref } from '../lib/overview.ts'
import { AgentLogo } from '../lib/skin.tsx'
import { Button, Spinner, Toggle } from './ui/primitives.tsx'
import { SignInSheet } from './SignInSheet.tsx'
import { copyText } from '../lib/clipboard.ts'

function CopyLine({ cmd }: { cmd: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-xl border border-line bg-code px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{cmd}</code>
      <button
        type="button"
        aria-label="Copy command"
        onClick={() => copyText(cmd).then((ok) => toast(ok ? { title: 'Command copied', tone: 'success' } : { title: 'Could not copy', body: 'Select the command and copy it by hand.', tone: 'error' }))}
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-fg-3 hover:bg-hover hover:text-fg"
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  )
}

/** Everything a machine needs for Inyon, with one-tap fixes where it's safe to run them. */
export function SetupPanel({ host }: { host: HostState }) {
  const [report, setReport] = useState<SetupReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState('')
  const [signIn, setSignIn] = useState<AgentKind | null>(null)
  const nav = useNavigate()
  const id = host.config.id

  const load = () => api.setup(id).then(setReport).catch((e) => toast({ title: 'Could not check the machine', body: e.message, tone: 'error' }))
  useEffect(() => {
    if (host.status === 'online') load()
  }, [id, host.status])

  const run = async (action: string, label: string) => {
    setBusy(action)
    setLog('')
    try {
      const r = await api.runSetup(id, action)
      if (r.pane) return nav(paneHref(id, r.pane, 'terminal'))
      setLog(r.output ?? '')
      toast({ title: r.ok ? `${label}: done` : `${label}: failed`, tone: r.ok ? 'success' : 'error' })
      await load()
    } catch (e) {
      toast({ title: label, body: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  if (host.status !== 'online') return <p className="text-[13px] text-fg-3">Setup checks run once the machine is connected.</p>
  if (!report) return <div className="flex justify-center py-10"><Spinner /></div>

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-[12.5px] text-fg-3">
        {report.os}
        {report.pkg && ` · ${report.pkg}`}
        {report.sudo ? ' · sudo available' : ' · no passwordless sudo'}
        <button type="button" onClick={load} className="ml-auto flex items-center gap-1 rounded-full px-2 py-1 hover:bg-hover hover:text-fg">
          <RefreshCw className="size-3.5" /> Re-check
        </button>
      </div>

      <section className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-elev shadow-card">
        {report.checks.map((c) => (
          <div key={c.id} className="px-4 py-3.5">
            <div className="flex items-center gap-3">
              <span className={clsx('flex size-5 shrink-0 items-center justify-center rounded-full', c.ok ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn')}>
                {c.ok ? <Check className="size-3" strokeWidth={3} /> : <TriangleAlert className="size-3" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium">{c.label}</div>
                {c.detail && <div className="truncate text-[12.5px] text-fg-3">{c.detail}</div>}
              </div>
              {c.fix && (
                <Button size="sm" variant="primary" loading={busy === c.fix.action} onClick={() => run(c.fix!.action, c.fix!.label)}>
                  {c.fix.label}
                </Button>
              )}
            </div>
            {!c.ok && !c.fix && c.manual && (
              <div className="pl-8">
                <p className="mt-1 text-[12px] text-fg-3">Run this on the machine (it needs your password):</p>
                <CopyLine cmd={c.manual} />
              </div>
            )}
          </div>
        ))}
        <div className="flex items-center gap-3 px-4 py-3.5">
          <div className="min-w-0 flex-1 pl-8">
            <div className="text-[14px] font-medium">Keep a tmux session running</div>
            <div className="text-[12.5px] text-fg-3">If every session closes, Inyon starts a fresh one called “main”.</div>
          </div>
          <Toggle on={report.keepSession} onChange={async (v) => (await api.keepSession(id, v), load())} label="Keep a tmux session running" />
        </div>
      </section>

      <section>
        <h3 className="mb-2.5 text-[13px] font-semibold">Agents</h3>
        <div className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-elev shadow-card">
          {report.agents.map((a) => {
            const def = AGENTS[a.kind]
            return (
              <div key={a.kind} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <AgentLogo kind={a.kind} size={28} />
                <div className="min-w-0 flex-[1_1_180px]">
                  <div className="text-[14px] font-medium">{def.name}</div>
                  <div className="truncate text-[12px] text-fg-3">
                    {a.installed ? `${a.version}${a.signedIn ? ' · signed in' : ' · not signed in'}` : 'Not installed'}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  {!a.installed && (
                    <Button size="sm" loading={busy === `agent:${a.kind}`} onClick={() => run(`agent:${a.kind}`, `Install ${def.name}`)}>
                      <Download className="size-3.5" /> Install
                    </Button>
                  )}
                  {a.installed && !a.signedIn && (
                    <Button size="sm" variant="primary" onClick={() => setSignIn(a.kind)}>
                      <LogIn className="size-3.5" /> Sign in
                    </Button>
                  )}
                  <a href={def.install.docs} target="_blank" rel="noreferrer" className="inline-flex size-8 items-center justify-center rounded-full text-fg-3 hover:bg-hover hover:text-fg" aria-label={`${def.name} docs`}>
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
              </div>
            )
          })}
        </div>
        <p className="mt-2 text-[12px] text-fg-3">Install uses each agent's official installer. Sign in runs the agent's own sign-in on that machine and walks you through it here.</p>
      </section>

      <SignInSheet hostId={id} hostName={host.config.name} agent={signIn} onClose={() => (setSignIn(null), load())} />
      {log && <pre className="max-h-64 overflow-auto rounded-2xl border border-line bg-code px-3 py-2.5 font-mono text-[12px] leading-relaxed text-fg-2">{log}</pre>}
    </div>
  )
}
