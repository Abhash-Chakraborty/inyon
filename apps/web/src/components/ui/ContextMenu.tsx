import { useEffect, useState, type ReactNode } from 'react'
import { Copy } from 'lucide-react'
import { MenuPopup, type MenuItem } from './primitives.tsx'
import { useBackCloses } from '../../lib/back.ts'
import { copyText } from '../../lib/clipboard.ts'
import { toast } from '../../lib/store.ts'

/**
 * Right-click menus. Anything can offer one with `useContextMenu`; it opens where the pointer is,
 * with the same look and keys as the ⋯ menus. The browser's own menu stays where it's the better
 * one: in text boxes, on links to other sites, and with Shift held.
 */

export type MenuItems = (MenuItem | false | null | undefined | '' | 0)[]
type Open = { x: number; y: number; items: MenuItem[]; header?: ReactNode }

let show: ((m: Open | undefined) => void) | undefined
/** how the last press was made: a long press on a touch screen also sends contextmenu */
let pointer = 'mouse'

export function openContextMenu(at: { x: number; y: number }, items: MenuItems, header?: ReactNode) {
  const list = items.filter((i): i is MenuItem => !!i)
  if (!list.length || !show) return false
  show({ x: at.x, y: at.y, items: list, header })
  return true
}

/** An item that copies `text`, saying so (`what` names it: "Session ID copied"). */
export const copyItem = (key: string, label: string, text: string, what: string, icon: ReactNode = <Copy className="size-4" />): MenuItem => ({
  key,
  label,
  icon,
  onSelect: async () => {
    if (await copyText(text)) toast({ title: `${what} copied`, tone: 'info' })
    else toast({ title: 'Could not copy', tone: 'error' })
  },
})

/** The one place right-click menus show. Mounted once, next to the app's pages. */
export function ContextMenuHost() {
  const [open, setOpen] = useState<Open>()
  useBackCloses(!!open, () => setOpen(undefined))
  useEffect(() => {
    show = setOpen
    const down = (e: PointerEvent) => void (pointer = e.pointerType)
    document.addEventListener('pointerdown', down, true)
    return () => {
      show = undefined
      document.removeEventListener('pointerdown', down, true)
    }
  }, [])
  if (!open) return null
  return (
    <MenuPopup
      key={`${open.x},${open.y}`}
      anchor={() => new DOMRect(open.x, open.y, 0, 0)}
      items={open.items}
      header={open.header}
      width={240}
      gap={2}
      onClose={() => setOpen(undefined)}
      onOutsideContextMenu={(e) => {
        // right-clicking something else while a menu is open opens that thing's menu instead
        const { clientX: x, clientY: y } = e
        setOpen(undefined)
        requestAnimationFrame(() => document.elementFromPoint(x, y)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })))
      }}
    />
  )
}

/** Where the browser's own menu is the useful one. */
function nativeMenuFor(t: EventTarget | null) {
  if (!(t instanceof Element)) return false
  return !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], a[href^="http"], [data-native-menu]')
}

/** The selected text, when it lies inside `el`. */
function selectionIn(el: Element) {
  const sel = window.getSelection()
  const text = sel?.toString() ?? ''
  if (!text.trim() || !sel?.rangeCount) return ''
  const r = sel.getRangeAt(0)
  return el.contains(r.commonAncestorContainer) ? text : ''
}

/**
 * Props that give an element a right-click menu; a plain function, so fine inside a list. `items`
 * is built when it opens, from the event (a click inside a code block can offer to copy it).
 * Selected text inside the element puts Copy first. A long press on a touch screen keeps doing
 * what it did unless `touch` is set.
 */
export function contextMenu(items: (e: React.MouseEvent) => MenuItems, opts: { header?: ReactNode; touch?: boolean; ownsTextBox?: boolean } = {}) {
  return {
    onContextMenu: (e: React.MouseEvent) => {
      // ownsTextBox: the terminal moves its hidden text box under the pointer on a right-click
      if (e.defaultPrevented || e.shiftKey || (!opts.ownsTextBox && nativeMenuFor(e.target))) return
      if (pointer === 'touch' && !opts.touch) return
      const picked = selectionIn(e.currentTarget)
      const list = items(e).filter((i): i is MenuItem => !!i)
      const all: MenuItems = picked
        ? [{ key: 'copy-selection', label: 'Copy', icon: <Copy className="size-4" />, onSelect: () => void copyText(picked) }, ...list.map((it, i) => (i === 0 ? { ...it, separated: true } : it))]
        : list
      if (!openContextMenu({ x: e.clientX, y: e.clientY }, all, opts.header)) return
      e.preventDefault()
      e.stopPropagation()
    },
  }
}
