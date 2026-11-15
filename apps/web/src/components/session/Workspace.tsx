import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, ArrowDown, ArrowUp, AtSign, ChevronRight, File, FileDiff, Folder, FolderGit2, GitBranch, MessageSquare, Minus, PenLine, Plus, RefreshCw, Undo2, X } from 'lucide-react'
import { api, type DirEntry, type FileView, type GitFile, type GitState } from '../../lib/api.ts'
import { bytes } from '../../lib/format.ts'
import { compose } from '../../lib/compose.ts'
import { review, reviewMessage, useReview, type ReviewNote } from '../../lib/review.ts'
import { toast, useStore } from '../../lib/store.ts'
import { canStage, commitPlan, discardAsk, discardPaths, groups, SPLIT_MIN } from '../../lib/worktree.ts'
import { confirmAction } from '../Confirm.tsx'
import { Diff, type DiffLine } from '../chat/Diff.tsx'
import { Markdown } from '../chat/Markdown.tsx'
import { highlight, isLoaded, languageOf, loadLanguage } from '../chat/highlight.ts'
import { Button, Empty, IconButton, Sheet, Waiting, inputClass } from '../ui/primitives.tsx'
import { contextMenu, copyItem } from '../ui/ContextMenu.tsx'

/** Which session the side panel is showing. */
export interface PaneKey {
  host: string
  pane: string
}

const keyOf = (p: PaneKey) => `${p.host}:${p.pane}`

/** Puts `@path` in the session's message box; says so when that chat isn't open. */
function mentionIn(p: PaneKey, path: string, then?: () => void) {
  if (!compose({ ...p, text: `@${path}` })) return toast({ title: 'Open the chat to mention it', tone: 'info' })
  then?.()
}

/** Loads `load()` now and whenever `deps` change; `reload` asks again. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; busy: boolean }>({ busy: true })
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, busy: true }))
    load().then(
      (data) => alive && setState({ data, busy: false }),
      (e) => alive && setState({ error: (e as Error).message, busy: false }),
    )
    return () => {
      alive = false
    }
  }, [...deps, n])
  return { ...state, reload: () => setN((x) => x + 1), set: (data: T) => setState({ data, busy: false }) }
}

// ---------- review comments ----------

/** Comments on diff lines wait here until they go into the message box together. */
export function ReviewBar({ p, onComposed }: { p: PaneKey; onComposed?: () => void }) {
  const notes = useReview(keyOf(p))
  const [open, setOpen] = useState(false)
  if (!notes.length) return null
  const send = () => {
    if (!compose({ ...p, text: reviewMessage(notes) })) return toast({ title: 'Open the chat to add them', tone: 'info' })
    review.clear(keyOf(p))
    setOpen(false)
    onComposed?.()
  }
  return (
    <div className="shrink-0 border-t border-line bg-bg">
      {open && (
        <ul className="max-h-48 overflow-y-auto border-b border-line px-2 py-1.5">
          {notes.map((n) => (
            <li key={`${n.file}:${n.line}:${n.removed}`} className="flex items-start gap-2 rounded-lg px-1.5 py-1 text-[12.5px]">
              <span className="min-w-0 flex-1">
                <span className="font-mono text-[12px] text-fg-3">{n.file.split('/').pop()}:{n.line}</span> {n.text}
              </span>
              <IconButton label="Delete comment" className="size-6" onClick={() => review.remove(keyOf(p), n)}>
                <X className="size-3.5" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] font-medium">
          <MessageSquare className="size-4 text-fg-3" />
          {notes.length} {notes.length === 1 ? 'comment' : 'comments'}
        </button>
        <Button size="xs" variant="ghost" onClick={() => review.clear(keyOf(p))}>Clear</Button>
        <Button size="xs" variant="primary" onClick={send}>Add to message</Button>
      </div>
    </div>
  )
}

/** Writes a comment on one diff line. */
export function CommentSheet({ p, at, onClose }: { p: PaneKey; at: { file: string; line: DiffLine } | null; onClose: () => void }) {
  const old = at ? review.find(keyOf(p), at.file, at.line.no, at.line.removed) : undefined
  const [text, setText] = useState(old?.text ?? '')
  const save = () => {
    if (!at) return
    const n: ReviewNote = { file: at.file, line: at.line.no, removed: at.line.removed, code: at.line.text, text }
    if (text.trim()) review.add(keyOf(p), n)
    else review.remove(keyOf(p), n)
    onClose()
  }
  return (
    <Sheet
      open={!!at}
      onClose={onClose}
      title={at ? `${at.file.split('/').pop()}, line ${at.line.no}` : ''}
      icon={<MessageSquare className="size-4 text-fg-3" />}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>{old && !text.trim() ? 'Delete comment' : 'Save comment'}</Button>
        </div>
      }
    >
      {at && <pre className="mb-3 overflow-x-auto rounded-xl border border-line bg-code px-3 py-2 font-mono text-[12px]">{at.line.removed ? '− ' : ''}{at.line.text || ' '}</pre>}
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.preventDefault(), save())}
        rows={4}
        placeholder="What should change here?"
        aria-label="Comment"
        className={clsx(inputClass, 'h-auto py-2 leading-relaxed')}
      />
      <p className="mt-2 text-[12px] text-fg-3">Comments wait under the diff until you add them all to your message.</p>
    </Sheet>
  )
}

/** The screen is at least `px` wide, following it as the window changes. */
function useMinWidth(px: number) {
  const query = `(min-width: ${px}px)`
  const [on, setOn] = useState(() => !!window.matchMedia?.(query).matches)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const change = () => setOn(mq.matches)
    change()
    mq.addEventListener?.('change', change)
    return () => mq.removeEventListener?.('change', change)
  }, [query])
  return on
}

