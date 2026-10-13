import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'

export interface Keyed {
  key: string
  node: ReactNode
}

/** how long a leaving item stays, fading, before it is taken out */
export const LEAVE_MS = 120

/**
 * A grid whose items arrive, leave and move without jumping. A new item fades in and rises a
 * little; one that goes fades out first, then the others slide to their new places (measured
 * before and after, moved with a transform only). Nothing here changes layout on its own.
 */
export function AnimatedList({ items, className }: { items: Keyed[]; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  /** keys shown last time, to tell a new item from one that was already there */
  const seen = useRef<Set<string>>(new Set())
  /** where each item was last time, by key */
  const rects = useRef<Map<string, DOMRect>>(new Map())
  /** the list's own width last time: when it changes (the window settling at launch, a tablet turning) items reflow, they didn't move */
  const width = useRef<number | undefined>(undefined)
  /** the content each item had last time, so a leaving one fades out looking as it did */
  const last = useRef<Map<string, ReactNode>>(new Map())
  const [leaving, setLeaving] = useState<Keyed[]>([])

  const current = new Set(items.map((i) => i.key))
  const gone = [...seen.current].filter((k) => !current.has(k))
  for (const i of items) last.current.set(i.key, i.node)

  // an item that disappeared stays for a moment, marked, then goes for good. Its timer lives on
  // its own: the next render changes what counts as gone, and must not cancel it
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  useLayoutEffect(() => {
    if (!gone.length) return
    const add = gone.filter((k) => last.current.has(k)).map((k) => ({ key: k, node: last.current.get(k)! }))
    for (const k of gone) last.current.delete(k)
    setLeaving((l) => [...l.filter((x) => !gone.includes(x.key)), ...add])
    for (const k of gone) {
      clearTimeout(timers.current.get(k))
      timers.current.set(k, setTimeout(() => {
        timers.current.delete(k)
        setLeaving((l) => l.filter((x) => x.key !== k))
      }, LEAVE_MS))
    }
  }, [gone.join('\u0000')])
  useLayoutEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), [])

  // items that moved: start where they were, then let the transition carry them
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const w = el.getBoundingClientRect().width
    const resized = width.current !== undefined && Math.abs(w - width.current) > 0.5
    width.current = w
    const next = new Map<string, DOMRect>()
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const key = child.dataset.key!
      const r = child.getBoundingClientRect()
      next.set(key, r)
      const was = rects.current.get(key)
      if (!was || resized || child.dataset.leaving) continue
      const dx = was.left - r.left
      const dy = was.top - r.top
      if (!dx && !dy) continue
      child.style.transition = 'none'
      child.style.transform = `translate(${dx}px, ${dy}px)`
      requestAnimationFrame(() => {
        child.style.transition = ''
        child.style.transform = ''
      })
    }
    rects.current = next
    seen.current = current
  })

  const shown = [
    ...items.map((i) => ({ ...i, entering: !seen.current.has(i.key), leaving: false })),
    ...leaving.filter((l) => !current.has(l.key)).map((l) => ({ ...l, entering: false, leaving: true })),
  ]
  return (
    <div ref={box} className={className}>
      {shown.map((i) => (
        <div key={i.key} data-key={i.key} data-leaving={i.leaving || undefined} className={clsx('flip', i.entering && 'animate-slide-up', i.leaving && 'leave')}>
          {i.node}
        </div>
      ))}
    </div>
  )
}
