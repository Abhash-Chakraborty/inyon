import type { ChatItem, ScreenState, SendState } from '@inyon/protocol'

const squash = (text: string) => text.replace(/\s+/g, '')
const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

/** A terminal paste preview is not the underlying editable text. */
export const hasPastePreview = (text: string) => /\[Pasted (?:text #\d+|Content \d+ chars\]|~\d+ lines?\])/i.test(text)

/**
 * Whether the input box holds `text`. `known` says the box was just given this text (typed into
 * an emptied box, or what the draft mirror last put there). Only then do previews count: Claude
 * collapses a long paste to "[Pasted text #1]", Codex to a character count and OpenCode to a line
 * count, and an older draft can show the same preview. And only then is whitespace ignored, which
 * the terminal's wrapping changes: otherwise a draft differing only in spaces or line breaks
 * (inside a string, say) would be taken for the message, and Enter would send the old one.
 */
export function inputContains(draft: string | undefined, text: string, known = false): boolean {
  const preview = /^\[Pasted Content (\d+) chars\]$/i.exec(draft?.trim() ?? '')
  if (preview) return known && (Number(preview[1]) === [...text].length || Number(preview[1]) === text.length)
  // OpenCode collapses a multi-line paste to its line count
  const lines = /^\[Pasted ~(\d+) lines?\]$/i.exec(draft?.trim() ?? '')
  if (lines) return known && Number(lines[1]) === text.replace(/\r\n?/g, '\n').split('\n').length
  // Codex loads image paths while typing and renders numbered attachment tokens instead.
  // Compare the entire body and ordered attachment list, not a substring or similar length.
  let image = 0
  const rendered = text.replace(/(Attached files:\s*)([\s\S]*)$/, (_, heading, files: string) =>
    heading + files.split('\n').map((path) => /^\/[^\n]+\.(png|jpe?g|gif|webp)$/i.test(path.trim()) ? `[Image #${++image}]` : path).join('\n'))
  const same = known ? squash : collapse
  const value = same(draft ?? '')
  return value === same(text) || image > 0 && value === same(rendered) || known && /^(\[Pastedtext#\d+(\+\d+lines?)?\])+$/.test(value)
}

/** A missing composer is unknown, rather than evidence that input was submitted. */
export function codexAccepted(screen: ScreenState, text: string): boolean {
  return (!!screen.model || !!screen.inputVisible) && !screen.prompt && !screen.draft?.trim()
    || !!screen.queue?.some((queued) => inputContains(queued, text, true))
}

/** Words and their order only: agents rewrap pastes, drop markup and swap quotes. */
const looseText = (s: string) => codexImages(s).replace(/<\/?pasted_content\b[^>]*>/g, '').toLowerCase().replace(/[^\p{L}\p{N}!/]+/gu, '')

/** Codex records attached images as envelopes and numbered labels; put the paths back. */
function codexImages(s: string) {
  const images = new Map<string, string>()
  s = s.replace(/<image\s+name=(\[Image #\d+\])\s+path="([^"]+)">[\s\S]*?<\/image>/g, (_, name: string, path: string) => {
    images.set(name, path)
    return ''
  })
  return images.size ? s.replace(/(Attached files:\s*)([\s\S]*)$/, (_, heading: string, files: string) => heading + files.replace(/\[Image #\d+\]/g, (name) => images.get(name) ?? name)) : s
}

/** Whether the agent's own record of a message is the one that was sent (long ones get cut short). */
export function sameMessage(recorded: string, sent: string): boolean {
  const a = looseText(recorded)
  const b = looseText(sent)
  // a message with no words ("?", "...") would match anything else without words, including the
  // stand-in for items that aren't messages: then the text itself has to agree
  if (!a || !b) return squash(recorded) !== '' && squash(recorded) === squash(sent)
  return a === b || (a.length >= 2000 && b.startsWith(a))
}

/** What the agent recorded for a conversation item, in the form it was typed. */
const typedAs = (i: ChatItem) => (i.kind === 'user' ? (i.shell ? `!${i.text}` : i.text) : i.kind === 'command' && i.name ? `/${i.name.replace(/^\/+/, '')} ${i.args}` : undefined)

const KEEP_MS = 10 * 60_000
const SCAN = 400

/**
 * The hub's record of what it sent to one pane. Each send is matched to the first conversation item
 * that wasn't there when it started and says the same thing, so clocks and look-alike older
 * messages don't matter, and two identical messages claim two items.
 */
export class SendLedger {
  private sends: (SendState & { known: Set<string> })[] = []

  track(id: string, text: string, items: ChatItem[], setting = false) {
    this.sends = this.sends.filter((s) => s.id !== id)
    const known = new Set(items.slice(-SCAN).filter((i) => typedAs(i) !== undefined).map((i) => i.uuid))
    this.sends.push({ id, text, at: Date.now(), state: 'sending', known, ...(setting && { setting }) })
  }

  settle(id: string, patch: Partial<Pick<SendState, 'state' | 'error'>>) {
    const s = this.sends.find((x) => x.id === id)
    // a late record already proved delivery; a timeout can't take that back
    if (!s || (s.state === 'delivered' && patch.state !== 'delivered')) return
    Object.assign(s, patch)
    if (patch.state !== 'failed') s.error = undefined
  }

  get(id: string): SendState | undefined {
    const s = this.sends.find((x) => x.id === id)
    return s && this.public(s)
  }

  /** Matches open sends against the conversation and the agent's queue; true if anything moved. */
  match(items: ChatItem[], queue: readonly string[]): boolean {
    let changed = false
    const claimed = new Set(this.sends.flatMap((s) => (s.uuid ? [s.uuid] : [])))
    const recent = items.slice(-SCAN)
    for (const s of this.sends) {
      if (s.state === 'delivered') continue
      const hit = recent.find((i) => !s.known.has(i.uuid) && !claimed.has(i.uuid) && sameMessage(typedAs(i) ?? '\0', s.text))
      if (hit) {
        Object.assign(s, { state: 'delivered', uuid: hit.uuid, error: undefined })
        claimed.add(hit.uuid)
        changed = true
      } else if ((s.state === 'sending' || s.state === 'sent') && queue.some((q) => sameMessage(q, s.text))) {
        s.state = 'queued'
        changed = true
      }
    }
    const old = Date.now() - KEEP_MS
    const before = this.sends.length
    this.sends = this.sends.filter((s) => s.at >= old || s.state === 'sending').slice(-20)
    return changed || this.sends.length !== before
  }

  list(): SendState[] {
    return this.sends.map((s) => this.public(s))
  }

  private public({ known: _, ...s }: SendState & { known: Set<string> }): SendState {
    return s
  }
}
