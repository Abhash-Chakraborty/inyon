import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.ts'
import { registry } from '../hosts/registry.ts'
import { sendKeys, typeText } from '../tmux/tmux.ts'

export interface Draft {
  text: string
  source: 'app' | 'terminal'
  at: number
  /** what we last put into (or read from) the terminal's input box */
  mirrored?: string
}

const FILE = path.join(DATA_DIR, 'drafts.json')
const drafts = new Map<string, Draft>(Object.entries(readFile()))
let saveTimer: ReturnType<typeof setTimeout> | undefined

function readFile(): Record<string, Draft> {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    return {}
  }
}

function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(drafts)), { mode: 0o600 })
    } catch {}
  }, 500)
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

/** Clears Claude's input box: Ctrl+U clears a line, Backspace joins the line above. */
export async function clearInput(hostId: string, paneId: string, lines: number) {
  const host = registry.host(hostId)
  const keys: string[] = []
  for (let i = 0; i < Math.min(lines + 1, 60); i++) keys.push('C-u', 'BSpace')
  keys.push('C-u')
  await sendKeys(host, paneId, keys)
}

/** Puts `text` into Claude's input box without submitting it (replacing what's there). */
export async function mirrorToTerminal(hostId: string, paneId: string, text: string, current?: string) {
  if (squash(current ?? '') === squash(text)) return
  if (current) await clearInput(hostId, paneId, current.split('\n').length + 2)
  if (text) await typeText(registry.host(hostId), paneId, text)
}
