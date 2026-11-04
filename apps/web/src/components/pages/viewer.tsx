import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, LayoutTemplate, Table2 } from 'lucide-react'
import { useStore } from '../../lib/store.ts'
import { PART_LABEL, changedAt, frameSrc, hubUnreachable, isBridged, markSeen, noteSrc, noteTitle, pageBase, usePages, type Page, type Part } from '../../lib/pages.ts'
import type { MenuItem } from '../ui/primitives.tsx'
import { usePageLink, useSiteParts } from './shared.tsx'

/**
 * A page on screen: its link (renewed before it runs out), the site's parts and notes, which of
 * them shows, and the frame's address. The Blueprints screen and a session's panel both use it.
 */
export function useViewer(page: Page | undefined) {
  const { link, error, retry } = usePageLink(page)
  const parts = useSiteParts(page, link)
  const [want, setPart] = useState<Part>('plan')
  // a note from the site's research folder shown instead of a part, while it's still listed
  const [wantNote, setNote] = useState<string>()
  useEffect(() => {
    setPart('plan')
    setNote(undefined)
  }, [page?.id])
  const part = parts.includes(want) ? want : 'plan'
  const note = wantNote && page?.notes?.includes(wantNote) ? wantNote : undefined
  const [n, setN] = useState(0)
  const theme = useStore((s) => s.resolvedTheme)
  const themeNow = useRef(theme)
  themeNow.current = theme
  // the theme isn't part of the address's identity: a theme change is a message, not a reload
  const src = useMemo(
    () => (page && link ? (note ? noteSrc(pageBase(page.host), link.url, note, themeNow.current) : frameSrc(pageBase(page.host), link.url, part, themeNow.current)) : undefined),
    [page?.host, link?.url, part, note],
  )
  // a new link every time: the one on screen may have been revoked from another device. The new
  // address reloads the frame; when no link comes (the hub is out of reach) the old one is tried again
  const reload = () => void retry().then((renewed) => renewed || setN((x) => x + 1))
  // picking a part always loads it, also the one the control shows when the page moved on by its own links
  const pickPart = (p: Part) => {
    setPart(p)
    setNote(undefined)
    setN((x) => x + 1)
  }
  const pickNote = (name: string) => {
    setNote(name)
    setN((x) => x + 1)
  }
  // looking at a page clears its changed mark, also when it changes while it's open
  const changed = page ? changedAt(page) : 0
  useEffect(() => {
    if (page) markSeen(page)
  }, [page?.id, changed])
  // the page's hub didn't answer the last poll: a frame already showing stays, marked out of date
  const stale = usePages((s) => !!page && hubUnreachable(page.host, s.unreachable))
  // a page on a computer paired with the phone: the app's viewer renders it from the link's files,
  // and there is no address to open outside the app
  const bridged = !!page && isBridged(page.host)
  const bridge = bridged && link ? link.url : undefined
  return { link, error, retry, parts, part, setPart: pickPart, note, setNote: pickNote, src, frameKey: `${src}#${n}`, reload, stale, bridged, bridge }
}

export type Viewer = ReturnType<typeof useViewer>

/** The site's research notes, and the way back to the page while one is open. */
export function notesMenu(page: Page, v: Viewer): MenuItem[] {
  return [
    ...(v.note ? [{ key: 'back', label: `Back to ${PART_LABEL[v.part]}`, icon: PART_ICON[v.part], onSelect: () => v.setPart(v.part) }] : []),
    ...(page.notes ?? []).map((name, i) => ({ key: `note:${name}`, label: noteTitle(name), icon: <FileText className="size-4" />, selected: v.note === name, separated: !!v.note && i === 0, disabled: !v.link, onSelect: () => v.setNote(name) })),
  ]
}

export const PART_ICON: Record<Part, React.ReactNode> = { plan: <FileText className="size-4" />, mockups: <LayoutTemplate className="size-4" />, matrix: <Table2 className="size-4" /> }

