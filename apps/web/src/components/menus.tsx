import { useEffect, useState } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { ArrowRight, CircleX, Download, ExternalLink, FolderOpen, History, Pencil, Plus, Server, SquareTerminal, Trash2 } from 'lucide-react'
import { agentDef, isBusy, type HostState } from '@inyon/protocol'
import type { MenuItem } from './ui/primitives.tsx'
import { copyItem, type MenuItems } from './ui/ContextMenu.tsx'
import { RenameSheet } from './session/RenameSheet.tsx'
import { ConversationsSheet } from './session/ConversationsSheet.tsx'
import { MachineSheet, NewSessionSheet } from './Sheets.tsx'
import { confirmAction } from './Confirm.tsx'
import { paneHref, paneTitle, terminalName, type PaneRef } from '../lib/overview.ts'
import { endSession } from '../lib/end.ts'
import { appHref } from '../lib/base.ts'
import { isPhone } from '../lib/phone.ts'
import { api } from '../lib/api.ts'
import { toast } from '../lib/store.ts'

/**
 * What can be done to a session or a machine from wherever it's listed: the ⋯ menus and the
 * right-click menus share these, so each list offers the same actions in the same order.
 */

const clean = (items: MenuItems) => items.filter((i): i is MenuItem => !!i)

/** A new tab only where there are tabs: not in the phone app. */
const newTab = (route: string) => !isPhone() && { key: 'tab', label: 'Open in new tab', icon: <ExternalLink className="size-4" />, onSelect: () => void window.open(appHref(route), '_blank', 'noopener') }

export const paneName = (r: PaneRef) => (r.pane.agent ? paneTitle(r) : (terminalName(r) ?? r.pane.command))

/** A session (an agent, or a plain terminal) that isn't open on screen. */
export function paneMenu(r: PaneRef, nav: NavigateFunction): MenuItem[] {
  const a = r.pane.agent
  const host = r.host.config.id
  const href = paneHref(host, r.pane.id)
  return clean([
    { key: 'open', label: 'Open', icon: <ArrowRight className="size-4" />, onSelect: () => nav(href) },
    a && { key: 'terminal', label: 'Open terminal', icon: <SquareTerminal className="size-4" />, onSelect: () => nav(paneHref(host, r.pane.id, 'terminal')) },
    newTab(href),
    { key: 'rename', label: 'Rename…', icon: <Pencil className="size-4" />, separated: true, onSelect: () => openActionSheet({ kind: 'rename', r }) },
    { key: 'rename-session', label: 'Rename tmux session…', icon: <Pencil className="size-4" />, onSelect: () => openActionSheet({ kind: 'tmux-session', r }) },
    a && !!agentDef(a.kind)?.conversations?.length && { key: 'conversations', label: 'Past conversations…', icon: <History className="size-4" />, onSelect: () => openActionSheet({ kind: 'conversations', r }) },
    !!a?.sessionId && copyItem('copy', 'Copy session ID', a.sessionId!, 'Session ID'),
    { key: 'end', label: 'End session…', icon: <CircleX className="size-4" />, danger: true, separated: true, onSelect: () => void endSession(r) },
  ])
}

/** A tmux session heading: `r` is any pane in it. */
export function tmuxSessionMenu(r: PaneRef): MenuItem[] {
  return [
    { key: 'rename', label: 'Rename tmux session…', icon: <Pencil className="size-4" />, onSelect: () => openActionSheet({ kind: 'tmux-session', r }) },
    copyItem('copy', 'Copy tmux name', r.session.name, 'tmux name'),
  ]
}

