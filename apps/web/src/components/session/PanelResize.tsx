import { useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../../lib/store.ts'

/** The narrowest the side panel goes, and the least it leaves the chat beside it. */
export const PANEL_MIN = 340
export const CHAT_MIN = 420
/** One press of an arrow key on the handle. */
const STEP = 24

/** A width kept between the panel's least and what the row can give up (`row`: the chat and the panel together). */
export const clampPanel = (w: number, row: number) => Math.round(Math.max(PANEL_MIN, Math.min(w, Math.max(PANEL_MIN, row - CHAT_MIN))))

/**
 * The side panel's box: the width it comes with (420px, 480px on a very wide screen) until it has
 * been dragged, then the width it was left at. The row's own width caps it in CSS, so a window made
 * narrower never squeezes the chat out.
 */
export function panelBox(width: number): { className: string; style?: CSSProperties } {
  return width > 0 ? { className: '', style: { width, minWidth: PANEL_MIN, maxWidth: `calc(100% - ${CHAT_MIN}px)` } } : { className: 'w-[420px] 2xl:w-[480px]' }
}

/**
 * The side panel's width while it is dragged and after: `width` is 0 until it has been resized.
 * `Handle` goes inside the panel (which must be `relative`), on its left edge.
 */
export function usePanelResize(panel: RefObject<HTMLElement | null>) {
  const stored = useStore((s) => s.settings.panelWidth)
  const setSettings = useStore((s) => s.setSettings)
  const [live, setLive] = useState<number>()
  const drag = useRef<{ right: number; row: number } | null>(null)
  const row = () => panel.current?.parentElement?.clientWidth ?? window.innerWidth
  const now = () => Math.round(panel.current?.offsetWidth ?? (stored || 420))
  const move = (x: number) => {
    const d = drag.current
    if (d) setLive(clampPanel(d.right - x, d.row))
  }
  const end = (keep: boolean) => {
    if (!drag.current) return
    drag.current = null
    document.body.style.userSelect = ''
    setLive((w) => {
      if (keep && w !== undefined) setSettings({ panelWidth: w })
      return undefined
    })
  }
  const Handle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side panel"
      aria-valuemin={PANEL_MIN}
      aria-valuemax={clampPanel(Infinity, row())}
      aria-valuenow={live ?? now()}
      tabIndex={0}
      title="Drag to resize. Double-click for the usual width."
      data-dragging={live !== undefined || undefined}
      className="group/resize absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none"
      onPointerDown={(e) => {
        if (e.button !== 0 || !panel.current) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { right: panel.current.getBoundingClientRect().right, row: row() }
        document.body.style.userSelect = 'none'
        setLive(now())
      }}
      onPointerMove={(e) => move(e.clientX)}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onDoubleClick={() => setSettings({ panelWidth: 0 })}
      onKeyDown={(e) => {
        // the handle is the panel's left edge: left makes it wider
        const by = e.key === 'ArrowLeft' ? STEP : e.key === 'ArrowRight' ? -STEP : 0
        if (by) {
          e.preventDefault()
          setSettings({ panelWidth: clampPanel(now() + by, row()) })
        } else if (e.key === 'Home' || e.key === 'Enter') {
          e.preventDefault()
          setSettings({ panelWidth: 0 })
        }
      }}
    >
      {/* a hairline that shows where to grab: on hover, with the keyboard, and while dragging */}
      <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-line-strong opacity-0 transition-opacity duration-(--dur-small) group-hover/resize:opacity-100 group-focus-visible/resize:bg-fg group-focus-visible/resize:opacity-100 group-data-dragging/resize:bg-fg group-data-dragging/resize:opacity-100" />
      {/* over everything while dragging, so a page in a frame can't take the pointer */}
      {live !== undefined && createPortal(<div className="fixed inset-0 z-[90] cursor-col-resize" />, document.body)}
    </div>
  )
  return { width: live ?? stored, Handle }
}
