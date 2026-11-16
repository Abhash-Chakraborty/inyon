import { useState } from 'react'
import clsx from 'clsx'
import { Repeat as RepeatIcon } from 'lucide-react'
import { agentDef, type AgentKind, type DelayedSend, type Repeat, type RepeatEvery } from '@inyon/protocol'
import { api } from '../../lib/api.ts'
import { toast, useStore } from '../../lib/store.ts'
import { useOpened } from '../../lib/useOpened.ts'
import { dayName, deviceZone, firstRun, REPEAT_HOURS, repeatText, timeText, WEEK_ORDER } from '../../lib/organize.ts'
import { allPanes } from '../../lib/overview.ts'
import { Button, Field, Segmented, Sheet, Toggle, inputClass } from '../ui/primitives.tsx'
import { Select } from '../ui/Select.tsx'

/** What the repeat fields hold while they're being set. */
export interface RepeatDraft {
  every: RepeatEvery
  hours: number
  /** minutes after midnight */
  minute: number
  /** 0 is Sunday */
  day: number
  newSession: boolean
  notify: boolean
}

/** Every weekday morning at 9:00, into this session, quietly: where a new rule starts. */
export const NEW_REPEAT: RepeatDraft = { every: 'day', hours: 3, minute: 9 * 60, day: 1, newSession: false, notify: false }

export function draftOf(s: DelayedSend): RepeatDraft {
  const r = s.repeat
  return {
    every: r?.every ?? 'day',
    hours: r?.hours ?? 3,
    minute: r?.minute ?? 9 * 60,
    day: r?.day ?? 1,
    newSession: !!s.newSession,
    notify: !!s.notify,
  }
}

/** The rule the hub keeps, in this device's time zone. */
export function ruleOf(d: RepeatDraft, now = new Date()): Repeat {
  const zone = deviceZone(now)
  if (d.every === 'hours') return { every: 'hours', hours: d.hours, ...zone }
  return { every: d.every, minute: d.minute, ...(d.every === 'week' && { day: d.day }), ...zone }
}

/** Whether two drafts make the same rule (a time zone aside). */
const sameRule = (a: RepeatDraft, b: RepeatDraft) =>
  a.every === b.every && (a.every === 'hours' ? a.hours === b.hours : a.minute === b.minute && (a.every !== 'week' || a.day === b.day))

const EVERY: { value: RepeatEvery; label: string }[] = [
  { value: 'day', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'week', label: 'Every week' },
  { value: 'hours', label: 'Every few hours' },
]

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: new Date(2000, 0, 3, h).toLocaleTimeString([], { hour: 'numeric' }) }))
const MINUTES = Array.from({ length: 12 }, (_, i) => ({ value: String(i * 5), label: String(i * 5).padStart(2, '0') }))

/** The rule, where each time goes and whether it says so: the part of the Send later sheet that repeats. */
export function RepeatFields({ value: d, onChange, agent }: { value: RepeatDraft; onChange: (d: RepeatDraft) => void; agent?: AgentKind }) {
  const set = (p: Partial<RepeatDraft>) => onChange({ ...d, ...p })
  const finished = useStore((s) => s.settings.notifyDone)
  // only an agent that takes a first message as it starts can start a session for one
  const canStart = !!agent && agentDef(agent).chat
  const name = agent ? agentDef(agent).name : 'the agent'
  // a time between the five-minute marks (set elsewhere) stays as it is
  const minutes = MINUTES.some((m) => Number(m.value) === d.minute % 60) ? MINUTES : [...MINUTES, { value: String(d.minute % 60), label: String(d.minute % 60).padStart(2, '0') }]
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Repeats">
          <Select title="Repeats" value={d.every} onChange={(every) => set({ every })} options={EVERY} />
        </Field>
        {d.every === 'hours' ? (
          <Field label="Every">
            <Select title="Every" value={String(d.hours)} onChange={(h) => set({ hours: Number(h) })} options={REPEAT_HOURS.map((h) => ({ value: String(h), label: h === 1 ? '1 hour' : `${h} hours` }))} />
          </Field>
        ) : (
          <Field label="At">
            <span className="flex items-center gap-2">
              <Select title="Hour" aria-label="Hour" value={String(Math.floor(d.minute / 60))} onChange={(h) => set({ minute: Number(h) * 60 + (d.minute % 60) })} options={HOURS} />
              <Select title="Minutes" aria-label="Minutes" value={String(d.minute % 60)} onChange={(m) => set({ minute: Math.floor(d.minute / 60) * 60 + Number(m) })} options={minutes} />
            </span>
          </Field>
        )}
      </div>
      {d.every === 'week' && (
        <Field label="On">
          <Select title="On" value={String(d.day)} onChange={(day) => set({ day: Number(day) })} options={WEEK_ORDER.map((day) => ({ value: String(day), label: dayName(day) }))} />
        </Field>
      )}
      {canStart && (
        <div>
          <span className="mb-1.5 block text-[12.5px] font-medium text-fg-2">Goes to</span>
          <Segmented
            full
            label="Goes to"
            value={d.newSession ? 'new' : 'here'}
            onChange={(v) => set({ newSession: v === 'new' })}
            options={[
              { v: 'here', label: 'This session' },
              { v: 'new', label: 'A new session' },
            ]}
          />
        </div>
      )}
      <p className="text-[12px] leading-relaxed text-fg-3">
        {d.newSession ? `Starts ${name} in this folder each time, with this as its first message.` : `It goes only while ${name} is idle with nothing typed. If it's busy, Inyon tries again for 25 minutes, then skips that time.`}
      </p>
      <div className="flex items-center gap-3 border-t border-line pt-3">
        <span className="min-w-0 flex-1 text-[13px] text-fg-2">Tell me each time it goes</span>
        <Toggle on={d.notify} onChange={(notify) => set({ notify })} label="Tell me each time it goes" />
      </div>
      {d.notify && !finished && (
        <p className="-mt-2 text-[12px] leading-relaxed text-fg-3">It comes with the finished notices, which are off on this device. Turn on “When an agent finishes” in Settings to get it.</p>
      )}
    </div>
  )
}