/**
 * The Changes tab's diff layout: side by side once picked, on a screen wide enough for it
 * (`can`). The pick is kept on this device; a narrow screen shows one column whatever it is.
 */
export function useDiffLayout() {
  const can = useMinWidth(SPLIT_MIN)
  const view = useStore((s) => s.settings.diffView)
  const setSettings = useStore((s) => s.setSettings)
  return { can, split: can && view === 'split', view, pick: (v: 'unified' | 'split') => setSettings({ diffView: v }) }
}

/** A diff whose line numbers take comments for this session. */
export function CommentableDiff({ p, file, hunks }: { p: PaneKey; file: string; hunks: Parameters<typeof Diff>[0]['hunks'] }) {
  const notes = useReview(keyOf(p))
  const [at, setAt] = useState<{ file: string; line: DiffLine } | null>(null)
  const marked = useMemo(() => new Set(notes.filter((n) => n.file === file).map((n) => `${n.line}:${n.removed}`)), [notes, file])
  const { split } = useDiffLayout()
  return (
    <>
      <Diff hunks={hunks} split={split} onLine={(line) => setAt({ file, line })} marked={(l) => marked.has(`${l.no}:${l.removed}`)} />
      <CommentSheet key={at ? `${at.file}:${at.line.no}:${at.line.removed}` : 'none'} p={p} at={at} onClose={() => setAt(null)} />
    </>
  )
}

// ---------- working tree ----------

const STATUS: Record<string, { label: string; tone: string }> = {
  M: { label: 'M', tone: 'text-accent-text' },
  A: { label: 'A', tone: 'text-ok' },
  '?': { label: 'U', tone: 'text-ok' },
  D: { label: 'D', tone: 'text-danger' },
  R: { label: 'R', tone: 'text-accent-text' },
}

type Acting = { action: 'stage' | 'unstage' | 'discard'; key: string } | null

