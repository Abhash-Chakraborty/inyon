import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, type NavigateFunction } from 'react-router-dom'
import { create } from 'zustand'
import clsx from 'clsx'
import { ChevronRight, Copy, ExternalLink, FolderOpen, Link2Off, PanelsTopLeft, Trash2 } from 'lucide-react'
import type { HostState, PageOpen } from '@inyon/protocol'
import { api, ApiError } from '../../lib/api.ts'
import { toast, useStore } from '../../lib/store.ts'
import { copyText } from '../../lib/clipboard.ts'
import { isNative } from '../../lib/native.ts'
import { splitHostId } from '../../lib/hubs.ts'
import {
  PART_PATH, absoluteLink, agoText, changedAt, dropPage, frameMessage, isChanged, isHubMachine, loadPages, openLink, pageBase, pageHosts, pageHref, projectName, shouldRenew, usePages,
  type Page, type Part,
} from '../../lib/pages.ts'
import { Button, Field, SectionLabel, Sheet, inputClass, type MenuItem } from '../ui/primitives.tsx'
import { contextMenu } from '../ui/ContextMenu.tsx'
import { Select } from '../ui/Select.tsx'
import { confirmAction } from '../Confirm.tsx'
import { useOpened } from '../../lib/useOpened.ts'

/** The docs page about Pages, for "How pages work". */
export const PAGES_DOCS = 'https://inyon.abhashchakraborty.tech/docs/pages/'
/** The one command an agent runs to add a page, as the empty states show it. */
export const ADD_COMMAND = 'inyon pages add ./private/plans/my-plan --name "My plan"'

// ---------- machines ----------

/** What the lists need to know about a page's machine. */
export interface PageMachine {
  name: string
  online: boolean
  /** the hub's own machine */
  hub: boolean
  host?: HostState
}

/** The machine a page is on, by the hosts the app knows; a hub's own machine is "This hub" until its name arrives. */
export function machineOf(hosts: HostState[], host: string): PageMachine {
  const h = hosts.find((x) => x.config.id === host)
  const hub = isHubMachine(host)
  if (!h) return { name: hub ? (splitHostId(host).hub?.name ?? 'This hub') : host, online: true, hub }
  return { name: h.config.name, online: h.status === 'online', hub: h.config.kind === 'local' || hub, host: h }
}

/** A function from host id to its machine, for the current list of hosts. */
export function useMachines() {
  const hosts = useStore((s) => s.hosts)
  return useCallback((host: string) => machineOf(hosts, host), [hosts])
}

// ---------- progress ----------

/** A thin done/total bar; it moves with transform only. */
export function ProgressBar({ done, total, className }: { done: number; total: number; className?: string }) {
  const f = total > 0 ? Math.min(1, done / total) : 0
  return (
    <div role="progressbar" aria-label={`${done} of ${total} done`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className={clsx('overflow-hidden rounded-full bg-line', className ?? 'h-[3px]')}>
      <div className="h-full origin-left rounded-full bg-fg transition-transform duration-(--dur-move) ease-out-soft" style={{ transform: `scaleX(${f})` }} />
    </div>
  )
}

/** "updated 3 min ago", or when it was added when it has no board. */
export const updatedLine = (p: Page, now = Date.now()) => (p.progress?.updated ? `updated ${agoText(changedAt(p), now)}` : `added ${agoText(p.added, now)}`)

/** The changed-since-you-opened-it dot. */
export const ChangedDot = () => <span aria-label="changed" title="Changed since you last opened it" className="animate-pop size-1.5 shrink-0 rounded-full bg-fg" />

// ---------- links ----------

/** Bumped by Revoke, so an open viewer mints a new link at once. */
const useLinkRev = create<Record<string, number>>(() => ({}))

/**
 * A page's link: minted when the page opens, and again when the app comes back into view with
 * less than an hour left. Each new link reloads the frame.
 */
export function usePageLink(page: Pick<Page, 'id' | 'host' | 'slug'> | undefined) {
  const rev = useLinkRev((s) => (page ? (s[page.id] ?? 0) : 0))
  const [state, setState] = useState<{ id: string; link?: PageOpen; error?: ApiError | Error }>()
  const current = useRef(state)
  current.current = state
  const id = page?.id
  const mint = useCallback(async () => {
    if (!page) return
    const asked = page.id
    try {
      const link = await openLink(page)
      if (asked === id) setState({ id: asked, link })
    } catch (e) {
      if (asked === id) setState((s) => ({ id: asked, link: s?.id === asked ? s.link : undefined, error: e as Error }))
    }
  }, [id])
  useEffect(() => {
    if (!id) return
    setState((s) => (s?.id === id ? { id, link: s.link } : { id }))
    void mint()
  }, [id, rev, mint])
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return
      const l = current.current?.link
      if (l && shouldRenew(l.expires, Date.now())) void mint()
    }
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [mint])
  const mine = state?.id === id ? state : undefined
  return { link: mine?.link, error: mine?.error, retry: mint }
}

