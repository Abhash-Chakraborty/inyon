import { Host, shq, type PtyHandle } from '../hosts/host.ts'
import { pasteCommand, pasteText, typeCommand } from '../tmux/tmux.ts'

/**
 * A terminal for psmux (tmux on Windows), drawn from the pane's screen rather than from a terminal
 * of its own. psmux runs one server per session, so a view session can't hold another session's
 * window, and Bun has no pseudo-terminal on Windows to attach a client in. So the screen is read
 * with capture-pane whenever it changes and drawn line by line, and what you type goes back
 * through send-keys. While it's open the window takes the phone's size, as a second tmux client
 * would make it, and it goes back to fitting the laptop once the terminal closes.
 */

/** xterm's sequences for the keys tmux knows by name. */
const NAMED: Record<string, string> = {
  '[A': 'Up', '[B': 'Down', '[C': 'Right', '[D': 'Left', '[H': 'Home', '[F': 'End',
  OA: 'Up', OB: 'Down', OC: 'Right', OD: 'Left', OH: 'Home', OF: 'End',
  '[2~': 'IC', '[3~': 'DC', '[5~': 'PPage', '[6~': 'NPage', '[1~': 'Home', '[4~': 'End', '[Z': 'BTab',
  OP: 'F1', OQ: 'F2', OR: 'F3', OS: 'F4', '[15~': 'F5', '[17~': 'F6', '[18~': 'F7', '[19~': 'F8',
  '[20~': 'F9', '[21~': 'F10', '[23~': 'F11', '[24~': 'F12',
}
/** xterm's modifier numbers (1 + shift 1, alt 2, ctrl 4) as tmux prefixes */
const MODS: Record<string, string> = { '2': 'S-', '3': 'M-', '4': 'M-S-', '5': 'C-', '6': 'C-S-', '7': 'C-M-', '8': 'C-M-S-' }

export type Input = { keys: string[] } | { text: string } | { paste: string } | { hex: string[] }

/**
 * What the browser terminal sent, as tmux input: printable runs as literal text, keys by name
 * (psmux knows names and -l for sure), a bracketed paste as one paste, and anything else as raw
 * bytes (-H).
 */
