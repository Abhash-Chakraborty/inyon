import { createContext, memo, useContext, useState } from 'react'
import clsx from 'clsx'
import {
  Clock3,
  AlertTriangle, Check, ChevronRight, CircleAlert, CornerDownLeft, Image as ImageIcon, Info, Layers, Lightbulb,
  Loader2, RadioTower, RotateCcw, SquareTerminal, Target, CircleCheck, CircleX, X,
} from 'lucide-react'
import { AGENTS, type AgentKind } from '@tether/protocol'
import type { Part, Row } from '../../lib/chat.ts'
import type { PendingMessage } from '../../lib/store.ts'
import { clock, duration } from '../../lib/format.ts'
import { AgentSpinner } from '../ui/status.tsx'
import { AntigravityMark, CodexMark, TileMark } from '../ui/AgentMarks.tsx'
import { CopyButton, Markdown } from './Markdown.tsx'
import { SpecialTool, ToolGroup } from './Tools.tsx'

/** Which agent is speaking (for avatars and spinners). */
export const ChatAgent = createContext<AgentKind | undefined>(undefined)
/** Rewinds the conversation to just before a message, when the agent can (Codex). */
export const ChatRewind = createContext<((text: string) => void) | undefined>(undefined)

export const UserMessage = memo(function UserMessage({ row }: { row: Extract<Row, { type: 'user' }> }) {
  const { item } = row
  const rewind = useContext(ChatRewind)
  const [expanded, setExpanded] = useState(false)
  const long = item.text.length > 1200 || item.text.split('\n').length > 18
  if (item.shell) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-[16px] bg-bubble px-3.5 py-2 font-mono text-[13px]">
          <span className="mr-2 text-accent-text">!</span>
          {item.text}
        </div>
      </div>
    )
  }
  return (
    <div className="group flex flex-col items-end">
      <div
        className={clsx(
          'relative max-w-[88%] whitespace-pre-wrap break-words rounded-[18px] bg-bubble px-4 py-2.5 text-[15px] leading-[1.55] sm:max-w-[78%]',
          long && !expanded && 'max-h-80 overflow-hidden',
        )}
      >
        {item.images > 0 && (
          <span className="mb-1.5 mr-1.5 inline-flex items-center gap-1 rounded-md bg-elev/70 px-1.5 py-0.5 text-xs text-fg-2">
            <ImageIcon className="size-3.5" />
            {item.images} image{item.images > 1 ? 's' : ''}
          </span>
        )}
        <LinkedPaths text={item.text} />
        {long && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-bubble via-bubble/95 to-transparent pt-10 pb-2 text-[13px] font-medium text-fg-2"
          >
            Show more
          </button>
        )}
      </div>
      <div className="mt-1 flex h-6 items-center gap-1 px-1 text-[11.5px] text-fg-3 opacity-0 transition-opacity group-hover:opacity-100 max-sm:opacity-100">
        {item.queued && <span className="mr-1">Sent while the agent was working ·</span>}
        <span>{clock(item.ts)}</span>
        <CopyButton text={item.text} />
        {rewind && (
          <button
            type="button"
            title="Rewind to here"
            aria-label="Rewind to here"
            onClick={() => rewind(item.text)}
            className="grid size-6 place-items-center rounded-md hover:bg-elev hover:text-fg"
          >
            <RotateCcw className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
})