/** A machine (or a phone's computer). */
export function machineMenu(h: HostState, nav: NavigateFunction): MenuItem[] {
  const href = `/machines/${encodeURIComponent(h.config.id)}`
  const paired = !(h.config.kind === 'node' && !h.config.pairedAt)
  return clean([
    { key: 'open', label: 'Open', icon: <Server className="size-4" />, onSelect: () => nav(href) },
    paired && h.status === 'online' && { key: 'new', label: 'New session', icon: <Plus className="size-4" />, onSelect: () => openActionSheet({ kind: 'new', hostId: h.config.id }) },
    newTab(href),
    paired && { key: 'temp', label: 'Temp files', icon: <FolderOpen className="size-4" />, onSelect: () => nav(`/temp/${encodeURIComponent(h.config.id)}`) },
    { key: 'rename', label: h.config.kind === 'ssh' ? 'Edit…' : 'Rename…', icon: <Pencil className="size-4" />, separated: true, onSelect: () => openActionSheet({ kind: 'edit', host: h }) },
    h.nodeUpdate?.supported && h.nodeUpdate.state !== 'updating' && h.nodeUpdate.state !== 'updated' && h.status === 'online' && { key: 'update', label: `Update to inyon ${h.nodeUpdate.latest}`, icon: <Download className="size-4" />, onSelect: () => void updateMachine(h) },
    h.config.kind !== 'local' && { key: 'remove', label: 'Remove…', icon: <Trash2 className="size-4" />, danger: true, separated: true, onSelect: () => void removeMachine(h) },
  ])
}

async function updateMachine(h: HostState) {
  try {
    await api.nodeUpdate(h.config.id)
  } catch (e) {
    toast({ title: 'Could not update', body: (e as Error).message, tone: 'error' })
  }
}

/** Asks, then removes a machine from this hub (or the phone). */
export async function removeMachine(h: HostState, after?: () => void) {
  if (!(await confirmAction({ title: `Remove ${h.config.name}?`, body: 'Its tmux sessions keep running. If it can be reached, Inyon first takes its hooks, uploads and prompt log off it.', yes: 'Remove', danger: true }))) return
  try {
    const r = await api.removeHost(h.config.id)
    // removed on the phone while it was out of reach: it still lets the phone in until it hears
    if (r?.untold) toast({ title: `${r.untold} still trusts this phone`, body: 'Inyon tells it to forget this phone once it is back online. To end it now, run inyon forget on that computer.', tone: 'info' })
    after?.()
  } catch (e) {
    toast({ title: 'Could not remove', body: (e as Error).message, tone: 'error' })
  }
}

// ---------- the sheets these menus open ----------

type Sheet = { kind: 'rename' | 'tmux-session' | 'conversations'; r: PaneRef } | { kind: 'new'; hostId: string } | { kind: 'edit'; host: HostState }

let request: ((s: Sheet) => void) | undefined
export const openActionSheet = (s: Sheet) => request?.(s)

/** The sheets a menu opens for something that isn't on screen. Mounted once, next to the pages. */
export function ActionSheets() {
  const [sheet, setSheet] = useState<Sheet>()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    request = (s) => {
      setSheet(s)
      setOpen(true)
    }
    return () => void (request = undefined)
  }, [])
  // the sheet stays mounted while it closes, so it can slide away
  const close = () => setOpen(false)
  if (!sheet) return null
  if (sheet.kind === 'rename')
    return <RenameSheet host={sheet.r.host.config.id} pane={sheet.r.pane.id} current={paneName(sheet.r)} agent={!!sheet.r.pane.agent} open={open} onClose={close} />
  if (sheet.kind === 'tmux-session')
    return <RenameSheet host={sheet.r.host.config.id} pane={sheet.r.session.id} session={sheet.r.session.id} current={sheet.r.session.name} agent={false} open={open} onClose={close} />
  if (sheet.kind === 'conversations' && sheet.r.pane.agent)
    return <ConversationsSheet host={sheet.r.host.config.id} pane={sheet.r.pane.id} agent={sheet.r.pane.agent.kind} working={isBusy(sheet.r.pane.agent)} open={open} onClose={close} />
  if (sheet.kind === 'new') return <NewSessionSheet open={open} hostId={sheet.hostId} onClose={close} />
  if (sheet.kind === 'edit') return <MachineSheet open={open} edit={sheet.host.config} onClose={close} />
  return null
}
