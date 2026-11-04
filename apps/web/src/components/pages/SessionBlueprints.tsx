import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { ChevronLeft, ExternalLink, PanelsTopLeft, ShieldCheck } from 'lucide-react'
import { PART_LABEL, browserPath, noteTitle, sessionCount, sessionPages, tmuxOf, usePages, type Page, type Part, type SessionList } from '../../lib/pages.ts'
import { Empty, IconButton, Menu, Segmented } from '../ui/primitives.tsx'
import type { SessionModel } from '../session/useSession.ts'
import { PageFrame, PageRows, SANDBOX_NOTE, openInBrowser, useMachines, useNames } from './shared.tsx'
import { notesMenu, useViewer } from './viewer.tsx'

/** A session's blueprints (see sessionPages), live from the list, with the tmux session it runs in. */
export function useSessionPages(s: SessionModel): { list: SessionList; tmux?: string; count: number } {
  const all = usePages((x) => x.pages)
  const names = useNames()
  const host = s.ref?.host.config.id
  const cwd = s.ref?.pane.cwd
  const session = s.ref?.pane.agent?.sessionId
  const tmux = s.ref?.session.name
  return useMemo(() => {
    const list = host ? sessionPages(all ?? [], names, { host, tmux, cwd, session }) : { mine: [], earlier: [], nearby: [] }
    return { list, tmux, count: sessionCount(list) }
  }, [all, names, host, tmux, cwd, session])
}

/**
 * The labelled parts of a session's list: this conversation's blueprints, the tmux session's
 * earlier ones, and those in its folder. A list of only this conversation's goes without a label.
 */
export function sections(list: SessionList, tmux?: string): { label?: string; pages: Page[] }[] {
  const onlyMine = !list.earlier.length && !list.nearby.length
  const earlier = tmux ? (list.mine.length ? `Earlier in ${tmux}` : `In ${tmux}`) : 'Earlier in this session'
  return [
    { label: 'This conversation', pages: list.mine },
    { label: earlier, pages: list.earlier },
    { label: 'In this folder', pages: list.nearby },
  ]
    .filter((x) => x.pages.length)
    .map((x) => ({ label: onlyMine ? undefined : x.label, pages: x.pages }))
}

/**
 * A session's blueprints, as Claude's artifacts sit beside a chat. `inline` (the side panel on a
 * wide screen) opens one right here, with the way back to the list; otherwise a row opens the
 * full-screen viewer, whose back returns to the session (`from`).
 */
export function SessionBlueprints({ list, tmux, from, inline }: { list: SessionList; tmux?: string; from?: string; inline?: boolean }) {
  const [open, setOpen] = useState<string>()
  const all = [...list.mine, ...list.earlier, ...list.nearby]
  const page = inline ? all.find((p) => p.id === open) : undefined
  if (page) return <SideViewer page={page} onBack={() => setOpen(undefined)} />
  if (!all.length) {
    return (
      <Empty icon={<PanelsTopLeft className="size-5" />} title="No blueprints here">
        Sites an agent adds with <code className="font-mono text-[12.5px]">inyon blueprints add</code> in this tmux session show up here.
      </Empty>
    )
  }
  return (
    <div className="space-y-4 p-3">
      {sections(list, tmux).map((x) => (
        <section key={x.label ?? 'mine'}>
          {x.label && <h3 className="side-label mx-1 mb-2 font-mono text-[12px] text-fg-3">{x.label}</h3>}
          <PageRows pages={x.pages} from={from} onPick={inline ? (p) => setOpen(p.id) : undefined} />
        </section>
      ))}
    </div>
  )
}

/** One blueprint open in the session's panel: which it is, its session and machine, its parts, and the frame. */
function SideViewer({ page, onBack }: { page: Page; onBack: () => void }) {
  const v = useViewer(page)
  const names = useNames()
  const m = useMachines()(page.host)
  const where = [tmuxOf(page, names)?.name, m.name].filter(Boolean).join(' · ')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line pr-1.5 pl-1">
        <IconButton label="This session's blueprints" onClick={onBack}><ChevronLeft className="size-4" /></IconButton>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="viewer-name truncate text-[13.5px] font-semibold">{page.name}</div>
          <div className="viewer-where truncate font-mono text-[12px] text-fg-3">{where}</div>
        </div>
        {!v.bridged && (
          <IconButton label="Open in new tab" title="Open in new tab. A 12 h link; never sign in there." disabled={!v.link} onClick={() => void openInBrowser(page, browserPath(v.part, v.note))}>
            <ExternalLink className="size-4" />
          </IconButton>
        )}
      </div>
      {(v.parts.length > 1 || !!page.notes?.length) && (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-2.5">
          {v.parts.length > 1 && <Segmented size="sm" label="Part of the blueprint" value={v.note ? ('' as Part) : v.part} onChange={v.setPart} options={v.parts.map((p) => ({ v: p, label: PART_LABEL[p] }))} />}
          {!!page.notes?.length && (
            <Menu
              align="end"
              header="Notes"
              items={notesMenu(page, v)}
              trigger={({ toggle, ref }) => (
                <button ref={ref} type="button" onClick={toggle} className={clsx('press ml-auto h-[30px] max-w-[160px] truncate rounded-full border px-2.5 text-[12px] font-medium', v.note ? 'border-line-strong text-fg' : 'border-line text-fg-2')}>
                  {v.note ? noteTitle(v.note) : 'Notes'}
                </button>
              )}
            />
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1 bg-sunken/60 p-2">
        {v.src && (m.online || v.stale) ? (
          <div className="size-full overflow-hidden rounded-xl border border-line-strong bg-bg">
            <PageFrame key={v.frameKey} src={v.src} bridge={v.bridge} title={page.name} className="block size-full border-0" />
          </div>
        ) : (
          <div className="flex size-full items-center justify-center px-6 text-center text-[13px] text-fg-3">{v.error ? v.error.message : m.online ? `Opening “${page.name}”` : `${m.name} is offline`}</div>
        )}
      </div>
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-t border-line px-3 font-mono text-[12px] text-fg-3">
        <ShieldCheck className="size-3.5 shrink-0" />
        <span className="truncate">{SANDBOX_NOTE}</span>
      </div>
    </div>
  )
}
