import { create } from 'zustand'
import { haptic } from '../lib/haptics.ts'
import { Button, Sheet } from './ui/primitives.tsx'

interface Ask {
  title: string
  body?: string
  yes: string
  danger?: boolean
  answer: (ok: boolean) => void
}

const useAsk = create<{ ask?: Ask; open: boolean }>(() => ({ open: false }))

/**
 * Asks before something that can't be undone, in the app's own sheet: the browser's confirm() is a
 * bare system dialog on Android. Resolves false when dismissed.
 */
export function confirmAction(o: { title: string; body?: string; yes: string; danger?: boolean }): Promise<boolean> {
  useAsk.getState().ask?.answer(false)
  if (o.danger) haptic('warning')
  return new Promise((resolve) => useAsk.setState({ open: true, ask: { ...o, answer: resolve } }))
}

export function ConfirmHost() {
  const { ask, open } = useAsk()
  if (!ask) return null
  const done = (ok: boolean) => {
    ask.answer(ok)
    useAsk.setState({ open: false })
  }
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
      {ask.body && <p className="text-[13.5px] leading-relaxed text-fg-2">{ask.body}</p>}
    </Sheet>
  )
}