/**
 * Which parts of a Blueprint site exist (the plan always does), asked of the hub with each new link.
 * What was found stays shown while a renewed link is asked again.
 */
export function useSiteParts(page: Pick<Page, 'id' | 'host'> | undefined, link: PageOpen | undefined): Part[] {
  const [found, setFound] = useState<{ id: string; parts: Part[] }>()
  useEffect(() => {
    if (!page || !link) return
    let live = true
    const base = pageBase(page.host)
    Promise.all(
      (['mockups', 'matrix'] as const).map(async (part) => {
        try {
          const r = await fetch(`${base}${link.url}${PART_PATH[part]}`, { method: 'HEAD', credentials: 'omit', referrerPolicy: 'no-referrer' })
          return r.ok ? part : undefined
        } catch {
          return undefined
        }
      }),
    ).then((list) => live && setFound({ id: page.id, parts: ['plan', ...list.filter((p) => p !== undefined)] }))
    return () => void (live = false)
  }, [page?.id, link?.url])
  return found && found.id === page?.id ? found.parts : ['plan']
}

/**
 * The page in its frame. The sandbox matches the hub's own CSP sandbox: scripts run, on an opaque
 * origin, with no way at the app's cookie, storage or DOM. The theme goes in with ?theme= in the
 * address, and as a message when the app's theme changes or the frame loads a new document.
 */
export function PageFrame({ src, title, className, style }: { src: string; title: string; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const theme = useStore((s) => s.resolvedTheme)
  const themeNow = useRef(theme)
  themeNow.current = theme
  const post = useCallback(() => {
    try {
      ref.current?.contentWindow?.postMessage({ type: 'theme', value: themeNow.current }, '*')
    } catch {}
  }, [])
  useEffect(post, [theme])
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = frameMessage(e, ref.current?.contentWindow)
      if (m?.type === 'theme?') post()
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [post])
  return <iframe ref={ref} src={src} title={title} sandbox="allow-scripts allow-forms allow-popups allow-downloads" referrerPolicy="no-referrer" allow="" onLoad={post} className={className} style={style} />
}

// ---------- what can be done to a page ----------

/**
 * Opens a page outside the app. A browser blocks a window opened after a wait, so one is opened
 * first and sent to the link once it is minted; the Android app hands the link to the browser.
 */
export async function openInBrowser(p: Page, link?: PageOpen) {
  const pending = !link && !isNative() ? window.open('', '_blank') : null
  if (pending) pending.opener = null
  try {
    const l = link ?? (await openLink(p))
    const url = absoluteLink(p.host, l.url)
    if (pending) pending.location.href = url
    else window.open(url, '_blank', 'noopener')
  } catch (e) {
    pending?.close()
    toast({ title: `Couldn't open “${p.name}”`, body: (e as Error).message, tone: 'error' })
  }
}