/** Uploaded files show as chips instead of long paths. */
function LinkedPaths({ text }: { text: string }) {
  const parts = text.split(/(@?\/[^\s]*\/\.tether\/uploads\/[^\s]+)/g)
  return (
    <>
      {parts.map((p, i) =>
        /\.tether\/uploads\//.test(p) ? (
          <span key={i} className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-elev/70 px-1.5 py-px align-baseline font-mono text-[12px] text-fg-2">
            <ImageIcon className="size-3 shrink-0" />
            <span className="truncate">{p.split('/').pop()!.replace(/^\d{6}-/, '')}</span>
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

export function PendingBubble({ p, onRetry, onDismiss }: { p: PendingMessage; onRetry: () => void; onDismiss: () => void }) {
  return (
    <div className="flex flex-col items-end">
      <div className={clsx('max-w-[88%] whitespace-pre-wrap break-words rounded-[18px] bg-bubble px-4 py-2.5 text-[15px] leading-[1.55] sm:max-w-[78%]', p.status !== 'failed' && 'opacity-70')}>
        <LinkedPaths text={p.text} />
      </div>
      <div className="mt-1 flex h-6 items-center gap-1.5 px-1 text-[11.5px] text-fg-3">
        {p.status === 'sending' && (
          <>
            <Loader2 className="size-3 animate-spin" /> {p.remote ? 'Sending from another device' : 'Sending'}
          </>
        )}
        {p.status === 'sent' && (
          <>
            <Check className="size-3" /> {p.remote ? 'Sent from another device' : 'Sent'}
          </>
        )}
        {p.status === 'failed' && (
          <button type="button" onClick={onRetry} className="flex items-center gap-1 text-danger">
            <CircleAlert className="size-3" /> {p.error ?? 'Not sent'} · <RotateCcw className="size-3" /> Retry
          </button>
        )}
        <CopyButton text={p.text} />
        {p.status === 'failed' && (
          <button type="button" onClick={onDismiss} title="Dismiss" aria-label="Dismiss" className="flex size-6 items-center justify-center rounded-md hover:bg-hover hover:text-fg">
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

/** A message sitting in the agent's queue: it becomes a normal bubble here once the agent takes it. */
export function QueuedBubble({ text, agent }: { text: string; agent?: AgentKind }) {
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-[18px] border border-dashed border-line-strong px-4 py-2.5 text-[15px] leading-[1.55] text-fg-2 sm:max-w-[78%]">
        <LinkedPaths text={text} />
      </div>
      <div className="mt-1 flex h-6 items-center gap-1.5 px-1 text-[11.5px] text-fg-3">
        <Clock3 className="size-3" /> Queued · {agent ? AGENTS[agent].name : 'the agent'} reads it at its next step
      </div>
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1 -mx-2">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-[13px] text-fg-3 hover:bg-hover">
        <Lightbulb className="size-[15px]" />
        <span className="font-medium">Thinking</span>
        <ChevronRight className={clsx('size-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && <div className="animate-fade-in ml-[30px] whitespace-pre-wrap border-l border-line-strong pl-3 text-[13.5px] italic leading-relaxed text-fg-2">{text}</div>}
    </div>
  )
}

function PartView({ part, live }: { part: Part; live: boolean }) {
  switch (part.type) {
    case 'text':
      return <Markdown text={part.text} className="my-2" />
    case 'thinking':
      return <Thinking text={part.text} />
    case 'tools':
      return <ToolGroup calls={part.calls} live={live} />
    case 'special':
      return <SpecialTool call={part.call} live={live} />
    case 'notice':
      return part.item.subtype === 'task' ? <JobFinished item={part.item} /> : <div className="my-2 text-[13px] text-fg-3">Interrupted</div>
  }
}

/** A background shell, monitor or subagent finishing, where it happened in the conversation. */
function JobFinished({ item }: { item: Extract<Row, { type: 'notice' }>['item'] }) {
  const failed = item.level !== 'info'
  const Icon = failed ? CircleX : CircleCheck
  return (
    <div className="my-1 flex items-center gap-2.5 px-0 py-1 text-[12.5px] text-fg-3">
      <Icon className={clsx('size-4 shrink-0', failed ? 'text-danger' : 'text-ok')} />
      <span className="min-w-0 truncate">{item.text}</span>
      <span className="ml-auto shrink-0 tabular text-[11px]">{clock(item.ts)}</span>
    </div>
  )
}

export function AgentMark({ active }: { active?: boolean }) {
  const kind = useContext(ChatAgent)
  if (kind === 'antigravity') return <AntigravityMark active={active} className="size-[18px]" />
  if (kind === 'codex') return <CodexMark active={active} className="size-[19px]" />
  // a still frame of a text spinner reads as stray dots; these agents show their tile instead
  if (kind === 'gemini' || kind === 'copilot' || kind === 'opencode') return <TileMark kind={kind} active={active} className="size-[19px] rounded-[5px]" />
  return <AgentSpinner kind={kind} active={active} className="text-[19px]" />
}

export const AssistantTurn = memo(function AssistantTurn({ row, live }: { row: Extract<Row, { type: 'assistant' }>; live: boolean }) {
  const text = row.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n\n')
  return (
    <div className="group flex gap-3">
      <div className="mt-[2px] hidden size-6 shrink-0 items-center justify-center sm:flex">
        <AgentMark />
      </div>
      <div className="min-w-0 flex-1">
        {row.parts.map((p) => (
          <PartView key={p.key} part={p} live={live && row.open} />
        ))}
        {!row.open && (
          <div className="mt-1 flex h-7 items-center gap-1 text-[11.5px] text-fg-3 opacity-0 transition-opacity group-hover:opacity-100 max-sm:opacity-100">
            {text && <CopyButton text={text} className="-ml-1.5" />}
            <span>{clock(row.ts)}</span>
            {row.durationMs ? <span>· worked {duration(row.durationMs)}</span> : null}
          </div>
        )}
      </div>
    </div>
  )
})

export function CommandRow({ row }: { row: Extract<Row, { type: 'command' }> }) {
  const [open, setOpen] = useState(false)
  const shell = row.name === '!'
  const out = row.output?.replace(/\x1b\[[0-9;]*m/g, '').trim()
  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        onClick={() => out && setOpen(!open)}
        className={clsx('inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-elev px-3 py-1 text-[12.5px] text-fg-2', out && 'hover:bg-hover')}
      >
        {shell && <SquareTerminal className="size-3.5 text-fg-3" />}
        <span className="truncate font-mono text-[12px]">
          {shell ? 'shell output' : row.name ? `/${row.name.replace(/^\/+/, '')}${row.args ? ` ${row.args}` : ''}` : 'command output'}
        </span>
        {out && <ChevronRight className={clsx('size-3.5 text-fg-3 transition-transform', open && 'rotate-90')} />}
      </button>
      {open && out && (
        <pre className="animate-fade-in mt-2 max-h-72 w-full overflow-auto whitespace-pre-wrap rounded-[10px] border border-line bg-code px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-fg-2">
          {out}
        </pre>
      )}
    </div>
  )
}

export function GoalRow({ row }: { row: Extract<Row, { type: 'goal' }> }) {
  const { item } = row
  return (
    <div className={clsx('flex items-start gap-2.5 rounded-[12px] border px-3.5 py-2.5 text-[13.5px]', item.met ? 'border-ok/30 bg-ok-soft/60' : 'border-dashed border-line-strong')}>
      <Target className={clsx('mt-0.5 size-4 shrink-0', item.met ? 'text-ok' : 'text-fg-3')} />
      <div className="min-w-0">
        <div className="font-medium">{item.met ? 'Goal met' : item.cleared ? 'Goal cleared' : 'Goal set'}</div>
        <div className="mt-0.5 line-clamp-3 text-fg-2">{item.condition}</div>
        {item.met && item.reason && <div className="mt-1 line-clamp-3 text-[12.5px] text-fg-3">{item.reason}</div>}
      </div>
    </div>
  )
}

export function NoticeRow({ row }: { row: Extract<Row, { type: 'notice' }> }) {
  const { item } = row
  if (item.subtype === 'task') return <JobFinished item={item} />
  if (item.subtype === 'compact') {
    return (
      <div className="flex items-center gap-3 py-1 text-[12px] text-fg-3">
        <div className="h-px flex-1 bg-line" />
        <Layers className="size-3.5" />
        {item.text}
        <div className="h-px flex-1 bg-line" />
      </div>
    )
  }
  if (item.subtype === 'rc') {
    return (
      <div className="flex items-center justify-center gap-2 py-0.5 text-[12px] text-fg-3">
        <RadioTower className="size-3.5" />
        Remote Control turned on
      </div>
    )
  }
  if (item.subtype === 'recap') {
    return (
      <div className="rounded-[12px] border border-line bg-sunken px-4 py-3 text-[13.5px] leading-relaxed text-fg-2">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-fg-3 uppercase">
          <CornerDownLeft className="size-3.5" /> While you were away
        </div>
        {item.text}
      </div>
    )
  }
  const Icon = item.level === 'info' ? Info : AlertTriangle
  return (
    <div
      className={clsx(
        'flex items-start gap-2 rounded-[10px] px-3.5 py-2.5 text-[13.5px]',
        item.level === 'error' ? 'bg-danger-soft text-danger' : item.level === 'warn' ? 'bg-warn-soft text-warn' : 'bg-sunken text-fg-2',
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{item.text}</span>
    </div>
  )
}

export function WorkingIndicator({ activity, since }: { activity?: string; since?: number }) {
  const [verb, rest] = (activity ?? 'Working…').split(/ \((.*)\)$/)
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="flex size-6 shrink-0 items-center justify-center">
        <AgentMark active />
      </div>
      <div className="min-w-0 truncate text-[13.5px]">
        <span className="font-medium text-accent-text">{verb}</span>
        {rest ? (
          <span className="text-fg-3"> {rest.replace(/\s*·\s*esc to interrupt/i, '')}</span>
        ) : since ? (
          <span className="text-fg-3"> {duration(Date.now() - since)}</span>
        ) : null}
      </div>
    </div>
  )
}
