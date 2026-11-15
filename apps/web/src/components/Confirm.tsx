import clsx from 'clsx'
import { create } from 'zustand'
import { Button, Sheet, Toggle } from './ui/primitives.tsx'

/** A switch under the question, such as "Remove the worktree too". `note` says why it is set as it is. */
export interface AskOption {
  label: string
  on: boolean
  disabled?: boolean
  note?: string
}

interface ConfirmOpts {
  title: string
  body?: string
  /** what it acts on, as label and value rows */
  details?: [string, string][]
  yes: string
  danger?: boolean
}

interface Ask extends ConfirmOpts {
  id: number
  option?: AskOption
  answer: (ok: boolean, option: boolean) => void
}

const useAsk = create<{ ask?: Ask; open: boolean }>(() => ({ open: false }))
let asked = 0

function ask(o: ConfirmOpts, option?: AskOption, later?: Promise<AskOption>): Promise<{ ok: boolean; option: boolean }> {
  useAsk.getState().ask?.answer(false, false)
  const id = ++asked
  // the option as it becomes known, while this question is still the one open
  later?.then((next) => {
    const cur = useAsk.getState().ask
    if (cur?.id === id) useAsk.setState({ ask: { ...cur, option: next } })
  }, () => {})
  return new Promise((resolve) => useAsk.setState({ open: true, ask: { ...o, id, option, answer: (ok, opt) => resolve({ ok, option: opt }) } }))
}

/**
 * Asks before something that can't be undone, in the app's own sheet: the browser's confirm() is a
 * bare system dialog on Android. Resolves false when dismissed.
 */
export function confirmAction(o: ConfirmOpts): Promise<boolean> {
  return ask(o).then((r) => r.ok)
}

/**
 * The same question with a switch under it. `later` replaces the option once it's known (it may
 * need a look at the machine first); `option` is whether the switch was on when the answer was yes.
 */
export function confirmWithOption(o: ConfirmOpts & { option?: AskOption; later?: Promise<AskOption> }) {
  const { option, later, ...rest } = o
  return ask(rest, option, later)
}

export function ConfirmHost() {
  const { ask, open } = useAsk()
  if (!ask) return null
  const done = (ok: boolean) => {
    ask.answer(ok, ok && !!ask.option?.on && !ask.option.disabled)
    useAsk.setState({ open: false })
  }
  const opt = ask.option
  return (
    <Sheet
      open={open}
      onClose={() => done(false)}
      title={ask.title}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => done(false)}>Cancel</Button>
          <Button variant={ask.danger ? 'danger' : 'primary'} onClick={() => done(true)} autoFocus>
            {ask.yes}
          </Button>
        </div>
      }
    >
      {ask.details && (
        <dl className="mb-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-2xl border border-line bg-sunken px-4 py-3 text-[13px]">
          {ask.details.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-3">{k}</dt>
              <dd className="truncate font-medium text-fg" title={v}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {ask.body && <p className="text-[13.5px] leading-relaxed text-fg-2">{ask.body}</p>}
      {opt && (
        <div className="mt-4 flex items-start gap-3 border-t border-line pt-4">
          <div className="min-w-0 flex-1">
            <div className={clsx('text-[14px] font-medium', opt.disabled && 'text-fg-3')}>{opt.label}</div>
            {opt.note && <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-3" aria-live="polite">{opt.note}</p>}
          </div>
          <Toggle on={opt.on && !opt.disabled} disabled={opt.disabled} onChange={(on) => useAsk.setState({ ask: { ...ask, option: { ...opt, on } } })} label={opt.label} />
        </div>
      )}
    </Sheet>
  )
}
