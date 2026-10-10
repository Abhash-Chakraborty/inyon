import type { ScreenState } from '@tether/protocol'

const squash = (text: string) => text.replace(/\s+/g, '')

/** A terminal paste preview is not the underlying editable text. */
export const hasPastePreview = (text: string) => /\[Pasted (?:text #\d+|Content \d+ chars\]|~\d+ lines?\])/i.test(text)

export function inputContains(draft: string | undefined, text: string): boolean {
  const value = squash(draft ?? '')
  const preview = /^\[Pasted Content (\d+) chars\]$/i.exec(draft?.trim() ?? '')
  if (preview) return Number(preview[1]) === [...text].length || Number(preview[1]) === text.length
  // OpenCode collapses a multi-line paste to its line count
  const lines = /^\[Pasted ~(\d+) lines?\]$/i.exec(draft?.trim() ?? '')
  if (lines) return Number(lines[1]) === text.replace(/\r\n?/g, '\n').split('\n').length
  // Codex loads image paths while typing and renders numbered attachment tokens instead.
  // Compare the entire body and ordered attachment list, not a substring or similar length.
  let image = 0
  const rendered = text.replace(/(Attached files:\s*)([\s\S]*)$/, (_, heading, files: string) =>
    heading + files.split('\n').map((path) => /^\/[^\n]+\.(png|jpe?g|gif|webp)$/i.test(path.trim()) ? `[Image #${++image}]` : path).join('\n'))
  return value === squash(text) || image > 0 && value === squash(rendered) || /\[Pastedtext#\d+/.test(value)
}

/** A missing composer is unknown, rather than evidence that input was submitted. */
export function codexAccepted(screen: ScreenState, text: string): boolean {
  return (!!screen.model || !!screen.inputVisible) && !screen.prompt && !screen.draft?.trim()
    || !!screen.queue?.some((queued) => inputContains(queued, text))
}

/** Words and their order only: agents rewrap pastes, drop markup and swap quotes. */
const looseText = (s: string) => s.replace(/<\/?pasted_content\b[^>]*>/g, '').toLowerCase().replace(/[^\p{L}\p{N}!/]+/gu, '')

/** Whether the agent's own record of a message is the one that was sent (long ones get cut short). */
export function sameMessage(recorded: string, sent: string): boolean {
  const a = looseText(recorded)
  const b = looseText(sent)
  return a === b || (a.length >= 2000 && b.startsWith(a))
}