/** "First Tue 9:00", by this device's clock, before the hub has it. */
export function FirstRun({ d }: { d: RepeatDraft }) {
  const now = new Date()
  return <span className="tabular min-w-0 truncate font-mono text-[12px] text-fg-3">First {timeText(firstRun(ruleOf(d, now), now), now)}</span>
}

/** The agent running in a pane now, if any. */
export const usePaneAgent = (host: string, pane: string) =>
  useStore((s) => allPanes(s.hosts).find((r) => r.host.config.id === host && r.pane.id === pane)?.pane.agent?.kind)

/** Changes a repeating message: its text, its rule, where it goes and its notice. */
export function EditRepeatSheet({ host, s, open, onClose }: { host: string; s: DelayedSend; open: boolean; onClose: () => void }) {
  const [text, setText] = useState(s.text)
  const [d, setD] = useState(() => draftOf(s))
  const [busy, setBusy] = useState(false)
  const agent = usePaneAgent(host, s.pane) ?? s.newSession?.agent
  useOpened(open, s.id, () => (setText(s.text), setD(draftOf(s))))
  const save = async () => {
    setBusy(true)
    try {
      const was = draftOf(s)
      await api.editSend(host, s.id, {
        ...(text.trim() !== s.text && { text: text.trim() }),
        // the rule keeps the zone it was set in unless it changes
        ...(!sameRule(d, was) && { repeat: ruleOf(d) }),
        ...(d.newSession !== was.newSession && { newSession: d.newSession }),
        ...(d.notify !== was.notify && { notify: d.notify }),
      })
      onClose()
    } catch (e) {
      toast({ title: "Couldn't change it", body: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Repeating message"
      icon={<RepeatIcon className="size-4 text-fg-3" />}
      footer={
        <div className="flex items-center gap-2">
          <FirstRun d={d} />
          <Button className="ml-auto" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="repeat-edit-form" loading={busy} disabled={!text.trim()}>
            Save
          </Button>
        </div>
      }
    >
      <form id="repeat-edit-form" className="space-y-4" onSubmit={(e) => (e.preventDefault(), void save())}>
        <Field label="Message">
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} className={clsx(inputClass, 'h-auto resize-none py-2.5 leading-relaxed')} />
        </Field>
        <RepeatFields value={d} onChange={setD} agent={agent} />
      </form>
    </Sheet>
  )
}

/** Sends a repeating message on its way: the toast says when it first goes. */
export async function scheduleRepeat(host: string, pane: string, text: string, d: RepeatDraft) {
  const repeat = ruleOf(d)
  const s = await api.schedule(host, pane, { text, repeat, ...(d.newSession && { newSession: true }), ...(d.notify && { notify: true }) })
  toast({
    title: repeatText(repeat),
    body: `First ${timeText(s.at)}, on every device.`,
    tone: 'success',
    action: { label: 'Undo', onSelect: () => void api.cancelSend(host, s.id).catch((e) => toast({ title: 'Could not undo', body: (e as Error).message, tone: 'error' })) },
  })
  return s
}
