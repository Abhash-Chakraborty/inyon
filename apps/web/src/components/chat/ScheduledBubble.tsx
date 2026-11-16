import { useState } from 'react'
import clsx from 'clsx'
import { CalendarClock, CircleAlert, Pause, Pencil, Play, Repeat as RepeatIcon, Send, X } from 'lucide-react'
import type { DelayedSend } from '@inyon/protocol'
import { api } from '../../lib/api.ts'
import { toast } from '../../lib/store.ts'
import { haptic } from '../../lib/haptics.ts'
import { repeatText, timeText } from '../../lib/organize.ts'
import { contextMenu, copyItem } from '../ui/ContextMenu.tsx'
import { EditRepeatSheet } from '../session/RepeatSheets.tsx'

function failed(title: string, e: unknown) {
  haptic('error')
  toast({ title, body: (e as Error).message, tone: 'error' })
}

const iconButton = 'flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-hover hover:text-fg disabled:opacity-50'

/** The line under a repeating message's rule: where it goes, and paused, waiting for a busy agent, or when it goes next. */
function repeatState(s: DelayedSend) {
  const state = s.paused ? 'Paused' : s.tries ? `Agent busy, trying again at ${timeText(s.at)}` : `Next ${timeText(s.at)}`
  return s.newSession ? `New session each time · ${state}` : state
}

/** A message the hub sends at a set time (from 0.24): it can still go now or be cancelled. One the
 * hub planned to carry on after a plan limit (from 0.27) says so. One that repeats (from 0.27)
 * shows its rule and next time, and can be edited, paused or deleted. */
export function ScheduledBubble({ host, pane, s }: { host: string; pane: string; s: DelayedSend }) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const repeats = !!s.repeat
  // now: off the schedule and into the held queue, in one step on the hub; a repeating one goes
  // once more now and keeps its rule
  const sendNow = async () => {
    setBusy(true)
    try {
      await api.sendNow(host, s.id)
    } catch (e) {
      failed("Couldn't send it", e)
    } finally {
      setBusy(false)
    }
  }
  const cancel = async () => {
    try {
      await api.cancelSend(host, s.id)
      // a carry-on the hub planned stays cancelled for this limit: putting it back would make a plain message
      if (s.auto === 'carry-on') {
        toast({ title: 'Won’t carry on', body: 'Inyon plans it again the next time the session stops on a limit.', tone: 'info' })
        return
      }
      if (s.error) return
      // Undo puts it back as it was: the same rule, or the same time for the same conversation
      const back = repeats
        ? () => api.schedule(host, pane, { text: s.text, repeat: s.repeat, ...(s.newSession && { newSession: true }), ...(s.notify && { notify: true }) })
        : () => api.sendLater(host, pane, s.text, s.at, s.conv ?? undefined)
      toast({ title: repeats ? 'Repeating message deleted' : 'Message cancelled', tone: 'success', action: { label: 'Undo', onSelect: () => void back().catch((e) => failed("Couldn't put it back", e)) } })
    } catch (e) {
      failed(repeats ? "Couldn't delete it" : "Couldn't cancel it", e)
    }
  }
  const pause = async (paused: boolean) => {
    setBusy(true)
    try {
      await api.editSend(host, s.id, { paused })
    } catch (e) {
      failed(paused ? "Couldn't pause it" : "Couldn't resume it", e)
    } finally {
      setBusy(false)
    }
  }
  const remove = s.error ? 'Dismiss' : repeats ? 'Delete' : 'Cancel'
  const rule = repeats ? repeatText(s.repeat!) : ''
  return (
    <div className="flex flex-col items-end">
      <div
        {...contextMenu(() => [
          { key: 'now', label: 'Send now', icon: <Send className="size-4" />, disabled: busy, onSelect: () => void sendNow() },
          repeats && { key: 'edit', label: 'Edit…', icon: <Pencil className="size-4" />, onSelect: () => setEditing(true) },
          repeats && { key: 'pause', label: s.paused ? 'Resume' : 'Pause', icon: s.paused ? <Play className="size-4" /> : <Pause className="size-4" />, disabled: busy, onSelect: () => void pause(!s.paused) },
          copyItem('copy', 'Copy message', s.text, 'Message'),
          { key: 'cancel', label: remove, icon: <X className="size-4" />, separated: true, danger: !s.error, onSelect: () => void cancel() },
        ])}
        className={clsx(
          'max-w-[88%] whitespace-pre-wrap break-words rounded-3xl border border-dashed px-4 py-2.5 text-[15px] leading-[1.55] text-fg-2 sm:max-w-[78%]',
          s.error ? 'border-danger/60' : 'border-line-strong',
          s.paused && 'opacity-60',
        )}
      >
        {s.text}
      </div>
      <div className="mt-1 flex h-6 max-w-full items-center gap-1.5 px-1 text-[12px] text-fg-3">
        {s.error ? (
          <span className="flex min-w-0 items-center gap-1 text-danger">
            <CircleAlert className="size-3 shrink-0" /> <span className="truncate">{s.error}</span>
          </span>
        ) : repeats ? (
          <span className="flex min-w-0 items-center gap-1" title={rule}>
            <RepeatIcon className="size-3 shrink-0" /> <span className="truncate">{rule}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <CalendarClock className="size-3" /> {s.auto === 'carry-on' ? 'Carries on at' : 'Sends at'} {timeText(s.at)}
          </span>
        )}
        {repeats ? (
          <>
            <button type="button" onClick={() => setEditing(true)} title="Edit" aria-label="Edit" className={iconButton}>
              <Pencil className="size-3.5" />
            </button>
            <button type="button" onClick={() => void pause(!s.paused)} disabled={busy} title={s.paused ? 'Resume' : 'Pause'} aria-label={s.paused ? 'Resume' : 'Pause'} className={iconButton}>
              {s.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => void sendNow()} disabled={busy} title="Send now" aria-label="Send now" className={iconButton}>
            <Send className="size-3.5" />
          </button>
        )}
        <button type="button" onClick={() => void cancel()} title={remove} aria-label={remove} className={iconButton}>
          <X className="size-3.5" />
        </button>
      </div>
      {repeats && !s.error && <p className="tabular -mt-0.5 px-1 text-[12px] text-fg-3">{repeatState(s)}</p>}
      {repeats && !s.error && !!s.skipped && !s.tries && <p className="px-1 text-[12px] text-fg-3">Skipped {timeText(s.skipped)}: the agent was busy</p>}
      {repeats && <EditRepeatSheet host={host} s={s} open={editing} onClose={() => setEditing(false)} />}
    </div>
  )
}
