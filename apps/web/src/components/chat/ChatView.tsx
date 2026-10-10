import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, History, Play, SquareTerminal } from 'lucide-react'
import { AGENTS, chatKey, type AgentKind } from '@tether/protocol'
import { socket } from '../../lib/socket.ts'
import { msgKey, patchChat, PENDING_MS, toast, useStore, type PendingMessage } from '../../lib/store.ts'
import { buildRows } from '../../lib/chat.ts'
import { api } from '../../lib/api.ts'
import { AgentLogo, useReplyFont } from '../../lib/skin.tsx'
import { Button, Empty, Spinner } from '../ui/primitives.tsx'
import { AssistantTurn, ChatAgent, ChatRewind, CommandRow, GoalRow, NoticeRow, PendingBubble, QueuedBubble, UserMessage, WorkingIndicator } from './Messages.tsx'
import { ReplyFont } from './Markdown.tsx'
import { PromptCard } from './PromptCard.tsx'
import { ChatJobs } from './Tools.tsx'
import { Composer } from './Composer.tsx'
import { backgroundText } from '../ui/status.tsx'

const NO_AGENTS: AgentKind[] = []
const NO_QUEUE: string[] = []
const NO_PENDING: PendingMessage[] = []

export function ChatView({ host, pane, agent, onTerminal, controls }: { host: string; pane: string; agent?: AgentKind; onTerminal: () => void; controls?: React.ReactNode }) {
  const key = chatKey(host, pane)
  const chat = useStore((s) => s.chats[key])
  const hubUp = useStore((s) => s.connected)
  const machine = useStore((s) => s.hosts.find((h) => h.config.id === host))
  const machineDown = !!machine && machine.status !== 'online'
  const connected = hubUp && !machineDown
  const installed = useStore((s) => s.hosts.find((h) => h.config.id === host)?.agents) ?? NO_AGENTS
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const prevHeight = useRef(0)
  const font = useReplyFont(agent)

  useEffect(() => socket.subscribeChat(host, pane), [host, pane])

  const rows = useMemo(() => buildRows(chat?.items ?? []), [chat?.items])
  const screen = chat?.screen
  const running = chat?.info?.running ?? true
  const working = !!screen?.working
  const prompt = screen?.prompt
  const queue = chat?.info?.queue ?? NO_QUEUE
  const queued = useMemo(() => new Set(queue.map(msgKey)), [queue])
  // a message waiting in the agent's queue shows once, as a queued bubble, until the agent takes it
  const pending = (chat?.pending ?? NO_PENDING).filter((p) => !queued.has(msgKey(p.text)))
  const chatCapable = agent ? AGENTS[agent].chat : true
  const tasks = chat?.info?.tasks
  const subagents = chat?.info?.subagents
  const jobs = useMemo(
    () => ({ tasks: new Map((tasks ?? []).map((t) => [t.id, t])), subagents: new Map((subagents ?? []).map((a) => [a.toolUseId, a])) }),
    [tasks, subagents],
  )

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stick.current = bottom
    setAtBottom(bottom)
  }, [])

  const toBottom = (smooth = false) => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  // keep pinned to the latest message while output streams in
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (loadingMore && prevHeight.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current
      prevHeight.current = 0
      setLoadingMore(false)
      return
    }
    if (stick.current) toBottom()
  }, [rows, working, prompt, loadingMore, pending.length, queue.length])

  useEffect(() => {
    stick.current = true
    requestAnimationFrame(() => toBottom())
  }, [key, chat?.loaded])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => stick.current && toBottom())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // a sent message the agent hasn't written yet: keep the bubble, but say so after a while
  useEffect(() => {
    if (!pending.some((p) => p.status === 'sent')) return
    const t = setInterval(() => patchChat(key, (c) => ({ pending: c.pending.map((p) => p.status === 'sent' && Date.now() - p.at >= PENDING_MS
      ? { ...p, status: 'failed', error: 'Delivery could not be confirmed. Check the terminal before retrying.' }
      : p) })), 5000)
    return () => clearInterval(t)
  }, [key, pending])

  const loadMore = () => {
    const first = chat?.items[0]
    if (!first || loadingMore) return
    prevHeight.current = scroller.current?.scrollHeight ?? 0
    setLoadingMore(true)
    socket.send({ t: 'chat.more', host, pane, before: first.seq })
  }

  const retry = async (id: string, text: string) => {
    patchChat(key, (c) => ({ pending: c.pending.map((p) => (p.id === id ? { ...p, status: 'sending', at: Date.now() } : p)) }))
    try {
      await api.send(host, pane, text, id)
      patchChat(key, (c) => ({ pending: c.pending.map((p) => (p.id === id ? { ...p, status: 'sent' } : p)) }))
    } catch (e) {
      patchChat(key, (c) => ({ pending: c.pending.map((p) => (p.id === id ? { ...p, status: 'failed', error: (e as Error).message } : p)) }))
    }
  }

  const rewind = useCallback(async (text: string) => {
    const short = text.length > 60 ? `${text.slice(0, 60)}…` : text
    if (!confirm(`Rewind to before "${short}"? Codex forgets that message and everything after it.`)) return
    try {
      await api.rewind(host, pane, text)
      toast({ title: 'Conversation rewound', tone: 'success' })
    } catch (e) {
      toast({ title: 'Could not rewind', body: (e as Error).message, tone: 'error' })
    }
  }, [host, pane])

  const lastOpen = (() => {
    const last = rows[rows.length - 1]
    return last?.type === 'assistant' && last.open
  })()

  return (
    <ChatAgent.Provider value={agent}>
    <ChatRewind.Provider value={agent === 'codex' && running && !working ? rewind : undefined}>
    <ChatJobs.Provider value={jobs}>
      <ReplyFont.Provider value={font}>
        <div className="flex min-h-0 flex-1 flex-col">
          <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-[760px] px-4 pt-5 pb-6 sm:px-6">
              {!chat?.loaded ? (
                <div className="space-y-4 pt-4">
                  {[60, 90, 75].map((w, i) => (
                    <div key={i} className="skeleton h-4 rounded" style={{ width: `${w}%` }} />
                  ))}
                </div>
              ) : !running && !rows.length ? (
                <NotRunning host={host} pane={pane} agent={agent} installed={installed} sessionId={chat.info?.sessionId} onTerminal={onTerminal} />
              ) : !chatCapable ? (
                <Empty icon={<AgentLogo kind={agent} size={28} />} title={`${AGENTS[agent!].name} runs in the terminal`} action={<Button onClick={onTerminal}><SquareTerminal className="size-4" /> Open terminal</Button>}>
                  Tether doesn't read {AGENTS[agent!].name}'s conversation files yet, so use the terminal view. Status and notifications still work.
                </Empty>
              ) : (
                <>
                  {chat.hasMore && (
                    <div className="mb-4 flex justify-center">
                      <Button size="sm" variant="ghost" onClick={loadMore} loading={loadingMore}>
                        <History className="size-4" /> Earlier messages
                      </Button>
                    </div>
                  )}
                  {!rows.length && !pending.length && (
                    <Empty icon={<AgentLogo kind={agent} size={28} />} title="New conversation">
                      Messages you send here are typed into the terminal, exactly as if you typed them there.
                    </Empty>
                  )}
                  <div className="space-y-5">
                    {rows.map((r) => {
                      switch (r.type) {
                        case 'user':
                          return <UserMessage key={r.key} row={r} />
                        case 'assistant':
                          return <AssistantTurn key={r.key} row={r} live={working} />
                        case 'command':
                          return <CommandRow key={r.key} row={r} />
                        case 'goal':
                          return <GoalRow key={r.key} row={r} />
                        case 'notice':
                          return <NoticeRow key={r.key} row={r} />
                      }
                    })}
                    {pending.map((p) => (
                      <PendingBubble key={p.id} p={p} onRetry={() => retry(p.id, p.text)} onDismiss={() => patchChat(key, (c) => ({ pending: c.pending.filter((x) => x.id !== p.id) }))} />
                    ))}
                    {queue.map((q, i) => (
                      <QueuedBubble key={`${i}:${q}`} text={q} agent={agent} />
                    ))}
                    {working && !prompt && (
                      <div className={lastOpen ? '-mt-3' : ''}>
                        <WorkingIndicator activity={screen?.activity} />
                      </div>
                    )}
                    {!working && !prompt && screen?.background && (
                      <div className="flex items-center gap-3 py-1 text-[13px] text-fg-3">
                        <div className="flex size-6 shrink-0 items-center justify-center">
                          <span className="size-1.5 rounded-full bg-info pulse-soft" />
                        </div>
                        {backgroundText(screen.background)}
                      </div>
                    )}
                  </div>
                  {!running && (
                    <div className="mt-8">
                      <NotRunning host={host} pane={pane} agent={agent} installed={installed} sessionId={chat.info?.sessionId} onTerminal={onTerminal} compact />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="relative">
            {!atBottom && (
              <button
                type="button"
                onClick={() => {
                  stick.current = true
                  toBottom(true)
                }}
                className="animate-fade-in absolute -top-12 left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-elev text-fg-2 shadow-float hover:text-fg"
                aria-label="Jump to latest"
              >
                <ArrowDown className="size-4" />
              </button>
            )}
            {running && chatCapable && (
              <div className="pb-safe-2 mx-auto w-full max-w-[760px] px-3 pt-1 sm:px-6 sm:pb-4">
                {!hubUp ? (
                  <div className="mb-2 text-center text-[12px] text-fg-3">Reconnecting…</div>
                ) : machineDown ? (
                  <div className="mb-2 text-center text-[12px] text-fg-3">{machine!.config.name} is offline. This is the conversation as last seen; you can send again once it reconnects.</div>
                ) : null}
                {prompt ? <PromptCard prompt={prompt} host={host} pane={pane} /> : <Composer host={host} pane={pane} agent={agent} working={working} disabled={!connected} controls={controls} />}
              </div>
            )}
          </div>
        </div>
      </ReplyFont.Provider>
    </ChatJobs.Provider>
    </ChatRewind.Provider>
    </ChatAgent.Provider>
  )
}

function NotRunning({
  host,
  pane,
  agent,
  installed,
  sessionId,
  onTerminal,
  compact,
}: {
  host: string
  pane: string
  agent?: AgentKind
  installed: AgentKind[]
  sessionId?: string
  onTerminal: () => void
  compact?: boolean
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const kinds = (installed.length ? installed : (['claude'] as AgentKind[])).filter((k, i, a) => a.indexOf(k) === i)
  const start = async (kind: AgentKind, resume?: string) => {
    setBusy(resume ? 'resume' : kind)
    try {
      await api.start(host, pane, kind, resume)
    } catch (e) {
      toast({ title: 'Could not start', body: (e as Error).message, tone: 'error' })
    } finally {
      setTimeout(() => setBusy(null), 2500)
    }
  }
  return (
    <div className={compact ? 'rounded-[16px] border border-line bg-elev p-5 text-center' : 'py-12 text-center'}>
      <p className="text-[15px] font-semibold">No agent is running in this pane</p>
      <p className="mx-auto mt-1 max-w-sm text-[13.5px] text-fg-2">The session ended or the pane is at a shell prompt.</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {sessionId && agent && (
          <Button variant="accent" onClick={() => start(agent, sessionId)} loading={busy === 'resume'}>
            <History className="size-4" /> Resume conversation
          </Button>
        )}
        {kinds.map((k) => (
          <Button key={k} onClick={() => start(k)} loading={busy === k}>
            <AgentLogo kind={k} size={16} /> Start {AGENTS[k].name}
          </Button>
        ))}
        <Button variant="ghost" onClick={onTerminal}>
          <SquareTerminal className="size-4" /> Terminal
        </Button>
      </div>
      {!kinds.length && <Play className="hidden" />}
    </div>
  )
}
