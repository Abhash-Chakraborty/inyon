import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'

/**
 * The cold-start intro: a computer drops in, a light trails behind it and draws the line, and the
 * kite is where it lands. Under 1.2 s, cold start only, a tap skips it. It ends by flying the
 * mark onto the mark in the header (measured, so it lands exactly) and fading the page in behind.
 * Where no header mark is on screen it shrinks and fades in place. Under reduced motion nothing
 * moves: the finished mark shows for a moment and fades.
 */
const SEEN = 'inyon.intro.seen'
/** when the drawing is done and the hand-off starts */
const HANDOFF_AT = 1000
const HANDOFF_MS = 320
const FADE_MS = 200

const SQUIRCLE = 'M25 0H39C60 0 64 4 64 25V39C64 60 60 64 39 64H25C4 64 0 60 0 39V25C0 4 4 0 25 0Z'
const KITE = 'M33.5 9H48.5A3.5 3.5 0 0 1 52 12.5V33.5A3.5 3.5 0 0 1 48.5 37H33.5A3.5 3.5 0 0 1 30 33.5V12.5A3.5 3.5 0 0 1 33.5 9ZM41 18.4A4.6 4.6 0 1 0 41 27.6A4.6 4.6 0 1 0 41 18.4Z'
const LINE = 'M38.5 36.5C35 48 25 42 17.5 49.5'

/** Whether this page load should show the intro: the first in this app session. */
export function introDue() {
  try {
    if (sessionStorage.getItem(SEEN)) return false
    sessionStorage.setItem(SEEN, '1')
    return true
  } catch {
    return false
  }
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The header's mark, if one is on screen, to land on. */
function target(): DOMRect | undefined {
  for (const el of document.querySelectorAll<HTMLElement>('[data-intro-target]')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return r
  }
  return undefined
}

export function Intro({ onDone }: { onDone?: () => void }) {
  const [phase, setPhase] = useState<'draw' | 'handoff' | 'gone'>('draw')
  const mark = useRef<HTMLDivElement>(null)
  const [flight, setFlight] = useState<React.CSSProperties>()
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const handoff = () => {
    setPhase((p) => {
      if (p !== 'draw') return p
      const from = mark.current?.getBoundingClientRect()
      const to = target()
      if (from && to) {
        // the same drawing in both, so one translate and one scale put it exactly there
        const scale = to.width / from.width
        const dx = to.left + to.width / 2 - (from.left + from.width / 2)
        const dy = to.top + to.height / 2 - (from.top + from.height / 2)
        setFlight({ transform: `translate(${dx}px, ${dy}px) scale(${scale})` })
      } else setFlight({ transform: 'scale(0.6)', opacity: 0 })
      return 'handoff'
    })
  }
  const finish = () => {
    setPhase('gone')
    document.documentElement.classList.remove('intro-running')
    onDone?.()
  }

  useEffect(() => {
    document.documentElement.classList.add('intro-running')
    const quick = reduced()
    const t = timers.current
    t.push(setTimeout(handoff, quick ? 400 : HANDOFF_AT))
    // the overlay goes when the mark has arrived, however slow the device; a timer backs that up
    t.push(setTimeout(finish, (quick ? 400 : HANDOFF_AT) + HANDOFF_MS + 400))
    return () => {
      t.forEach(clearTimeout)
      document.documentElement.classList.remove('intro-running')
    }
  }, [])
  const landed = (e: React.TransitionEvent) => {
    if (phase === 'handoff' && e.target === mark.current && (e.propertyName === 'transform' || e.propertyName === 'opacity')) finish()
  }

  if (phase === 'gone') return null
  const skip = () => {
    timers.current.forEach(clearTimeout)
    if (phase === 'draw') {
      handoff()
      timers.current.push(setTimeout(finish, HANDOFF_MS + 400))
    }
  }
  return (
    <div
      className={clsx('intro fixed inset-0 z-[90] grid place-items-center bg-bg', phase === 'handoff' && 'intro-off', reduced() && 'intro-still')}
      onPointerDown={skip}
      onKeyDown={skip}
      role="presentation"
      aria-hidden
      data-testid="intro"
    >
      <div ref={mark} className="intro-mark" style={phase === 'handoff' ? flight : undefined} onTransitionEnd={landed}>
        <svg viewBox="0 0 64 64" className="size-full overflow-visible">
          <path className="intro-tile" d={SQUIRCLE} fill="var(--logo-tile)" />
          <g className="intro-glyph">
            <path className="intro-kite" fillRule="evenodd" d={KITE} />
            <path className="intro-line" d={LINE} fill="none" strokeWidth="3.8" strokeLinecap="round" />
            <circle className="intro-node" cx="15.5" cy="51" r="4" />
            <circle className="intro-light" r="2.6" />
          </g>
        </svg>
      </div>
    </div>
  )
}