export function toInput(d: string): Input[] {
  const out: Input[] = []
  const key = (k: string) => {
    const last = out.at(-1)
    if (last && 'keys' in last) last.keys.push(k)
    else out.push({ keys: [k] })
  }
  const hex = (s: string) => out.push({ hex: [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')) })
  let i = 0
  while (i < d.length) {
    const c = d[i]
    if (d.startsWith('\x1b[200~', i)) {
      const end = d.indexOf('\x1b[201~', i + 6)
      out.push({ paste: d.slice(i + 6, end < 0 ? d.length : end) })
      i = end < 0 ? d.length : end + 6
      continue
    }
    if (c === '\x1b') {
      const m = d.slice(i + 1).match(/^(?:\[[0-?]*[ -/]*[@-~]|O[A-Za-z])/)
      if (m) {
        const seq = m[0]
        // modified keys: ESC [ 1 ; 5 A (Ctrl+Up), ESC [ 3 ; 2 ~ (Shift+Delete)
        const mod = seq.match(/^\[(\d*);(\d)([A-Za-z~])$/)
        const name = mod ? NAMED[mod[3] === '~' ? `[${mod[1]}~` : `[${mod[3]}`] : NAMED[seq]
        if (name && (!mod || MODS[mod[2]])) key((mod ? MODS[mod[2]] : '') + name)
        else hex(`\x1b${seq}`)
        i += 1 + seq.length
        continue
      }
      const next = d[i + 1]
      // Alt+key arrives as ESC and the key
      if (next && next >= ' ' && next <= '~') {
        key(`M-${next}`)
        i += 2
      } else {
        key('Escape')
        i++
      }
      continue
    }
    const code = c.charCodeAt(0)
    if (code === 13) key('Enter')
    else if (code === 9) key('Tab')
    else if (code === 127 || code === 8) key('BSpace')
    else if (code === 0) key('C-Space')
    else if (code < 32) key(`C-${String.fromCharCode(code + (code <= 26 ? 96 : 64))}`)
    else {
      let j = i
      while (j < d.length && d.charCodeAt(j) >= 32 && d.charCodeAt(j) !== 127 && d[j] !== '\x1b') j++
      const last = out.at(-1)
      if (last && 'text' in last) last.text += d.slice(i, j)
      else out.push({ text: d.slice(i, j) })
      i = j
      continue
    }
    i++
  }
  return out
}

/**
 * A batch of input as few commands as it can go in: one shell for the whole batch, keys and text
 * joined with &&, so it stops at the first that fails as one command per piece did. A shell has one
 * stdin, so each piece of text after the first starts the next command. On Windows every program
 * started is slow (sh, psmux, and busybox's mktemp, cat and rm), so a keystroke plus Enter is one
 * shell, not two.
 */
export function batchCommands(pane: string, inputs: Input[]): { cmd: string; input?: string }[] {
  const out: { cmd: string; input?: string }[] = []
  let parts: string[] = []
  let input: string | undefined
  const close = () => {
    if (!parts.length) return
    out.push({ cmd: parts.length === 1 ? parts[0] : parts.map((p) => (p.startsWith('umask ') ? `{ ${p}; }` : p)).join(' && '), ...(input === undefined ? {} : { input }) })
    parts = []
    input = undefined
  }
  for (const x of inputs) {
    const c = inputCommand(pane, x)
    if (c.input !== undefined && input !== undefined) close()
    parts.push(c.cmd)
    if (c.input !== undefined) input = c.input
  }
  close()
  return out
}

/** The tmux commands for one piece of input, and what to feed them. */
export function inputCommand(pane: string, x: Input): { cmd: string; input?: string } {
  const t = `tmux send-keys -t ${shq(pane)}`
  if ('keys' in x) return { cmd: `${t} ${x.keys.map(shq).join(' ')}` }
  // through a buffer, never the command line, where other users could read it
  if ('text' in x) return { cmd: typeCommand(`inyon-term-${Math.random().toString(36).slice(2, 10)}`, pane), input: x.text }
  if ('hex' in x) return { cmd: `${t} -H ${x.hex.join(' ')}` }
  return { cmd: pasteCommand(`inyon-term-${Math.random().toString(36).slice(2, 10)}`, pane), input: pasteText(x.paste) }
}

export interface Screen {
  width: number
  height: number
  cursor: { x: number; y: number; visible: boolean }
  lines: string[]
  /** a full-screen program (the alternate screen), which takes the mouse wheel and clicks */
  mouse?: boolean
}

/** Reads the pane's size, cursor and screen (with colours) in one go. */
export const readCommand = (pane: string) =>
  `tmux display -p -t ${shq(pane)} '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag} #{alternate_on}' && tmux capture-pane -p -e -t ${shq(pane)}`

export function parseScreen(stdout: string): Screen | undefined {
  const [head, ...lines] = stdout.replace(/\r\n/g, '\n').split('\n')
  const [w, h, x, y, flag, alt] = (head ?? '').trim().split(/\s+/).map(Number)
  if (!(w > 0 && h > 0)) return undefined
  // capture-pane ends with a newline; keep exactly one entry per row
  if (lines.length > h) lines.length = h
  while (lines.length < h) lines.push('')
  return { width: w, height: h, cursor: { x: x || 0, y: y || 0, visible: flag !== 0 }, lines, mouse: alt === 1 }
}

/**
 * What to write to the browser terminal to turn the last screen into this one: only the lines
 * that changed, each drawn from its first column with wrapping off, so a pane wider than the
 * phone is cut at the edge instead of spilling onto the next row.
 */
export function drawScreen(prev: Screen | undefined, next: Screen): string {
  // bracketed paste on, so a pasted block arrives as one paste rather than lines that each submit
  let out = prev ? '' : '\x1b[?7l\x1b[?2004h\x1b[0m\x1b[H\x1b[2J'
  // a full-screen program (Claude Code's, say) scrolls with the wheel: the browser terminal reports
  // the mouse while one runs, and those reports go to it as they are (psmux passes them on); a full
  // redraw (after a resize, say) says the mode again, since the browser terminal may still have it on
  if (!prev || !!prev.mouse !== !!next.mouse) out += next.mouse ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l'
  for (let i = 0; i < next.lines.length; i++) {
    if (prev && prev.lines[i] === next.lines[i] && prev.width === next.width) continue
    out += `\x1b[${i + 1};1H\x1b[0m${next.lines[i]}\x1b[0m\x1b[K`
  }
  // rows below a pane that got shorter
  if (prev && prev.lines.length > next.lines.length) out += `\x1b[${next.lines.length + 1};1H\x1b[0m\x1b[J`
  const c = next.cursor
  const moved = !prev || prev.cursor.x !== c.x || prev.cursor.y !== c.y || prev.cursor.visible !== c.visible
  if (out || moved) out += `\x1b[${c.y + 1};${c.x + 1}H${c.visible ? '\x1b[?25h' : '\x1b[?25l'}`
  return out
}

/** Polling slows down while the screen stays the same, and speeds up the moment it changes. */
const FAST_MS = 120
const SLOW_MS = 1000

export function openMirror(
  host: Host,
  paneId: string,
  cols: number,
  rows: number,
  onData: (d: Uint8Array) => void,
  onOutput?: (fn: () => void) => () => void,
): PtyHandle {
  const enc = new TextEncoder()
  const p = shq(paneId)
  let shown: Screen | undefined
  let closed = false
  let size = { cols, rows }
  let resized = false
  let reading = false
  let again = false
  let delay = FAST_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  let finish!: (code: number) => void
  const exited = new Promise<number>((r) => (finish = r))

  const close = (code: number) => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    off?.()
    // let the window fit its own clients again
    if (resized) host.exec(`tmux resize-window -t ${p} -A 2>/dev/null; tmux set-option -w -t ${p} -u window-size 2>/dev/null; true`).catch(() => {})
    finish(code)
  }

  const fit = async () => {
    resized = true
    await host.exec(`tmux resize-window -t ${p} -x ${size.cols} -y ${size.rows}`).catch(() => {})
  }

  const schedule = (ms: number) => {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(read, ms)
  }

  async function read() {
    if (closed) return
    if (reading) return void (again = true)
    reading = true
    try {
      const r = await host.exec(readCommand(paneId), { timeoutMs: 10_000 })
      if (closed) return
      const next = parseScreen(r.stdout)
      if (!next) {
        // the pane is gone (or the machine): end the terminal like a detach would
        if (r.code !== 0) close(r.code || 1)
        return
      }
      const d = drawScreen(shown?.width === next.width && shown.height === next.height ? shown : undefined, next)
      shown = next
      if (d) onData(enc.encode(d))
      delay = d ? FAST_MS : Math.min(SLOW_MS, delay * 2)
    } catch {
      delay = SLOW_MS
    } finally {
      reading = false
      if (again) {
        again = false
        schedule(0)
      } else schedule(delay)
    }
  }

  // keystrokes go out in order, and whatever piled up during one round trip goes as one batch
  let pending = ''
  let writing = false
  const flush = async () => {
    if (writing || closed || !pending) return
    writing = true
    const d = pending
    pending = ''
    try {
      for (const { cmd, input } of batchCommands(paneId, toInput(d))) await host.exec(cmd, input === undefined ? {} : { input })
    } catch {}
    writing = false
    delay = FAST_MS
    schedule(30)
    if (pending) flush()
  }

  const off = onOutput?.(() => {
    delay = FAST_MS
    if (!reading) schedule(40)
  })
  fit().then(() => schedule(0))

  return {
    write(d) {
      pending += d
      flush()
    },
    resize(c, r) {
      if (c === size.cols && r === size.rows) return
      size = { cols: c, rows: r }
      fit().then(() => {
        shown = undefined
        schedule(0)
      })
    },
    kill: () => close(0),
    exited,
  }
}