/** Asks, then ends every link to a page; an open viewer gets a new one right away. */
export async function revokeLinks(p: Page) {
  const ok = await confirmAction({
    title: `Revoke links to “${p.name}”?`,
    body: 'Every link to this page stops working: tabs on other devices, links you copied, and the one in an open viewer, which gets a new one right away.',
    yes: 'Revoke links',
    danger: true,
  })
  if (!ok) return
  try {
    await api.revokePage(p.host, p.slug)
    useLinkRev.setState((s) => ({ [p.id]: (s[p.id] ?? 0) + 1 }))
    toast({ title: 'Links revoked', body: `Old links to “${p.name}” stop working.`, tone: 'success' })
  } catch (e) {
    toast({ title: "Couldn't revoke the links", body: (e as Error).message, tone: 'error' })
  }
}

/** Takes a page off the list, with Undo; the folder stays where it is. */
export async function removePage(p: Page, machine: string, after?: () => void) {
  try {
    await api.removePage(p.host, p.slug)
    dropPage(p.id)
    after?.()
    toast({
      title: `Removed “${p.name}”`,
      body: `The folder stays on ${machine}.`,
      tone: 'success',
      action: {
        label: 'Undo',
        onSelect: () =>
          void api.addPage(p.host, { path: p.folder, name: p.name, slug: p.slug }).then(
            () => loadPages(),
            (e) => toast({ title: `Couldn't put “${p.name}” back`, body: (e as Error).message, tone: 'error' }),
          ),
      },
    })
  } catch (e) {
    toast({ title: `Couldn't remove “${p.name}”`, body: (e as Error).message, tone: 'error' })
  }
}

export const copyFolder = (p: Page) => copyText(p.folder).then((ok) => ok && toast({ title: 'Copied the folder path', tone: 'success' }))

/** The sheets the page menus open, mounted once (in the shell). */
type PageSheet = { kind: 'folder'; page: Page } | { kind: 'add' }
const usePageSheet = create<{ sheet?: PageSheet; open: boolean }>(() => ({ open: false }))
export const openPageSheet = (sheet: PageSheet) => usePageSheet.setState({ sheet, open: true })

/** One menu for a page wherever it's listed: long-press, right-click and ⋯ share it. */
export function pageMenu(p: Page, machine: PageMachine, nav: NavigateFunction, o: { open?: boolean } = {}): MenuItem[] {
  const off = !machine.online
  return [
    ...(o.open === false ? [] : [{ key: 'open', label: 'Open', icon: <PanelsTopLeft className="size-4" />, onSelect: () => nav(pageHref(p.host, p.slug)) }]),
    { key: 'browser', label: 'Open in browser', hint: off ? `${machine.name} is offline` : 'A link that works for 12 h', icon: <ExternalLink className="size-4" />, disabled: off, onSelect: () => void openInBrowser(p) },
    { key: 'revoke', label: 'Revoke links', icon: <Link2Off className="size-4" />, separated: true, onSelect: () => void revokeLinks(p) },
    { key: 'folder', label: 'Show folder', icon: <FolderOpen className="size-4" />, onSelect: () => openPageSheet({ kind: 'folder', page: p }) },
    { key: 'remove', label: 'Remove', icon: <Trash2 className="size-4" />, danger: true, separated: true, onSelect: () => void removePage(p, machine.name) },
  ]
}

export function PageSheets() {
  const { sheet, open } = usePageSheet()
  const close = () => usePageSheet.setState({ open: false })
  if (!sheet) return null
  return sheet.kind === 'folder' ? <FolderSheet page={sheet.page} open={open} onClose={close} /> : <AddFolderSheet open={open} onClose={close} />
}

