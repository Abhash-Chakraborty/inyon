import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { ArrowUp, Camera, FileText, Folder, Paperclip, Square, X } from 'lucide-react'
import { AGENTS, chatKey, type AgentKind, type SlashCommand } from '@tether/protocol'
import { haptic } from '../../lib/haptics.ts'
import { api, type Uploaded } from '../../lib/api.ts'
import { patchChat, toast, useStore } from '../../lib/store.ts'
import { socket } from '../../lib/socket.ts'
import { bytes } from '../../lib/format.ts'
import { openMenu } from '../ui/primitives.tsx'

/** commands that open a picker in the agent's terminal; the composer's own menus do the job */
const MENU_COMMANDS: Record<string, string> = { '/model': 'model', '/models': 'model', '/effort': 'effort', '/agents': 'mode', '/agent': 'mode' }

interface Attachment {
  id: string
  name: string
  size: number
  type: string
  preview?: string
  progress: number
  status: 'uploading' | 'done' | 'error'
  path?: string
  error?: string
  pastedLines?: number
}

const DRAFTS = new Map<string, string>()

/**
 * Attachments per session, outside the component like the text drafts: leaving the page (or an
 * upload finishing while you're elsewhere) must not drop a file you meant to send.
 */
const ATTACH = new Map<string, Attachment[]>()
const attachSubs = new Set<() => void>()
const NO_FILES: Attachment[] = []
function updateFiles(key: string, fn: (f: Attachment[]) => Attachment[]) {
  ATTACH.set(key, fn(ATTACH.get(key) ?? NO_FILES))
  attachSubs.forEach((s) => s())
}
function useFiles(key: string) {
  return useSyncExternalStore(
    (cb) => (attachSubs.add(cb), () => attachSubs.delete(cb)),
    () => ATTACH.get(key) ?? NO_FILES,
  )
}
const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
const LONG_PASTE_LINES = 40

/** Subsequence match score; higher is better, -1 for no match. */
function fuzzy(query: string, target: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const at = t.indexOf(q)
  if (at >= 0) return 1000 - at - (t.length - q.length) * 0.1 + (t.lastIndexOf('/') < at ? 200 : 0)
  let ti = 0
  let score = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return -1
    streak = found === ti ? streak + 1 : 0
    score += 10 + streak * 5 - (found - ti) * 0.5
    ti = found + 1
  }
  return score
}

type Popover =
  | { kind: 'slash'; query: string; start: number; end: number }
  | { kind: 'mention'; query: string; start: number; end: number }

/** Finds a `/command` (at the start) or `@path` token around the cursor. */
function tokenAt(text: string, cursor: number): Popover | null {
  const before = text.slice(0, cursor)
  const slash = before.match(/^\/([\w:.-]*)$/)
  if (slash) return { kind: 'slash', query: slash[1], start: 0, end: cursor }
  const at = before.match(/(^|\s)@([^\s@]*)$/)
  if (at) return { kind: 'mention', query: at[2], start: cursor - at[2].length - 1, end: cursor }
  return null
}