/** What git sees in the session's folder: every change since the last commit, whoever made it. */
export function WorkingTree({ p, poke }: { p: PaneKey; poke: number }) {
  const git = useLoad(() => api.git(p.host, p.pane), [p.host, p.pane])
  const [sel, setSel] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState<'commit' | 'push' | 'draft' | null>(null)
  const [acting, setActing] = useState<Acting>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  // the agent did something: look again, a moment later
  useEffect(() => {
    if (!poke) return
    const t = setTimeout(git.reload, 1500)
    return () => clearTimeout(t)
  }, [poke])
  const s: GitState | undefined = git.data
  const cur = s?.files.find((f) => f.path === sel) ?? s?.files[0]
  if (!s && git.busy) return <Waiting shape="rows" label="Reading git status" />
  if (git.error) return <Empty icon={<FolderGit2 className="size-5" />} title="Couldn't read git">{git.error}</Empty>
  if (!s?.repo) return <Empty icon={<FolderGit2 className="size-5" />} title="Not a git repository">The session's folder isn't in a git repository, so there's no working tree to show.</Empty>
  const staging = canStage(s)
  const plan = commitPlan(s)
  const run = async (what: 'commit' | 'push') => {
    setBusy(what)
    try {
      if (what === 'commit') {
        const sent = msg
        const r = await api.gitCommit(p.host, p.pane, sent, plan.staged)
        // a message typed while it committed stays
        setMsg((m) => (m === sent ? '' : m))
        toast({ title: `Committed ${r.commit}`, tone: 'success' })
      } else {
        await api.gitPush(p.host, p.pane)
        toast({ title: 'Pushed', tone: 'success' })
      }
      git.reload()
    } catch (e) {
      toast({ title: what === 'commit' ? 'Could not commit' : 'Could not push', body: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(null)
    }
  }
  /** stage, unstage or discard one file, or (with no file) stage or unstage every change */
  const act = async (action: 'stage' | 'unstage' | 'discard', f?: GitFile) => {
    if (acting) return
    if (action === 'discard' && (!f || !(await confirmAction({ ...discardAsk(f), yes: 'Discard', danger: true })))) return
    setActing({ action, key: f?.path ?? '*' })
    try {
      git.set(await api.gitFiles(p.host, p.pane, action, f ? (action === 'discard' ? discardPaths(f) : [f.path]) : [], !f))
      if (action === 'discard') toast({ title: 'Changes discarded', tone: 'success' })
    } catch (e) {
      toast({ title: action === 'stage' ? 'Could not stage' : action === 'unstage' ? 'Could not unstage' : 'Could not discard', body: (e as Error).message, tone: 'error' })
      git.reload()
    } finally {
      setActing(null)
    }
  }
  const draft = async () => {
    setBusy('draft')
    try {
      const { message } = await api.gitDraft(p.host, p.pane)
      const before = msg
      setMsg(message)
      box.current?.focus()
      if (before.trim() && before !== message) toast({ title: 'Your message was replaced with a draft', tone: 'info', action: { label: 'Undo', onSelect: () => setMsg(before) } })
    } catch (e) {
      toast({ title: 'Could not draft a message', body: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(null)
    }
  }
  // something to push, and somewhere to push it
  const canPush = s.remote && (!s.upstream || (s.ahead ?? 0) > 0)
  const { staged, changes } = groups(s.files)
  const row = (f: GitFile, inStaged: boolean) => {
    const on = cur?.path === f.path
    const mine = acting?.key === f.path && acting.action !== 'discard'
    const name = f.path.split('/').pop()
    return (
      <div key={`${inStaged ? 's' : 'c'}:${f.path}`} className={clsx('flex items-center rounded-xl', on ? 'bg-hover' : 'hover:bg-hover/60')}>
        <button
          type="button"
          onClick={() => setSel(f.path)}
          {...contextMenu(() => [
            { key: 'diff', label: 'Show diff', icon: <FileDiff className="size-4" />, onSelect: () => setSel(f.path) },
            f.status !== 'D' && { key: 'mention', label: 'Mention in message', icon: <AtSign className="size-4" />, onSelect: () => mentionIn(p, f.path) },
            copyItem('copy', 'Copy path', s.root ? `${s.root}/${f.path}` : f.path, 'Path'),
            staging &&
              (inStaged
                ? { key: 'unstage', label: 'Unstage', icon: <Minus className="size-4" />, onSelect: () => act('unstage', f) }
                : { key: 'stage', label: 'Stage', icon: <Plus className="size-4" />, onSelect: () => act('stage', f) }),
            staging && { key: 'discard', label: 'Discard changes', icon: <Undo2 className="size-4" />, danger: true, onSelect: () => act('discard', f) },
          ])}
          title={f.from ? `${f.from} → ${f.path}` : f.path}
          className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left text-[12.5px]"
        >
          <span className={clsx('w-3 font-mono text-[12px] font-semibold', STATUS[f.status].tone)}>{STATUS[f.status].label}</span>
          <span className="min-w-0 flex-1 truncate">
            <span className="text-fg-3">{f.path.slice(0, f.path.lastIndexOf('/') + 1)}</span>
            {name}
          </span>
          {f.status !== '?' && (
            <span className="tabular shrink-0 font-mono text-[12px]">
              <span className="text-ok">+{f.add}</span> <span className="text-danger">−{f.del}</span>
            </span>
          )}
        </button>
        {staging && (
          <IconButton label={inStaged ? `Unstage ${name}` : `Stage ${name}`} className="mr-1 size-7" disabled={!!acting} onClick={() => act(inStaged ? 'unstage' : 'stage', f)}>
            {mine ? <RefreshCw className="size-3.5 animate-spin" /> : inStaged ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
          </IconButton>
        )}
      </div>
    )
  }
  const head = (title: string, n: number, action: 'stage' | 'unstage') => (
    <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-0.5 text-[12px] text-fg-3">
      <span className="font-medium text-fg-2">{title}</span>
      <span className="tabular">{n}</span>
      <span className="flex-1" />
      <button type="button" disabled={!!acting} onClick={() => act(action)} className="rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-fg disabled:opacity-50">
        {action === 'stage' ? 'Stage all' : 'Unstage all'}
      </button>
    </div>
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-[12.5px]">
        <GitBranch className="size-3.5 text-fg-3" />
        <span className="min-w-0 truncate font-medium">{s.branch}</span>
        {(s.ahead ?? 0) > 0 && <span className="tabular flex items-center text-fg-3" title={`${s.ahead} commits not pushed`}><ArrowUp className="size-3" />{s.ahead}</span>}
        {(s.behind ?? 0) > 0 && <span className="tabular flex items-center text-fg-3" title={`${s.behind} commits to pull`}><ArrowDown className="size-3" />{s.behind}</span>}
        <span className="flex-1" />
        {canPush && (
          <Button size="xs" variant="ghost" loading={busy === 'push'} disabled={!!busy} onClick={() => run('push')} title={s.upstream ? `Push to ${s.upstream}` : 'Push to origin'}>
            Push
          </Button>
        )}
        <IconButton label="Refresh" className="size-7" onClick={git.reload}>
          <RefreshCw className={clsx('size-3.5', git.busy && 'animate-spin')} />
        </IconButton>
      </div>
      {!s.files.length ? (
        <Empty icon={<FileDiff className="size-5" />} title="No changes">Nothing has changed since the last commit.</Empty>
      ) : (
        <>
          <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-line p-1.5">
            {staging ? (
              <>
                {staged.length > 0 && (
                  <section aria-label="Staged">
                    {head('Staged', staged.length, 'unstage')}
                    {staged.map((f) => row(f, true))}
                  </section>
                )}
                {changes.length > 0 && (
                  <section aria-label="Changes">
                    {head('Changes', changes.length, 'stage')}
                    {changes.map((f) => row(f, false))}
                  </section>
                )}
              </>
            ) : (
              s.files.map((f) => row(f, false))
            )}
          </div>
          {cur && (
            <>
              {staging && (
                <div className="flex shrink-0 items-center gap-2 border-b border-line py-1 pr-1.5 pl-3 text-[12px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-fg-2" title={cur.path}>{cur.path}</span>
                  <Button size="xs" variant="ghost" loading={acting?.action === 'discard' && acting.key === cur.path} disabled={!!acting} onClick={() => act('discard', cur)} title="Throw away the changes to this file">
                    <Undo2 className="size-3.5" />
                    Discard
                  </Button>
                </div>
              )}
              <TreeDiff key={`${cur.path}:${poke}:${s.files.length}:${cur.staged}:${cur.unstaged}`} p={p} path={cur.path} />
            </>
          )}
          <form className="shrink-0 space-y-1.5 border-t border-line p-2" onSubmit={(e) => (e.preventDefault(), msg.trim() && !busy && run('commit'))}>
            <textarea
              ref={box}
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.preventDefault(), msg.trim() && !busy && run('commit'))}
              rows={Math.min(6, Math.max(1, msg.split('\n').length))}
              placeholder="Commit message"
              aria-label="Commit message"
              className={clsx(inputClass, 'h-auto resize-none py-1.5 text-[13px] leading-relaxed')}
            />
            <div className="flex items-center gap-1.5">
              <Button type="button" size="xs" variant="ghost" loading={busy === 'draft'} disabled={!!busy} onClick={draft} title="Write a message from the files that would be committed">
                <PenLine className="size-3.5" />
                Draft
              </Button>
              <span className="flex-1" />
              <Button type="submit" size="sm" loading={busy === 'commit'} disabled={!msg.trim() || !!busy} title={plan.title}>
                {plan.label}
              </Button>
            </div>
          </form>
        </>
      )}
    </div>
  )
}

function TreeDiff({ p, path }: { p: PaneKey; path: string }) {
  const d = useLoad(() => api.gitDiff(p.host, p.pane, path), [p.host, p.pane, path])
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {d.busy && !d.data ? (
        <Waiting shape="lines" label="Reading the diff" />
      ) : d.error ? (
        <div className="px-3 py-2 text-[12px] text-fg-3">{d.error}</div>
      ) : d.data?.binary ? (
        <div className="px-3 py-2 text-[12px] text-fg-3">A binary file; no diff to show.</div>
      ) : d.data?.hunks.length ? (
        <CommentableDiff p={p} file={path} hunks={d.data.hunks} />
      ) : (
        <div className="px-3 py-2 text-[12px] text-fg-3">No line changes (only its mode or an empty file).</div>
      )}
    </div>
  )
}

// ---------- files ----------

/** The session's folder, read only: browse it, read a file, mention one in your message. */
export function FilesTab({ p, onComposed }: { p: PaneKey; onComposed?: () => void }) {
  const [path, setPath] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const dir = useLoad(() => api.dir(p.host, p.pane, path), [p.host, p.pane, path])
  if (open !== null) return <FileViewer p={p} path={open} onBack={() => setOpen(null)} onComposed={onComposed} />
  const crumbs = path ? path.split('/') : []
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-2 py-1.5 text-[12.5px]">
        <button type="button" onClick={() => setPath('')} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium hover:bg-hover" title={dir.data?.cwd}>
          {dir.data?.cwd.split('/').pop() || 'Folder'}
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex shrink-0 items-center">
            <ChevronRight className="size-3 text-fg-3" />
            <button type="button" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))} className="rounded-md px-1.5 py-0.5 hover:bg-hover">{c}</button>
          </span>
        ))}
        <span className="flex-1" />
        <IconButton label="Refresh" className="size-7" onClick={dir.reload}>
          <RefreshCw className={clsx('size-3.5', dir.busy && 'animate-spin')} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {dir.error ? (
          <Empty icon={<Folder className="size-5" />} title="Couldn't open this folder">{dir.error}</Empty>
        ) : !dir.data && dir.busy ? (
          <Waiting shape="rows" label="Reading the folder" />
        ) : !dir.data?.entries.length ? (
          <Empty icon={<Folder className="size-5" />} title="Empty folder" />
        ) : (
          dir.data.entries.map((e: DirEntry) => (
            <button
              key={e.name}
              type="button"
              onClick={() => (e.dir ? setPath(path ? `${path}/${e.name}` : e.name) : setOpen(path ? `${path}/${e.name}` : e.name))}
              {...contextMenu(() => {
                const rel = path ? `${path}/${e.name}` : e.name
                return [
                  { key: 'open', label: 'Open', icon: e.dir ? <Folder className="size-4" /> : <File className="size-4" />, onSelect: () => (e.dir ? setPath(rel) : setOpen(rel)) },
                  { key: 'mention', label: 'Mention in message', icon: <AtSign className="size-4" />, onSelect: () => mentionIn(p, e.dir ? `${rel}/` : rel, onComposed) },
                  copyItem('copy', 'Copy path', `${dir.data?.cwd}/${rel}`, 'Path'),
                ]
              })}
              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-[13px] hover:bg-hover/60"
            >
              {e.dir ? <Folder className="size-4 shrink-0 text-fg-3" /> : <File className="size-4 shrink-0 text-fg-3" />}
              <span className={clsx('min-w-0 flex-1 truncate', e.name.startsWith('.') && 'text-fg-3')}>{e.name}</span>
              {!e.dir && <span className="tabular shrink-0 text-[12px] text-fg-3">{bytes(e.size)}</span>}
            </button>
          ))
        )}
      </div>
    </div>
  )
}