function FolderSheet({ page: p, open, onClose }: { page: Page; open: boolean; onClose: () => void }) {
  const machine = useMachines()(p.host)
  const rows: [string, React.ReactNode, boolean?][] = [
    ['Page', p.name],
    ['Folder', p.folder, true],
    ['Machine', machine.online ? machine.name : `${machine.name} · offline`],
    ['Project', projectName(p.project)],
    ['Added by', `${p.by === 'cli' ? 'inyon pages add' : p.by === 'app' ? 'the app' : p.by} · ${new Date(p.added).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`],
  ]
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Folder"
      icon={<FolderOpen className="size-4 text-fg-2" />}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="danger" onClick={() => (onClose(), void removePage(p, machine.name))}>
            <Trash2 className="size-3.5" /> Remove
          </Button>
          <Button variant="primary" onClick={() => void copyFolder(p)}>
            <Copy className="size-3.5" /> Copy path
          </Button>
        </div>
      }
    >
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] text-[14px]">
        {rows.map(([k, v, mono], i) => (
          <div key={k} className={clsx('contents', i > 0 && '[&>*]:border-t [&>*]:border-line')}>
            <dt className="py-2.5 text-[13px] text-fg-2">{k}</dt>
            <dd className={clsx('min-w-0 py-2.5 break-words', mono && 'font-mono text-[13px]')}>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[13px] text-fg-3">Remove takes the page out of Inyon. The folder and its files stay.</p>
    </Sheet>
  )
}

function AddFolderSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const hosts = useMemo(() => (open ? pageHosts() : []), [open])
  const machines = useMachines()
  const [host, setHost] = useState('')
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useOpened(open, undefined, () => {
    setHost(hosts[0] ?? '')
    setFolder('')
    setName('')
    setError('')
  })
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const path = folder.trim()
    if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) return setError('Give the full path, starting with /.')
    setBusy(true)
    setError('')
    try {
      const added = await api.addPage(host || hosts[0]!, { path, ...(name.trim() ? { name: name.trim() } : {}) })
      await loadPages()
      toast({ title: `Added “${added.name}”`, body: `On ${machines(host || hosts[0]!).name}`, tone: 'success' })
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add a folder"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-page" loading={busy} disabled={!folder.trim() || !hosts.length}>Add</Button>
        </div>
      }
    >
      <form id="add-page" onSubmit={submit} className="space-y-3">
        {hosts.length > 1 && (
          <Field label="Machine">
            <Select value={host} onChange={setHost} options={hosts.map((h) => ({ value: h, label: machines(h).name }))} aria-label="Machine" />
          </Field>
        )}
        <Field label="Folder" hint="The site's own folder, the one with index.html in it.">
          <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/home/me/project/private/plans/my-plan" spellCheck={false} autoCapitalize="off" className={clsx(inputClass, 'font-mono text-[13px]')} />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shown in the list" className={inputClass} />
        </Field>
        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
        <p className="text-[13px] text-fg-3">
          Agents do this for you with <span className="font-mono text-[12px]">inyon pages add</span>.
        </p>
      </form>
    </Sheet>
  )
}

/** "Pages on this machine", on a machine's page; nothing when it has none. */
export function MachinePages({ host }: { host: string }) {
  const all = usePages((s) => s.pages)
  const seen = usePages((s) => s.seen)
  const nav = useNavigate()
  const machine = useMachines()(host)
  const pages = useMemo(() => (all ?? []).filter((p) => p.host === host).sort((a, b) => changedAt(b) - changedAt(a)), [all, host])
  if (!pages.length) return null
  return (
    <section className="mt-8">
      <SectionLabel>Pages on this machine</SectionLabel>
      <div className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-elev shadow-card">
        {pages.map((p) => (
          <Link key={p.id} to={pageHref(p.host, p.slug)} {...contextMenu(() => pageMenu(p, machine, nav), { touch: true, header: p.name })} className="flex min-h-[52px] items-center gap-3 px-4 py-2.5 hover:bg-hover/60 active:bg-hover">
            <PanelsTopLeft className="size-4 shrink-0 text-fg-3" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[14px] font-medium">{p.name}</span>
                {isChanged(p, seen) && <ChangedDot />}
              </div>
              <div className="truncate font-mono text-[12px] text-fg-3">
                {projectName(p.project)} · {updatedLine(p)}
              </div>
            </div>
            {p.progress && (
              <span className="tabular hidden items-center gap-2 font-mono text-[12px] text-fg-2 sm:flex">
                <ProgressBar done={p.progress.done} total={p.progress.total} className="h-[3px] w-12" />
                {p.progress.done}/{p.progress.total}
              </span>
            )}
            <ChevronRight className="size-4 shrink-0 text-fg-3" />
          </Link>
        ))}
      </div>
    </section>
  )
}
