import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { AlertCircle, CheckCircle2, Info, MessageCircleQuestion, X } from 'lucide-react'
import { useStore } from '../lib/store.ts'
import { AgentLogo } from '../lib/skin.tsx'

const icons = { info: Info, success: CheckCircle2, warn: MessageCircleQuestion, error: AlertCircle }
const tones = { info: 'text-fg-2', success: 'text-ok', warn: 'text-warn', error: 'text-danger' }

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismiss)
  const nav = useNavigate()
  return (
    <div className="pt-safe pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-3 pt-3 sm:items-end sm:px-5">
      {toasts.map((t) => {
        const Icon = icons[t.tone]
        return (
          <div
            key={t.id}
            role="status"
            onClick={() => {
              if (t.href) nav(t.href)
              dismiss(t.id)
            }}
            className={clsx(
              'animate-slide-up pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-[14px] border border-line bg-elev px-3.5 py-3 shadow-float',
              t.href && 'cursor-pointer',
            )}
          >
            {t.agent ? <AgentLogo kind={t.agent as any} size={22} /> : <Icon className={clsx('mt-0.5 size-[18px] shrink-0', tones[t.tone])} />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{t.title}</p>
              {t.body && <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-fg-2">{t.body}</p>}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={(e) => {
                e.stopPropagation()
                dismiss(t.id)
              }}
              className="-mr-1 rounded-md p-0.5 text-fg-3 hover:text-fg"
            >
              <X className="size-4" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
