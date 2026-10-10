import {
  forwardRef, useEffect, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Check, Loader2, X } from 'lucide-react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent'

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'xs' | 'sm' | 'md' | 'lg'; loading?: boolean }
>(function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] font-medium transition-[background,color,border,opacity] disabled:opacity-45',
        size === 'xs' && 'h-7 px-2.5 text-[12px]',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-9 px-3.5 text-[13.5px]',
        size === 'lg' && 'h-11 px-5 text-[15px]',
        variant === 'primary' && 'btn-accent',
        variant === 'accent' && 'btn-accent',
        variant === 'secondary' && 'border border-line-strong bg-transparent text-fg hover:bg-hover',
        variant === 'ghost' && 'text-fg-2 hover:bg-hover hover:text-fg',
        variant === 'danger' && 'border border-line-strong text-danger hover:bg-danger-soft',
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  )
})

export function IconButton({
  label,
  className,
  children,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40',
        active ? 'bg-hover text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-fg-2">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[12px] leading-relaxed text-fg-3">{hint}</span>}
    </label>
  )
}

export const inputClass =
  'h-10 w-full rounded-[10px] border border-line bg-elev px-3 text-[14px] text-fg placeholder:text-fg-3 transition-colors focus:border-line-strong focus:bg-elev'

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={clsx('relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors', on ? 'bg-ok' : 'bg-line-strong')}
    >
      <span className={clsx('absolute top-[3px] left-0 size-4 rounded-full bg-white shadow-sm transition-transform', on ? 'translate-x-[19px]' : 'translate-x-[3px]')} />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  full,
}: {
  value: T
  options: { v: T; label: ReactNode; title?: string }[]
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  full?: boolean
}) {
  return (
    <div role="radiogroup" className={clsx('flex gap-0.5 rounded-[10px] border border-line bg-sunken p-0.5', full ? 'w-full' : 'w-max')}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          title={o.title}
          onClick={() => onChange(o.v)}
          className={clsx(
            'flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] font-medium transition-colors',
            size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]',
            full && 'flex-1',
            value === o.v ? 'bg-elev text-fg shadow-soft' : 'text-fg-3 hover:text-fg-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Bottom sheet on phones, centered dialog on larger screens. */
export function Sheet({
  open,
  onClose,
  title,
  icon,
  children,
  footer,
  wide,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  icon?: ReactNode
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (open) setShown(true)
    else {
      const t = setTimeout(() => setShown(false), 170)
      return () => clearTimeout(t)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!shown) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal>
      <div className={clsx('absolute inset-0 bg-black/45 transition-opacity duration-150', open ? 'opacity-100' : 'opacity-0')} onClick={onClose} />
      <div
        className={clsx(
          'relative flex max-h-[92dvh] w-full flex-col rounded-t-[22px] border border-line bg-elev text-fg shadow-float transition-[transform,opacity] duration-150 sm:rounded-[18px]',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
          open ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0',
        )}
      >
        <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-line-strong sm:hidden" />
        <div className="flex items-center gap-2.5 px-5 pt-3 pb-1 sm:pt-4">
          {icon}
          <h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold tracking-tight">{title}</h2>
          <IconButton label="Close" onClick={onClose} className="-mr-2">
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 pt-2 pb-5">{children}</div>
        {footer && <div className="pb-safe-2 border-t border-line px-5 pt-3 sm:pb-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export interface MenuItem {
  key: string
  label: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  selected?: boolean
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

/** Anchored dropdown menu; keyboard navigable; closes on outside click. */
/** Opens the menu registered under `name`; false when none is on screen. */
export const openMenu = (name: string) => !window.dispatchEvent(new CustomEvent('tether:open-menu', { detail: name, cancelable: true }))

export function Menu({
  trigger,
  items,
  header,
  align = 'start',
  width = 260,
  name,
}: {
  trigger: (props: { open: boolean; toggle: () => void; ref: React.RefObject<HTMLButtonElement | null> }) => ReactNode
  items: MenuItem[]
  header?: ReactNode
  align?: 'start' | 'end'
  width?: number
  /** opened from elsewhere with openMenu(name), e.g. when "/models" is typed in the composer */
  name?: string
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!name) return
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== name) return
      e.preventDefault()
      // after the key that asked for it, or that same Enter would pick an item and close it again
      setTimeout(() => setOpen(true))
    }
    window.addEventListener('tether:open-menu', onOpen)
    return () => window.removeEventListener('tether:open-menu', onOpen)
  }, [name])
  const ref = useRef<HTMLButtonElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean }>({ top: 0, left: 0, up: false })
  const [active, setActive] = useState(0)

  useLayoutEffect(() => {
    if (!open || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    const up = r.bottom + 320 > window.innerHeight && r.top > 320
    const left = align === 'end' ? r.right - width : r.left
    setPos({ top: up ? r.top - 6 : r.bottom + 6, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)), up })
    setActive(Math.max(0, items.findIndex((i) => i.selected)))
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
      else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => Math.min(items.length - 1, a + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => Math.max(0, a - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const it = items[active]
        if (it && !it.disabled) {
          it.onSelect()
          setOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, active, items])

  return (
    <>
      {trigger({ open, toggle: () => setOpen((o) => !o), ref })}
      {open &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[70]" onClick={() => setOpen(false)} />
            <div
              role="menu"
              className="animate-pop fixed z-[71] max-h-[min(420px,70dvh)] overflow-y-auto rounded-[14px] border border-line bg-elev p-1 text-fg shadow-float"
              style={{ top: pos.up ? undefined : pos.top, bottom: pos.up ? window.innerHeight - pos.top : undefined, left: pos.left, width }}
            >
              {header && <div className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-medium text-fg-3">{header}</div>}
              {items.map((it, i) => (
                <button
                  key={it.key}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => {
                    it.onSelect()
                    setOpen(false)
                  }}
                  className={clsx(
                    'flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[13.5px] disabled:opacity-40',
                    i === active && 'bg-hover',
                    it.danger ? 'text-danger' : 'text-fg',
                  )}
                >
                  {it.icon && <span className="flex size-4 shrink-0 items-center justify-center text-fg-2">{it.icon}</span>}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{it.label}</span>
                    {it.hint && <span className="block truncate text-[12px] text-fg-3">{it.hint}</span>}
                  </span>
                  {it.selected && <Check className="size-4 shrink-0 text-fg-2" />}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('animate-spin text-fg-3', className ?? 'size-4')} />
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon && <div className="mb-4 flex size-11 items-center justify-center rounded-[12px] border border-line bg-sunken text-fg-3">{icon}</div>}
      <p className="text-[15px] font-semibold">{title}</p>
      {children && <div className="mt-1.5 max-w-sm text-[13.5px] leading-relaxed text-fg-2">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2 px-0.5">
      <h2 className="text-[11.5px] font-medium tracking-[0.06em] text-fg-3 uppercase">{children}</h2>
      {right && <div className="ml-auto">{right}</div>}
    </div>
  )
}

export function Meter({ value, tone = 'fg', className }: { value: number; tone?: 'fg' | 'accent' | 'auto'; className?: string }) {
  const v = Math.max(0, Math.min(100, value))
  const color = tone === 'accent' ? 'var(--accent)' : tone === 'auto' ? (v >= 85 ? 'var(--danger)' : v >= 60 ? 'var(--warn)' : 'var(--ok)') : 'var(--fg)'
  return (
    <div className={clsx('h-1.5 overflow-hidden rounded-full bg-line', className)}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${v}%`, background: color }} />
    </div>
  )
}