export function Composer({
  host,
  pane,
  agent,
  working,
  disabled,
  controls,
}: {
  host: string
  pane: string
  agent?: AgentKind
  working: boolean
  disabled?: boolean
  /** model, effort, mode and goal pickers for this agent */
  controls?: React.ReactNode
}) {
  const key = chatKey(host, pane)
  const serverDraft = useStore((s) => s.chats[key]?.draft)
  const [text, setTextState] = useState(() => DRAFTS.get(key) ?? serverDraft?.text ?? '')
  const shellMode = !!agent && AGENTS[agent].shell && text.trimStart().startsWith('!')
  const [focused, setFocused] = useState(false)
  const [origin, setOrigin] = useState<'app' | 'terminal' | null>(null)
  /** the text both sides last agreed on, so we can tell who changed what */
  const synced = useRef(serverDraft?.text ?? text)
  const pushTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** user edits: save locally and push to the hub (which mirrors into the terminal) */
  const setText = (v: string | ((p: string) => string)) => {
    setTextState((prev) => {
      const next = typeof v === 'function' ? v(prev) : v
      clearTimeout(pushTimer.current)
      pushTimer.current = setTimeout(() => {
        if (next !== synced.current) {
          synced.current = next
          socket.send({ t: 'draft', host, pane, text: next })
          setOrigin('app')
        }
      }, 450)
      return next
    })
  }
  // a draft from the terminal (or another device): adopt it unless you're mid-edit with other text
  useEffect(() => {
    if (!serverDraft) return
    if (serverDraft.text === synced.current) return
    const mine = text !== synced.current && focused
    if (mine) return
    synced.current = serverDraft.text
    setTextState(serverDraft.text)
    setOrigin(serverDraft.source)
  }, [serverDraft?.at])
  const files = useFiles(key)
  const setFiles = useCallback((v: Attachment[] | ((f: Attachment[]) => Attachment[])) => updateFiles(key, typeof v === 'function' ? v : () => v), [key])
  const [pop, setPop] = useState<Popover | null>(null)
  const [active, setActive] = useState(0)
  const [commands, setCommands] = useState<SlashCommand[] | null>(null)
  const [paths, setPaths] = useState<string[] | null>(null)
  const [dragging, setDragging] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const agentName = agent ? AGENTS[agent].name : 'the agent'

  useEffect(() => {
    DRAFTS.set(key, text)
  }, [key, text])

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    const max = window.innerHeight * 0.4
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    // phones round line heights, which leaves a 1px overflow and a pointless scrollbar
    el.style.overflowY = el.scrollHeight > max + 1 ? 'auto' : 'hidden'
  }, [text])

  // ---------- suggestions ----------

  useEffect(() => {
    if (pop?.kind === 'slash' && !commands) api.commands(host, pane).then(setCommands).catch(() => setCommands([]))
    if (pop?.kind === 'mention' && !paths) api.files(host, pane).then((r) => setPaths(r.files)).catch(() => setPaths([]))
  }, [pop?.kind])

  const suggestions = useMemo(() => {
    if (!pop) return []
    if (pop.kind === 'slash') {
      const list = commands ?? AGENTS[agent ?? 'claude'].commands
      return list
        .map((c) => ({ c, s: fuzzy(pop.query, c.name.slice(1)) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name))
        .slice(0, 40)
        .map(({ c }) => ({ key: c.name, label: c.name, hint: c.description, tag: c.source === 'built-in' ? undefined : c.source, item: c }))
    }
    const all = paths ?? []
    const dirs = new Set<string>()
    for (const p of all) {
      const parts = p.split('/')
      for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`)
    }
    const pool = [...all, ...dirs]
    return pool
      .map((p) => ({ p, s: fuzzy(pop.query, p) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.p.length - b.p.length)
      .slice(0, 40)
      .map(({ p }) => ({ key: p, label: p, hint: undefined as string | undefined, tag: p.endsWith('/') ? 'folder' : undefined, item: p }))
  }, [pop, commands, paths, agent])

  useEffect(() => setActive(0), [pop?.query, pop?.kind])

  const updatePop = () => {
    const el = ta.current
    if (!el) return
    setPop(tokenAt(el.value, el.selectionStart ?? el.value.length))
  }

  const pick = (i: number) => {
    const s = suggestions[i]
    if (!s || !pop) return
    if (pop.kind === 'slash') {
      const c = s.item as SlashCommand
      const menu = MENU_COMMANDS[c.name]
      if (menu && !text.slice(pop.end).trim() && (menu !== 'mode' || agent === 'opencode') && openMenu(menu)) {
        setText('')
        setPop(null)
        return
      }
      if (c.instant && !files.length) {
        setPop(null)
        send(c.name)
        return
      }
      const next = `${c.name} ${text.slice(pop.end).trimStart()}`
      setText(next)
      requestAnimationFrame(() => ta.current?.setSelectionRange(c.name.length + 1, c.name.length + 1))
    } else {
      const ins = `@${s.item as string}${(s.item as string).endsWith('/') ? '' : ' '}`
      const next = text.slice(0, pop.start) + ins + text.slice(pop.end)
      setText(next)
      const at = pop.start + ins.length
      requestAnimationFrame(() => ta.current?.setSelectionRange(at, at))
    }
    setPop(null)
    ta.current?.focus()
  }

  // ---------- attachments ----------

  const addFiles = useCallback(
    (list: File[], pastedLines?: number) => {
      for (const file of list) {
        const id = Math.random().toString(36).slice(2)
        const set = (fn: (f: Attachment[]) => Attachment[]) => updateFiles(key, fn)
        const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
        set((f) => [...f, { id, name: file.name || 'pasted', size: file.size, type: file.type, preview, progress: 0, status: 'uploading', pastedLines }])
        api
          .upload(host, pane, file, (progress) => set((f) => f.map((a) => (a.id === id ? { ...a, progress } : a))))
          .then((u: Uploaded) => set((f) => f.map((a) => (a.id === id ? { ...a, status: 'done', progress: 1, path: u.path } : a))))
          .catch((e) => set((f) => f.map((a) => (a.id === id ? { ...a, status: 'error', error: e.message } : a))))
      }
    },
    [host, pane, key],
  )

  const removeFile = (id: string) =>
    setFiles((f) => {
      const a = f.find((x) => x.id === id)
      if (a?.preview) URL.revokeObjectURL(a.preview)
      return f.filter((x) => x.id !== id)
    })

  /**
   * Handles a paste from the text box or from anywhere on the page. Returns true when it took
   * care of it: files and screenshots become attachments, very long text becomes a text file.
   */
  const handlePaste = (data: DataTransfer, insertText: boolean): boolean => {
    const files = clipboardFiles(data)
    if (files.length) {
      addFiles(files)
      return true
    }
    const pasted = data.getData('text/plain')
    const lines = pasted.split('\n').length
    if (lines > LONG_PASTE_LINES) {
      addFiles([new File([pasted], `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.txt`, { type: 'text/plain' })], lines)
      return true
    }
    if (insertText && pasted) {
      setText((v) => (v ? `${v}${/\s$/.test(v) ? '' : ' '}${pasted}` : pasted))
      requestAnimationFrame(() => {
        const el = ta.current
        el?.focus()
        el?.setSelectionRange(el.value.length, el.value.length)
      })
      return true
    }
    return false
  }

  const onPaste = (e: React.ClipboardEvent) => {
    if (handlePaste(e.clipboardData, false)) e.preventDefault()
  }

  // Ctrl+V anywhere on the page lands here, and typing with nothing focused starts a message
  const pasteRef = useRef(handlePaste)
  pasteRef.current = handlePaste
  useEffect(() => {
    const free = (t: EventTarget | null) => !(t instanceof HTMLElement) || !(t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('.xterm, [role=dialog]'))
    const onDocPaste = (e: ClipboardEvent) => {
      if (disabled || !e.clipboardData || !free(e.target) || e.target === ta.current) return
      if (pasteRef.current(e.clipboardData, true)) e.preventDefault()
    }
    const onKey = (e: KeyboardEvent) => {
      if (disabled || touch || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !free(e.target)) return
      if (e.key.length === 1 && !window.getSelection()?.toString()) ta.current?.focus() // the key then types into the box
    }
    document.addEventListener('paste', onDocPaste)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('paste', onDocPaste)
      document.removeEventListener('keydown', onKey)
    }
  }, [disabled])

  // the box is what this page is for: ready to type on arrival (not on phones, where that pops the keyboard)
  useEffect(() => {
    if (!touch && !disabled) ta.current?.focus({ preventScroll: true })
  }, [key, disabled])

  // ---------- sending ----------

  const uploading = files.some((f) => f.status === 'uploading')
  const ready = files.filter((f) => f.status === 'done' && f.path)

  const send = async (value = text) => {
    let msg = value.trim()
    if (uploading) return
    // a bare "/model" would open the agent's terminal menu; the app has its own
    const menu = !ready.length && MENU_COMMANDS[msg.toLowerCase()]
    if (menu && (menu !== 'mode' || agent === 'opencode') && openMenu(menu)) {
      setText('')
      setPop(null)
      return
    }
    if (ready.length) msg = `${msg}${msg ? '\n\n' : ''}Attached files:\n${ready.map((f) => f.path).join('\n')}`
    if (!msg) return
    const id = Math.random().toString(36).slice(2)
    patchChat(key, (c) => ({ pending: [...c.pending, { id, text: msg, status: 'sending', at: Date.now() }] }))
    if (value === text) {
      clearTimeout(pushTimer.current)
      synced.current = ''
      setTextState('')
      setOrigin(null)
    }
    // the image previews aren't shown any more: free them (phones run out of memory otherwise)
    setFiles((cur) => {
      for (const f of cur) if (f.preview) URL.revokeObjectURL(f.preview)
      return []
    })
    setPop(null)
    try {
      await api.send(host, pane, msg, id)
      patchChat(key, (c) => ({ pending: c.pending.map((p) => (p.id === id ? { ...p, status: 'sent' } : p)) }))
      haptic('success')
    } catch (e) {
      patchChat(key, (c) => ({ pending: c.pending.map((p) => (p.id === id ? { ...p, status: 'failed', error: (e as Error).message } : p)) }))
    }
  }

  const [stopping, setStopping] = useState(false)
  const stop = async () => {
    setStopping(true)
    haptic('warning')
    try {
      await api.interrupt(host, pane)
    } catch (e) {
      toast({ title: 'Could not stop it', body: (e as Error).message, tone: 'error' })
    } finally {
      setStopping(false)
    }
  }

  const canSend = (!!text.trim() || ready.length > 0) && !uploading && !disabled
  // while it works, an empty box offers Stop; once you type, the same button queues a follow-up
  const showStop = working && !canSend && !uploading

  return (
    <div
      className="relative"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        addFiles([...e.dataTransfer.files])
      }}
    >
      {pop && suggestions.length > 0 && (
        <div className="animate-pop absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-[14px] border border-line bg-elev shadow-float">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[11.5px] text-fg-3">
            {pop.kind === 'slash' ? 'Commands and skills' : `Files in ${paths ? 'this folder' : '…'}`}
            <span className="ml-auto hidden font-mono sm:inline">↑↓ · ⏎ · esc</span>
          </div>
          <div role="listbox" className="max-h-[min(320px,45dvh)] overflow-y-auto p-1">
            {suggestions.map((s, i) => (
              <button
                key={s.key}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
                className={clsx('flex w-full items-center gap-3 rounded-[9px] px-2.5 py-2 text-left', i === active && 'bg-hover')}
              >
                {pop.kind === 'mention' &&
                  (s.tag === 'folder' ? <Folder className="size-4 shrink-0 text-fg-3" /> : <FileText className="size-4 shrink-0 text-fg-3" />)}
                <span className={clsx('shrink-0 font-mono text-[13px]', pop.kind === 'mention' && 'min-w-0 truncate')}>{s.label}</span>
                {s.hint && <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3">{s.hint}</span>}
                {s.tag && pop.kind === 'slash' && (
                  <span className="ml-auto shrink-0 rounded-[5px] border border-line px-1.5 py-px text-[10.5px] text-fg-3">{s.tag}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        className={clsx(
          'rounded-[18px] border bg-elev transition-colors',
          dragging ? 'border-accent' : 'border-line focus-within:border-line-strong',
          disabled && 'opacity-60',
        )}
      >
        {files.length > 0 && (
          <div className="no-scrollbar flex gap-2 overflow-x-auto px-2.5 pt-2.5">
            {files.map((f) => (
              <div key={f.id} className="group/att relative shrink-0">
                {f.preview ? (
                  <div className="relative size-14 overflow-hidden rounded-[10px] border border-line bg-sunken">
                    <img src={f.preview} alt={f.name} className="size-full object-cover" />
                    {f.status === 'uploading' && (
                      <>
                        <div className="absolute inset-0 bg-black/35" />
                        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-white/25">
                          <div className="h-full bg-white transition-[width]" style={{ width: `${Math.round(f.progress * 100)}%` }} />
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="flex h-14 max-w-[220px] items-center gap-2.5 rounded-[10px] border border-line bg-sunken px-3">
                    <FileText className="size-4 shrink-0 text-fg-2" />
                    <div className="min-w-0">
                      <div className="truncate text-[12.5px] font-medium">{f.pastedLines ? 'Pasted text' : f.name}</div>
                      <div className="truncate text-[11px] text-fg-3">
                        {f.status === 'uploading' ? `${Math.round(f.progress * 100)}%` : f.status === 'error' ? f.error : f.pastedLines ? `${f.pastedLines} lines` : bytes(f.size)}
                      </div>
                    </div>
                  </div>
                )}
                {f.status === 'error' && <div className="absolute inset-0 rounded-[10px] ring-2 ring-danger" />}
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => removeFile(f.id)}
                  className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border-2 border-elev bg-fg text-bg"
                >
                  <X className="size-3" strokeWidth={3} />
                </button>
              </div>
            ))}
          </div>
        )}
        {shellMode && <div className="px-1 pb-1 text-[11px] text-fg-3">Shell command · runs in this session’s folder</div>}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value)
            requestAnimationFrame(updatePop)
          }}
          onSelect={updatePop}
          onFocus={() => setFocused(true)}
          onBlur={() => (setFocused(false), setTimeout(() => setPop(null), 120))}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (pop && suggestions.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                return setActive((a) => (a + 1) % suggestions.length)
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                return setActive((a) => (a - 1 + suggestions.length) % suggestions.length)
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault()
                return pick(active)
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                return setPop(null)
              }
            }
            if (e.key === 'Escape' && working && !text) {
              e.preventDefault()
              return void stop()
            }
            if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={working ? `Queue a message for ${agentName}…` : `Message ${agentName}…`}
          className="block max-h-[40vh] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[15.5px] leading-[1.5] text-fg placeholder:text-fg-3"
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <ToolbarButton label="Attach files" onClick={() => fileInput.current?.click()}>
            <Paperclip className="size-[17px]" />
          </ToolbarButton>
          {touch && (
            <ToolbarButton label="Take a photo" onClick={() => cameraInput.current?.click()}>
              <Camera className="size-[17px]" />
            </ToolbarButton>
          )}
          {controls && <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">{controls}</div>}
          <span className={clsx('truncate pr-1 text-[11.5px] text-fg-3', !controls && 'ml-auto')}>
            {uploading ? 'Uploading…' : text && origin === 'terminal' ? 'From the terminal' : ''}
          </span>
          {showStop ? (
            <button
              type="button"
              onClick={stop}
              onMouseDown={(e) => e.preventDefault()}
              disabled={stopping}
              className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-fg text-bg transition-opacity hover:opacity-85 disabled:opacity-50"
              aria-label="Stop"
              title="Stop (Esc in the terminal)"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => send()}
              onMouseDown={(e) => e.preventDefault()}
              disabled={!canSend}
              className={clsx(
                'flex size-8 shrink-0 items-center justify-center rounded-[10px] transition-[background,opacity]',
                canSend ? 'bg-accent text-accent-fg hover:opacity-90' : 'bg-sunken text-fg-3',
              )}
              aria-label={shellMode ? 'Run command' : working ? 'Queue follow-up' : 'Send'}
              title={shellMode ? 'Run shell command' : working ? 'Queue a follow-up' : 'Send'}
            >
              <ArrowUp className="size-[17px]" strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => (addFiles([...(e.target.files ?? [])]), (e.target.value = ''))} />
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (addFiles([...(e.target.files ?? [])]), (e.target.value = ''))} />
    </div>
  )
}

/** Files on a clipboard or drop, from whichever field the browser filled (screenshots often only in items). */
function clipboardFiles(data: DataTransfer): File[] {
  const files = [...data.files]
  if (!files.length) for (const it of data.items ?? []) if (it.kind === 'file') {
    const f = it.getAsFile()
    if (f) files.push(f)
  }
  return files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i}.${f.type.split('/')[1] || 'bin'}`, { type: f.type })))
}

function ToolbarButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-[9px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
    >
      {children}
    </button>
  )
}
