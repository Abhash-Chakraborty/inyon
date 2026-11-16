import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { FolderOpen, History, Play, Search } from 'lucide-react'
import type { ConversationSearchMachine, HostState } from '@inyon/protocol'
import { useStore, toast } from '../lib/store.ts'
import { allPanes, paneHref, paneTitle, terminalName } from '../lib/overview.ts'
import { AgentLogo } from '../lib/skin.tsx'
import { shortPath, timeAgo } from '../lib/format.ts'
import { LEAVE_MS } from './ui/AnimatedList.tsx'
import { Button, Pulse, Segmented } from './ui/primitives.tsx'
import { canResume, flatHits, highlight, MIN_QUERY, openFolder, resumeHit, useConversationSearch, type FoundConversation } from '../lib/conversationSearch.ts'

type Mode = 'sessions' | 'conversations'

const NO_HOSTS: HostState[] = []
const keyOf = (h: FoundConversation) => `${h.host} ${h.agent} ${h.id}`

/**
 * Quick access: type to jump to any session, terminal or machine, or (from 0.28) to find a saved
 * conversation on any machine by what was said in it.
 */
export function QuickSwitch({ open, onClose }: { open: boolean; onClose: () => void }) {
  // it stays a moment after closing, fading out, as a sheet does
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (open) return setShown(true)
    const t = setTimeout(() => setShown(false), LEAVE_MS)
    return () => clearTimeout(t)
  }, [open])
  // closed, it has nothing to do with an overview update
  const hosts = useStore((s) => (shown ? s.hosts : NO_HOSTS))
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const [mode, setMode] = useState<Mode>('sessions')
  // the conversation whose actions are showing, and the one being opened
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState<'resume' | 'folder' | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
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
  const { state, now } = useConversationSearch(q, open && mode === 'conversations')
  const machines: ConversationSearchMachine[] = (state.status === 'done' || state.status === 'searching' ? state.machines : undefined) ?? []
  const hits = useMemo(() => flatHits(machines), [machines])
  // in Sessions, words long enough to search for offer the other tab as the last row
  const offer = mode === 'sessions' && [...q.trim()].length >= MIN_QUERY
  const count = mode === 'sessions' ? items.length + (offer ? 1 : 0) : hits.length

  useEffect(() => {
    if (open) {
      setQ('')
      setI(0)
      setMode('sessions')
      setPicked(null)
      setTimeout(() => input.current?.focus(), 10)
    }
  }, [open])
  // the row moved to stays in view
  useEffect(() => {
    list.current?.querySelector('[data-active]')?.scrollIntoView?.({ block: 'nearest' })
  }, [i, picked])
  if (!shown) return null

  const go = (href: string) => {
    nav(href)
    onClose()
  }
  const switchTo = (m: Mode) => {
    setMode(m)
    setI(0)
    setPicked(null)
    input.current?.focus()
  }
  const act = async (h: FoundConversation, what: 'resume' | 'folder') => {
    if (busy) return
    setBusy(what)
    try {
      const pane = what === 'resume' ? await resumeHit(h) : await openFolder(h)
      go(paneHref(h.host, pane, what === 'folder' ? 'terminal' : undefined))
    } catch (e) {
      toast({ title: what === 'resume' ? 'Could not resume it' : 'Could not open the folder', body: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(null)
    }
  }
  const enter = () => {
    if (mode === 'sessions') {
      if (items[i]) go(items[i].href)
      else if (offer && i === items.length) switchTo('conversations')
      return
    }
    const h = hits[i]
    if (!h) return now()
    if (picked !== keyOf(h)) return setPicked(keyOf(h))
    if (canResume(h)) void act(h, 'resume')
  }

  return (
    <div className={clsx('fixed inset-0 z-[80] flex items-start justify-center bg-black/45 px-4 pt-[12vh]', open ? 'animate-fade-in' : 'animate-fade-out')} onClick={onClose}>
      <div
        role="dialog"
        aria-label="Quick access"
        className={clsx('w-full max-w-lg overflow-hidden rounded-3xl border border-line bg-elev shadow-float', open ? 'animate-pop' : 'animate-fade-out')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="size-4 text-fg-3" />
          <input
            ref={input}
            value={q}
            aria-label={mode === 'sessions' ? 'Jump to a session or terminal' : 'Search past conversations'}
            onChange={(e) => (setQ(e.target.value), setI(0), setPicked(null))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                if (picked) setPicked(null)
                else onClose()
              }
              if (e.key === 'ArrowDown') (e.preventDefault(), setI((n) => Math.min(count - 1, n + 1)), setPicked(null))
              if (e.key === 'ArrowUp') (e.preventDefault(), setI((n) => Math.max(0, n - 1)), setPicked(null))
              if (e.key === 'Enter') (e.preventDefault(), enter())
            }}
            placeholder={mode === 'sessions' ? 'Jump to a session or terminal…' : 'Search what was said in past conversations…'}
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-fg-3"
          />
          <kbd className="rounded-full border border-line px-1.5 font-mono text-[12px] text-fg-3 pointer-coarse:hidden">esc</kbd>
        </div>
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Segmented size="sm" label="Search" value={mode} onChange={switchTo} options={[{ v: 'sessions', label: 'Sessions' }, { v: 'conversations', label: 'Conversations' }]} />
          {mode === 'conversations' && state.status === 'searching' && (
            <span role="status" className="ml-auto flex items-center gap-2 text-[12px] text-fg-3">
              <Pulse /> Searching
            </span>
          )}
        </div>
        <div ref={list} className="max-h-[50vh] overflow-y-auto p-1.5">
          {mode === 'sessions' ? (
            <>
              {items.map((it, n) => (
                <button key={it.key} type="button" data-active={n === i || undefined} onMouseEnter={() => setI(n)} onClick={() => go(it.href)} className={clsx('flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left', n === i && 'bg-hover')}>
                  {it.terminal ? <AgentLogo size={22} /> : <AgentLogo kind={it.agent} size={22} />}
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-medium">{it.label}</div>
                    <div className="truncate text-[12px] text-fg-3">{it.sub}</div>
                  </div>
                </button>
              ))}
              {offer && (
                <button type="button" data-active={i === items.length || undefined} onMouseEnter={() => setI(items.length)} onClick={() => switchTo('conversations')} className={clsx('flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left', i === items.length && 'bg-hover')}>
                  <span className="flex size-[22px] shrink-0 items-center justify-center text-fg-3">
                    <History className="size-4" />
                  </span>
                  <span className="min-w-0 truncate text-[13.5px]">
                    Search past conversations for <span className="font-medium">“{q.trim()}”</span>
                  </span>
                </button>
              )}
              {!items.length && !offer && <div className="px-3 py-6 text-center text-[13px] text-fg-3">Nothing matches</div>}
            </>
          ) : (
            <Conversations machines={machines} q={state.q} state={state.status} error={state.status === 'failed' ? state.error : undefined} active={i} picked={picked} busy={busy} onHover={(n) => setI(n)} onPick={(h, n) => (setI(n), setPicked(picked === keyOf(h) ? null : keyOf(h)))} onAct={act} />
          )}
        </div>
      </div>
    </div>
  )
}

