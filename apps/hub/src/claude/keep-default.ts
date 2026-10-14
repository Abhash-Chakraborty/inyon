import { sleep } from '../platform/store.ts'
import { shq, type Host } from '../hosts/host.ts'

/**
 * Claude Code's /model and /effort change the running session and also save the pick in the
 * user's settings.json as the default for new sessions ("Set model to Sonnet 5.5 and saved as your
 * default for new sessions"). A switch from Inyon is for one session, so the hub notes these keys
 * before the switch and, once Claude Code has written them, puts the earlier values back. The
 * session keeps what it switched to: Claude Code reads the file again but leaves the running
 * session's model and effort alone.
 *
 * Only those keys change. Everything else in the file stays byte for byte (formatting, other keys,
 * non-ASCII text, CRLF line ends), and the file is only replaced if it still holds what was read.
 */

/** Effort lands in "effortLevel" (older Claude Code) or under "modelSettings" per model (2.1.29x). */
export const DEFAULT_KEYS = ['model', 'effortLevel', 'modelSettings']

// the file, and a checksum of it to notice changes (busybox builds can lack cksum; od is everywhere)
const FILE = `f="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
sum() { cksum < "$1" 2>/dev/null || md5sum < "$1" 2>/dev/null || od -An -v -tx1 < "$1" | tr -d ' \\n'; }`

/** How long after a switch the file is watched: the /model menu and "Switch model?" can wait for an answer. */
const WINDOW_MS = 180_000
/** After putting a value back, how long to look for a second write (a menu saves model and effort apart). */
const GRACE_MS = 6_000

// ---- the file, read and written as bytes ----

interface Settings {
  /** checksum of the file as read, or '' when it doesn't exist */
  sum: string
  text: string
}

const decoder = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * The file's checksum and, unless it still matches `known`, its bytes as hex (od, so Windows'
 * CRLF and any byte survive the trip). `undefined` when it can't be read or isn't UTF-8.
 */
async function readSettings(host: Host, known?: string): Promise<Settings | 'same' | undefined> {
  const r = await host.exec(`${FILE}
[ -f "$f" ] || { echo none; exit 0; }
s=$(sum "$f") || exit 1
echo "$s"
[ "$s" = ${shq(known ?? '')} ] && exit 0
od -An -v -tx1 < "$f"`, { timeoutMs: 15000 })
  if (r.code !== 0) return undefined
  const [first = '', ...rest] = r.stdout.split('\n')
  if (first.trim() === 'none') return { sum: '', text: '' }
  const sum = first.trim()
  if (!sum) return undefined
  if (known !== undefined && sum === known) return 'same'
  const hex = rest.join('').replace(/\s+/g, '')
  if (hex.length % 2) return undefined
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  try {
    return { sum, text: decoder().decode(bytes) }
  } catch {
    return undefined
  }
}

/**
 * Replaces the file with `text` if it still has checksum `sum`. A symlinked settings.json (a
 * dotfiles repo) is written through the link; otherwise a copy keeps the file's mode and is moved
 * over it, so Claude Code never reads half a file.
 */
async function writeSettings(host: Host, sum: string, text: string) {
  const r = await host.exec(`${FILE}
t="$f.inyon-tmp"
[ -f "$f" ] && [ "$(sum "$f")" = ${shq(sum)} ] || exit 3
trap 'rm -f "$t"' EXIT HUP INT TERM
if [ -L "$f" ]; then umask 077; cat > "$t" && cat "$t" > "$f"
else cp -p "$f" "$t" && cat > "$t" && mv -f "$t" "$f"; fi`, { input: new TextEncoder().encode(text), timeoutMs: 15000 })
  return r.code === 0
}

// ---- one key of a JSON object, edited in place ----

interface Member {
  key: string
  /** where the key's opening quote is */
  start: number
  valueStart: number
  valueEnd: number
}

/** The top-level members of a JSON object, with where each sits in the text. */
export function topMembers(text: string): { open: number; close: number; members: Member[] } | undefined {
  let i = 0
  const ws = () => {
    while (i < text.length && ' \t\r\n﻿'.includes(text[i]!)) i++
  }
  const string = () => {
    if (text[i] !== '"') throw new Error('string')
    for (i++; i < text.length; i++) {
      if (text[i] === '\\') i++
      else if (text[i] === '"') return void i++
    }
    throw new Error('unterminated')
  }
  const value = () => {
    if (text[i] === '"') return string()
    if (text[i] === '{' || text[i] === '[') {
      let depth = 0
      for (; i < text.length; i++) {
        const c = text[i]
        if (c === '"') {
          string()
          i--
        } else if (c === '{' || c === '[') depth++
        else if (c === '}' || c === ']') {
          if (--depth === 0) return void i++
        }
      }
      throw new Error('unterminated')
    }
    const start = i
    while (i < text.length && !',}] \t\r\n'.includes(text[i]!)) i++
    if (i === start) throw new Error('value')
  }
  try {
    ws()
    if (text[i] !== '{') return undefined
    const open = i++
    const members: Member[] = []
    ws()
    if (text[i] === '}') return { open, close: i, members }
    for (;;) {
      ws()
      const start = i
      string()
      const key = JSON.parse(text.slice(start, i))
      ws()
      if (text[i++] !== ':') return undefined
      ws()
      const valueStart = i
      value()
      JSON.parse(text.slice(valueStart, i))
      members.push({ key, start, valueStart, valueEnd: i })
      ws()
      if (text[i] === ',') {
        i++
        continue
      }
      if (text[i] === '}') return { open, close: i, members }
      return undefined
    }
  } catch {
    return undefined
  }
}

