import type { ChatItem } from '@tether/protocol'

export interface PendingMessage {
  id: string
  text: string
  status: 'sending' | 'sent' | 'failed'
  at: number
  error?: string
}

export const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const clean = (s: string) => {
  // Codex expands attachment paths into image envelopes and substitutes numbered labels.
  // Restore their paths before comparing; the full text and each attachment must still match.
  const images = new Map<string, string>()
  s = s.replace(/<image\s+name=(\[Image #\d+\])\s+path="([^"]+)">[\s\S]*?<\/image>/g, (_, name, path) => {
    images.set(name, path)
    return ''
  })
  s = s.replace(/(Attached files:\s*)([\s\S]*)$/, (_, heading, files) => heading + files.replace(/\[Image #\d+\]/g, (name: string) => images.get(name) ?? name))
  return norm(s.replace(/<\/?pasted_content\b[^>]*>/g, '')).replace(/^!\s*/, '!')
}
export const msgKey = (s: string) => clean(s).slice(0, 400)
export const PENDING_MS = 10 * 60_000

/** Only a new transcript entry can confirm a send; consume each receipt at most once. */
export function reconcile(pending: PendingMessage[], items: ChatItem[]) {
  const receipts = items.flatMap((item) => item.kind === 'user'
    ? [{ text: clean(item.shell ? `!${item.text}` : item.text), at: Date.parse(item.ts) }]
    : item.kind === 'command' && item.name ? [{ text: clean(`/${item.name.replace(/^\/+/, '')} ${item.args}`), at: Date.parse(item.ts) }] : [])
  return pending.filter((message) => {
    const text = clean(message.text)
    const receipt = receipts.findIndex((entry) => entry.at >= message.at - 5000 && (entry.text === text || entry.text.length >= 24_000 && text.startsWith(entry.text)))
    if (receipt < 0) return true
    receipts.splice(receipt, 1)
    return false
  })
}