function Conversations({
  machines,
  q,
  state,
  error,
  active,
  picked,
  busy,
  onHover,
  onPick,
  onAct,
}: {
  machines: ConversationSearchMachine[]
  q: string
  state: 'idle' | 'short' | 'searching' | 'done' | 'failed'
  error?: string
  active: number
  picked: string | null
  busy: 'resume' | 'folder' | null
  onHover: (n: number) => void
  onPick: (h: FoundConversation, n: number) => void
  onAct: (h: FoundConversation, what: 'resume' | 'folder') => void
}) {
  const note = (text: string) => <div className="px-3 py-6 text-center text-[13px] text-fg-3">{text}</div>
  if (state === 'idle') return note('Find a past conversation on any machine by what was said in it.')
  if (state === 'short') return note(`Type at least ${MIN_QUERY} characters.`)
  if (state === 'failed') return note(`Couldn't search: ${error}`)
  if (state === 'searching' && !machines.length) return note('Searching every machine…')
  const found = machines.some((m) => m.hits.length)
  const skipped = machines.filter((m) => m.skipped)
  let n = -1
  return (
    <>
      {!found && state === 'done' && note(`No conversation mentions “${q}”.`)}
      {machines
        .filter((m) => m.hits.length || m.error)
        .map((m) => (
          <section key={m.host} aria-label={m.name} className="pb-1">
            <h3 className="flex items-center gap-2 px-3 pt-2 pb-1 font-mono text-[12px] text-fg-3">
              <span className="truncate">{m.name}</span>
              {m.hits.length > 0 && <span className="tabular">{m.more ? `${m.hits.length}+` : m.hits.length}</span>}
            </h3>
            {m.error && <p className="px-3 pb-2 text-[12.5px] text-fg-3">Couldn't search here: {m.error}</p>}
            {m.hits.map((hit) => {
              const h: FoundConversation = { ...hit, host: m.host, machine: m.name }
              const at = ++n
              const open = picked === keyOf(h)
              return (
                <div key={keyOf(h)} data-active={at === active || undefined} className={clsx('rounded-2xl', (at === active || open) && 'bg-hover')}>
                  <button type="button" aria-expanded={open} onMouseEnter={() => onHover(at)} onClick={() => onPick(h, at)} className="flex w-full items-start gap-3 px-3 py-2 text-left">
                    <AgentLogo kind={h.agent} size={22} className="mt-px" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 truncate text-[13.5px] font-medium">{h.title}</span>
                        <span className="ml-auto shrink-0 font-mono text-[12px] text-fg-3">{timeAgo(h.at)}</span>
                      </div>
                      {h.snippet && (
                        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-fg-2">
                          {highlight(h.snippet, q).map((p, k) => (p.mark ? <mark key={k} className="rounded-[3px] bg-fg/12 font-medium text-fg">{p.text}</mark> : <span key={k}>{p.text}</span>))}
                        </p>
                      )}
                      {h.cwd && <div className="mt-0.5 truncate font-mono text-[12px] text-fg-3">{shortPath(h.cwd, 48)}</div>}
                    </div>
                  </button>
                  {open && (
                    <div className="animate-fade-in flex flex-wrap gap-2 px-3 pb-2.5 pl-[46px]">
                      {canResume(h) ? (
                        <>
                          <Button size="sm" variant="primary" className="max-md:h-10" loading={busy === 'resume'} disabled={!!busy} onClick={() => onAct(h, 'resume')}>
                            <Play className="size-3.5" /> Resume in a new session
                          </Button>
                          <Button size="sm" className="max-md:h-10" loading={busy === 'folder'} disabled={!!busy} onClick={() => onAct(h, 'folder')}>
                            <FolderOpen className="size-3.5" /> Open the folder
                          </Button>
                        </>
                      ) : (
                        <p className="text-[12.5px] text-fg-3">The transcript doesn't say which folder it ran in, so Inyon can't resume it.</p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        ))}
      {skipped.length > 0 && <p className="px-3 pt-1 pb-2 text-[12px] text-fg-3">Not searched (offline): {skipped.map((m) => m.name).join(', ')}</p>}
    </>
  )
}