/** Each key's value as written (the raw JSON), or undefined when the key isn't there. */
export function keyValues(text: string, keys: string[]): Map<string, string | undefined> | undefined {
  const obj = text.trim() ? topMembers(text) : { open: 0, close: 0, members: [] }
  if (!obj) return undefined
  return new Map(keys.map((k) => {
    const m = obj.members.findLast((m) => m.key === k)
    return [k, m && text.slice(m.valueStart, m.valueEnd)]
  }))
}

/**
 * The text with one top-level key set to `raw` (JSON as written) or removed (`undefined`),
 * everything around it untouched. `undefined` if the text isn't a JSON object.
 */
export function setKey(text: string, key: string, raw: string | undefined): string | undefined {
  const obj = topMembers(text)
  if (!obj) return undefined
  const { members } = obj
  const at = members.findLastIndex((m) => m.key === key)
  const m = members[at]
  if (raw !== undefined) {
    if (m) return text.slice(0, m.valueStart) + raw + text.slice(m.valueEnd)
    const first = members[0]
    const pair = `${JSON.stringify(key)}: ${raw}`
    // first in the object, indented like the key it goes in front of
    if (first) return text.slice(0, first.start) + pair + ',' + text.slice(obj.open + 1, first.start) + text.slice(first.start)
    return text.slice(0, obj.open + 1) + `\n  ${pair}\n` + text.slice(obj.close)
  }
  if (!m) return text
  if (members.length === 1) return text.slice(0, obj.open + 1) + text.slice(obj.close)
  // up to the next key (the comma and the next line's indent go with it), or from the previous value
  if (at < members.length - 1) return text.slice(0, m.start) + text.slice(members[at + 1]!.start)
  return text.slice(0, members[at - 1]!.valueEnd) + text.slice(m.valueEnd)
}

const same = (a: string | undefined, b: string | undefined) => {
  if (a === undefined || b === undefined) return a === b
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b))
  } catch {
    return a === b
  }
}

/** `now` with every key in `before` that differs put back as it was; undefined when nothing differs. */
export function restoreKeys(now: string, before: Map<string, string | undefined>): string | undefined {
  const current = keyValues(now, [...before.keys()])
  if (!current) return undefined
  let text = now
  let changed = false
  for (const [k, was] of before) {
    if (same(current.get(k), was)) continue
    const next = setKey(text, k, was)
    if (next === undefined) return undefined
    text = next
    changed = true
  }
  return changed ? text : undefined
}

// ---- watching a machine's file after a switch ----

interface Watch {
  before: Map<string, string | undefined>
  until: number
}
const watching = new Map<string, Watch>()

export interface KeepOptions {
  keys?: string[]
  windowMs?: number
  graceMs?: number
  pollMs?: number
}

/**
 * Notes the default model and effort in the machine's Claude Code settings, then watches the file
 * in the background and puts them back once Claude Code saves a switch. A second switch while a
 * watch runs extends it and keeps the first values. Resolves once the values are noted; `done`
 * resolves when the watch ends (for tests).
 */
export async function keepClaudeDefaults(host: Host, opts: KeepOptions = {}): Promise<{ done: Promise<void> }> {
  const windowMs = opts.windowMs ?? WINDOW_MS
  const running = watching.get(host.id)
  if (running) {
    running.until = Math.max(running.until, Date.now() + windowMs)
    return { done: Promise.resolve() }
  }
  const first = await readSettings(host).catch(() => undefined)
  const before = first && first !== 'same' ? keyValues(first.text, opts.keys ?? DEFAULT_KEYS) : undefined
  // a file that isn't JSON (or isn't UTF-8) is left alone
  if (!first || first === 'same' || !before) return { done: Promise.resolve() }
  const w: Watch = { before, until: Date.now() + windowMs }
  watching.set(host.id, w)
  const done = follow(host, w, first.sum, opts).finally(() => watching.get(host.id) === w && watching.delete(host.id))
  return { done }
}

async function follow(host: Host, w: Watch, sum: string, opts: KeepOptions) {
  const poll = opts.pollMs ?? 1000
  const grace = opts.graceMs ?? GRACE_MS
  let known = sum
  while (Date.now() < w.until) {
    await sleep(poll)
    const now = await readSettings(host, known).catch(() => undefined)
    if (!now || now === 'same') continue
    known = now.sum
    if (!now.sum) continue
    const text = restoreKeys(now.text, w.before)
    if (text === undefined) continue
    if (await writeSettings(host, now.sum, text).catch(() => false)) {
      console.log(`[claude] kept the default model and effort in ${host.id}'s Claude Code settings`)
      w.until = Math.min(w.until, Date.now() + grace)
    }
  }
}
