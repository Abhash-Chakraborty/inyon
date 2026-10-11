import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { AlertCircle, CheckCircle2, Info, MessageCircleQuestion, X } from 'lucide-react'
import { useStore, type Toast } from '../lib/store.ts'
import { AgentLogo } from '../lib/skin.tsx'

const icons = { info: Info, success: CheckCircle2, warn: MessageCircleQuestion, error: AlertCircle }
const tones = { info: 'text-fg-2', success: 'text-ok', warn: 'text-warn', error: 'text-danger' }
/** how far a toast has to be flicked sideways or up before it goes */
const FLING = 70

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="pt-safe pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-3 pt-3 sm:items-end sm:px-5">
      {toasts.map((t) => (
        <ToastCard key={t.id} t={t} />
      ))}
    </div>
  )
}

function ToastCard({ t }: { t: Toast }) {
  const dismiss = useStore((s) => s.dismiss)
  const nav = useNavigate()
  const Icon = icons[t.tone]
  // swipe it away: follows the finger, then flies off or springs back
  const start = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)
  const [drag, setDrag] = useState({ x: 0, y: 0 })
  const [leaving, setLeaving] = useState<{ x: number; y: number } | null>(null)
  const go = (x: number, y: number) => {
    setLeaving({ x, y })
    setTimeout(() => dismiss(t.id), 160)
  }
  const offset = leaving ?? drag
  return (
    <div
      role="status"
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch') return
        start.current = { x: e.clientX, y: e.clientY }
        moved.current = false
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        const x = e.clientX - start.current.x
        const y = Math.min(0, e.clientY - start.current.y)
        if (Math.abs(x) > 6 || y < -6) moved.current = true
        setDrag({ x, y })
      }}
      onPointerUp={() => {
        if (!start.current) return
        start.current = null
        if (Math.abs(drag.x) > FLING) go(Math.sign(drag.x) * 420, 0)
        else if (drag.y < -FLING / 2) go(0, -160)
        else setDrag({ x: 0, y: 0 })
      }}
      onPointerCancel={() => ((start.current = null), setDrag({ x: 0, y: 0 }))}
      onClick={() => {
        if (moved.current) return
        if (t.href) nav(t.href)
        dismiss(t.id)
      }}
      style={{
        transform: offset.x || offset.y ? `translate(${offset.x}px, ${offset.y}px)` : undefined,
        opacity: leaving ? 0 : 1 - Math.min(0.6, Math.abs(offset.x) / 300),
        transition: start.current ? 'none' : leaving ? 'transform 0.16s ease-in, opacity 0.16s ease-in' : 'transform 0.4s var(--ease-spring), opacity 0.3s',
        touchAction: 'pan-y',
      }}
      className={clsx(
        'animate-toast-in pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-[14px] border border-line bg-elev px-3.5 py-3 shadow-float select-none',
        t.href && 'cursor-pointer',
      )}
    >
      {t.agent ? <AgentLogo kind={t.agent as any} size={22} /> : <Icon className={clsx('mt-0.5 size-[18px] shrink-0', tones[t.tone], t.tone !== 'info' && 'animate-pop-in')} />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{t.title}</p>
        {t.body && <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-fg-2">{t.body}</p>}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={(e) => {
          e.stopPropagation()
          go(0, -40)
        }}
        className="press -mr-1 rounded-md p-0.5 text-fg-3 hover:text-fg"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