const EXT_LANG: Record<string, string> = { rs: 'rust', kt: 'kotlin', md: 'markdown', cjs: 'javascript', cts: 'typescript', mts: 'typescript' }

function useHighlighted(lang: string | undefined, text: string) {
  const [, arrived] = useState(0)
  const loaded = !!lang && isLoaded(lang)
  useEffect(() => {
    if (!lang || loaded) return
    let on = true
    loadLanguage(lang).then((ok) => on && ok && arrived((n) => n + 1))
    return () => {
      on = false
    }
  }, [lang, loaded])
  // a very large file stays plain; highlighting it would hold up the page
  return useMemo(() => (loaded && lang && text.length < 200_000 ? highlight(lang, text) : ''), [loaded, lang, text])
}

function FileViewer({ p, path, onBack, onComposed }: { p: PaneKey; path: string; onBack: () => void; onComposed?: () => void }) {
  const f = useLoad<FileView>(() => api.file(p.host, p.pane, path), [p.host, p.pane, path])
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const [raw, setRaw] = useState(false)
  const view = f.data
  const text = view?.kind === 'text' ? view.text : ''
  const lang = EXT_LANG[ext] ?? languageOf(`language-${ext}`)
  const html = useHighlighted(view?.kind === 'text' ? lang : undefined, text)
  const mention = () => mentionIn(p, path, onComposed)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-1.5 py-1">
        <IconButton label="Back to the folder" className="size-7" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={path}>{path}</span>
        {ext === 'md' && view?.kind === 'text' && (
          <Button size="xs" variant="ghost" onClick={() => setRaw(!raw)}>{raw ? 'Rendered' : 'Source'}</Button>
        )}
        <Button size="xs" variant="ghost" onClick={mention} title="Add @path to your message">
          <AtSign className="size-3.5" />
          Mention
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {f.error ? (
          <div className="px-3 py-2 text-[13px] text-fg-3">{f.error}</div>
        ) : !view ? (
          <Waiting shape="lines" label="Reading the file" />
        ) : view.kind === 'image' ? (
          <div className="flex justify-center bg-sunken p-3">
            <img src={`data:${view.type};base64,${view.data}`} alt={path} className="max-w-full rounded-lg" />
          </div>
        ) : view.kind === 'binary' ? (
          <Empty icon={<File className="size-5" />} title="Not a text file">{bytes(view.size)} of binary data.</Empty>
        ) : view.kind === 'large' ? (
          <Empty icon={<File className="size-5" />} title="Too large to show">{bytes(view.size)}.</Empty>
        ) : ext === 'md' && !raw ? (
          <div className="px-4 py-3">
            <Markdown text={view.text} />
          </div>
        ) : (
          <>
            <pre className="min-w-max px-3 py-2.5 font-mono text-[12.5px] leading-[1.6]">
              {html ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{view.text}</code>}
            </pre>
            {view.truncated && <div className="border-t border-line px-3 py-1.5 text-[12px] text-fg-3">Showing the first 512 KB of {bytes(view.size)}.</div>}
          </>
        )}
      </div>
    </div>
  )
}

