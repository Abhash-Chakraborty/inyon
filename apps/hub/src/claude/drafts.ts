import { kv } from '../platform/store.ts'
import { registry } from '../hosts/registry.ts'
import { sendKeys, typeText } from '../tmux/tmux.ts'

export interface Draft {
  text: string
  source: 'app' | 'terminal'
  at: number
  /** what we last put into (or read from) the terminal's input box */
  mirrored?: string
}

const drafts = new Map<string, Draft>(Object.entries(kv.get<Record<string, Draft>>('drafts') ?? {}))
let saveTimer: ReturnType<typeof setTimeout> | undefined

/** while the phone app is in the background it can be closed at any moment: no waiting then */
let atOnce = false

export function saveDraftsAtOnce(on: boolean) {
  atOnce = on
}

function save() {
  if (atOnce) return saveDrafts()
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveDrafts, 500)
}

/** Writes the drafts now instead of after the short wait (the app or hub is about to go). */
export function saveDrafts() {
  clearTimeout(saveTimer)
  saveTimer = undefined
  try {
    kv.set('drafts', Object.fromEntries(drafts))
  } catch {}
}

export const squash = (s: string) => s.replace(/\s+/g, '')

export function getDraft(key: string) {
  return drafts.get(key)
}

export function setDraft(key: string, d: Draft | undefined) {
  if (!d || !d.text) drafts.delete(key)
  else drafts.set(key, d)
  save()
}

/**
 * Rows a draft fills in the input box. The screen reader joins wrapped rows back into one line, but
 * Ctrl+U only clears the row the cursor is on, so a long dictated paragraph needs one per row.
 */
export function draftRows(draft: string, width?: number) {
  const row = Math.max(20, (width || 80) - 6)
  return draft.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / row)), 0) + 2
}

/** Clears Claude's input box: Ctrl+U clears a row, Backspace joins the row above. */
export async function clearInput(hostId: string, paneId: string, draft: string) {
  const host = registry.host(hostId)
  const rows = draftRows(draft, registry.findPane(hostId, paneId)?.pane.width)
  const keys: string[] = []
  for (let i = 0; i < Math.min(rows + 1, 240); i++) keys.push('C-u', 'BSpace')
  keys.push('C-u')
  await sendKeys(host, paneId, keys)
}

/** Puts `text` into Claude's input box without submitting it (replacing what's there). */
export async function mirrorToTerminal(hostId: string, paneId: string, text: string, current?: string) {
  if (squash(current ?? '') === squash(text)) return
  if (current) await clearInput(hostId, paneId, current)
  if (text) await typeText(registry.host(hostId), paneId, text)
}
