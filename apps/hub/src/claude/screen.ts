import type { AgentKind, PromptOption, ScreenPrompt, ScreenState } from '@inyon/protocol'
import { parseOpenCodeScreen } from '../agents/opencode-screen.ts'
import { parseCopilotScreen } from '../agents/copilot-screen.ts'

// a session named with /rename shows its name in the rule above the input box: "──── Name ─"
const RULE = /^\s*─{12,}(?: [^─]{1,100} ─{1,12})?\s*$/
/** Dialog tops are drawn with ▔ (sometimes with a hint embedded in the line). */
const DIALOG_TOP = /^\s*▔{12,}/
const OPTION = /^(\s*)(❯\s*)?(\d{1,2})\.\s(.*)$/
const INPUT = /^\s*[❯>!](\s|$)/
const SPINNER = /^\s*([^\s\w])\s+([A-Z][\w'’ -]*…)\s*(?:\((.*)\))?\s*$/u
const MODE = /(?:⏵⏵|⏸|⏵)\s+([a-z][a-z ]*?)(?: mode)? on\b/
/** Claude Code 2.1.29x labels the input box's top rule "ultracode ─" while ultracode is on */
const ULTRACODE_RULE = /(?:^|\s)ultracode ─{1,12}\s*$/
/** its effort line above the box: "◉ xhigh · ultracode · /effort" (older builds drew ● and no ultracode) */
const EFFORT_LINE = /[◉●]\s+(low|medium|high|xhigh|max|auto)(\s+·\s+ultracode)?\s+·\s+\/effort\b/
const FOOTER = /(Esc to|Enter to|to cancel|to navigate|to select|to confirm)/i
/**
 * "1 shell", "2 monitors", "← 1 agent", "1 local agent", "1 background dynamic workflow" in the
 * footer: background work owned by the Claude process (2.1.299 names each kind, and "N background
 * tasks" for a mix)
 */
const BACKGROUND = /\b\d+ (?:local |background |remote |MCP |Artifact comment )?(?:shells?|monitors?|agents?|tasks?|terminals?|teams?|cloud sessions?|(?:dynamic )?workflows?|bash)\b/g
/** The agent list under the footer (toggled with ↓): "● main", "◯ general-purpose  Sleep briefly  6s · ↓ 37.9k tokens" */
const AGENT_ROW = /^\s*[●◯]\s/
const TABS = /^\s*←\s+(.+?)\s+→\s*$/
const CHECKBOX = /^\[([ ✔✓x×])\]\s*/
/** Working lines of other agents: "⠋ Working (12s • esc to interrupt)" and friends. */
const INTERRUPTIBLE = /(esc|ctrl\+c) to (interrupt|cancel|stop)/i

const isOption = (l: string) => OPTION.test(l)
/** highlight markers other agents put in front of a numbered option */
const GENERIC_CURSOR = /^(\s*)[›▸➤▶●]\s*(?=\d{1,2}\.\s)/

/**
 * Strips terminal styling from a captured line (tmux capture-pane -e) and notes whether all its
 * text is placeholder: Claude draws its prompt suggestions dimmed, with only the first character
 * inverted as a fake cursor, and only while the input is empty.
 */
export function unstyle(line: string): { text: string; ghost: boolean } {
  if (!line.includes('\x1b')) return { text: line, ghost: false }
  let text = ''
  let dim = false
  let inverse = false
  let dimChars = 0
  let solid = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\x1b') {
      const sgr = /^\x1b\[([\d;:]*)m/.exec(line.slice(i))
      if (sgr) {
        const codes = sgr[1] === '' ? [0] : sgr[1].split(/[;:]/).map(Number)
        for (let k = 0; k < codes.length; k++) {
          const c = codes[k]
          if (c === 0) dim = inverse = false
          else if (c === 2) dim = true
          else if (c === 22) dim = false
          else if (c === 7) inverse = true
          else if (c === 27) inverse = false
          else if (c === 38 || c === 48 || c === 58) k += codes[k + 1] === 5 ? 2 : codes[k + 1] === 2 ? 4 : 0
        }
        i += sgr[0].length - 1
        continue
      }
      // other escapes (OSC links, cursor moves): skip to their terminator
      const other = /^\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[\d;?]*[A-Za-z]|.)/.exec(line.slice(i))
      i += (other?.[0].length ?? 1) - 1
      continue
    }
    text += ch
    if (/\s/.test(ch) || /[❯>›»]/.test(ch)) continue
    if (dim) dimChars++
    else if (!inverse) solid++
  }
  return { text, ghost: dimChars > 0 && solid === 0 }
}

/** What a Claude pane's footer lists as running in the background: null for nothing, undefined when the footer isn't visible. */
export const backgroundOnScreen = (lines: string[]) => parseScreen(lines).background

/** Parses a captured Claude Code screen into what the UI needs. */
export function parseScreen(captured: string[], paneWidth?: number, agent: AgentKind = 'claude'): ScreenState {
  const styled = captured.map(unstyle)
  const raw = styled.map((l) => l.text)
  if (agent === 'copilot') return finish(parseCopilotScreen(raw, paneWidth))
  if (agent === 'opencode') return finish(parseOpenCodeScreen(raw, paneWidth))
  if (agent === 'antigravity') return finish(parseAntigravity(raw, paneWidth))
  if (agent === 'codex') return finish(parseCodex(raw, styled.map((l) => l.ghost), paneWidth))
  if (agent !== 'claude') return finish(parseGeneric(raw, paneWidth))
  const lines = raw.map((l) => l.replace(/\s+$/, ''))
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  const width = paneWidth || Math.max(0, ...lines.map((l) => l.length))
  const rules = lines.map((l, i) => (RULE.test(l) ? i : -1)).filter((i) => i >= 0)
  const state: ScreenState = { working: false, width }

  // Idle/working layout: rule, "❯ input", rule, status lines.
  let inputTop = -1
  for (let k = rules.length - 2; k >= 0; k--) {
    const top = rules[k]
    const next = lines[top + 1] ?? ''
    if (INPUT.test(next) && !isOption(next) && rules[k + 1] - top <= 15) {
      inputTop = top
      state.inputVisible = true
      // a line that fills the box was word-wrapped by Claude, not a real newline
      const rows = lines.slice(top + 1, rules[k + 1])
      let draft = ''
      rows.forEach((l, i) => {
        const text = i === 0 ? l.replace(/^\s*[❯>]\s?/, '') : l.replace(/^ {2}/, '')
        const prevFull = i > 0 && rows[i - 1].length >= width - 2
        draft += i === 0 ? text : prevFull ? ` ${text}` : `\n${text}`
      })
      draft = draft.trim()
      // a dimmed suggestion is not something you typed
      if (draft && !styled[top + 1]?.ghost && !/^Try "/.test(draft)) state.draft = draft
      // the switch is on the box itself, so it's known whenever the box is
      state.ultracode = ULTRACODE_RULE.test(lines[top])
      for (let i = top - 1; i >= Math.max(0, top - 4); i--) {
        const e = lines[i].match(EFFORT_LINE)
        if (!e) continue
        state.effort ??= e[1]
        if (e[2]) state.ultracode = true
        break
      }
      // every kind of background work in the footer, in order: "1 shell, 1 agent"; an agent's
      // description in the list under it could say anything, so those rows are skipped
      const background: string[] = []
      for (const l of lines.slice(rules[k + 1] + 1)) {
        if (AGENT_ROW.test(l)) continue
        const m = l.match(MODE)
        if (m) state.mode = m[1].trim()
        background.push(...(l.match(BACKGROUND) ?? []))
      }
      // the footer was read: nothing listed means nothing running (a hidden footer says nothing)
      state.background = background.length ? background.join(', ') : null
      break
    }
  }

  if (inputTop >= 0) {
    for (let i = inputTop - 1; i >= 0; i--) {
      const m = lines[i].match(SPINNER)
      if (m) {
        state.working = true
        state.activity = [m[2], m[3]].filter(Boolean).join(' (') + (m[3] ? ')' : '')
        break
      }
      // Never reuse a spinner from a previous turn in the scrollback.
      if (RULE.test(lines[i]) || INPUT.test(lines[i]) || /^\s*●\s/.test(lines[i])) break
    }
    return state
  }

  const tops = lines.map((l, i) => (RULE.test(l) || DIALOG_TOP.test(l) ? i : -1)).filter((i) => i >= 0)
  state.prompt = parsePrompt(lines, tops, width) ?? parseCursorMenu(lines) ?? parseInputDialog(lines, tops, width)
  return finish(state)
}

/** Pulls links out of a prompt's text and drops the indent its lines share. */
function finish(state: ScreenState): ScreenState {
  const prompt = state.prompt
  if (!prompt) {
    delete state.prompt
    return state
  }
  const { body, links } = extractLinks(prompt.body, state.width)
  const indent = Math.min(...body.filter((l) => l.trim() && l !== '╌').map((l) => l.length - l.trimStart().length), 99)
  prompt.body = body.map((l) => (l === '╌' ? l : l.slice(Math.min(indent, l.length - l.trimStart().length))))
  if (links.length) prompt.links = links
  return state
}

/**
 * Pulls URLs out of dialog text. Claude hard-wraps long URLs at the pane width, so a URL line that
 * fills the width continues on the next line (which starts at column 0).
 */
function extractLinks(body: string[], width: number) {
  const out: string[] = []
  const links: string[] = []
  for (let i = 0; i < body.length; i++) {
    const line = body[i]
    const m = line.match(/https?:\/\/\S+/)
    if (!m) {
      out.push(line)
      continue
    }
    // a link inside a sentence or command ("$ curl https://x | head") stays part of the text
    if (line.slice((m.index ?? 0) + m[0].length).trim()) {
      out.push(line)
      continue
    }
    let url = m[0]
    let cur = line
    while (cur.length >= width - 1 && i + 1 < body.length && /^\S/.test(body[i + 1]) && !/\s/.test(body[i + 1].trim())) {
      i++
      cur = body[i]
      url += cur.trim()
    }
    url = url.replace(/[).,;]+$/, '')
    links.push(url)
    const before = line.slice(0, m.index).trim()
    if (before) out.push(before)
  }
  return { body: out, links: [...new Set(links)] }
}

/** Dialogs that ask for text, e.g. /login's "Paste code here if prompted >". */
function parseInputDialog(lines: string[], tops: number[], width: number): ScreenPrompt | undefined {
  const tail = Math.max(0, lines.length - 14)
  let at = -1
  for (let i = lines.length - 1; i >= tail; i--) {
    if (/\S.*\s>\s*$/.test(lines[i]) || /(paste|enter|type)\b.*:\s*$/i.test(lines[i])) {
      at = i
      break
    }
  }
  if (at < 0) return undefined
  const footer = lines.slice(at + 1).find((l) => /esc to (cancel|go back)/i.test(l))
  if (!footer) return undefined
  const top = [...tops].reverse().find((t) => t < at) ?? Math.max(-1, at - 16)
  const body = lines.slice(top + 1, at).map((l) => l.replace(/^ {1,3}/, ''))
  while (body.length && !body[0].trim()) body.shift()
  void width
  return { body, options: [], multi: false, footer: footer.trim(), input: { label: lines[at].trim().replace(/\s*[>:]\s*$/, '') } }
}

/**
 * Menus without numbers (e.g. /remote-control's "Disconnect this session / Show QR code /
 * Continue"): a ❯ cursor on one item, siblings at the same indent, "Enter to select" below.
 */
function parseCursorMenu(lines: string[]): ScreenPrompt | undefined {
  const tail = lines.slice(-30)
  const footerAt = tail.findIndex((l) => /Enter to (select|confirm)/i.test(l))
  // some dialogs have no key hint (a held message from another session): then the menu has to be
  // the last thing on screen, where an idle or working Claude has its input box
  const block = footerAt >= 0 ? tail.slice(0, footerAt) : tail.slice(0, tail.findLastIndex((l) => l.trim()) + 1)
  const cur = block.findLastIndex((l) => /^\s*❯\s+\S/.test(l) && !OPTION.test(l))
  if (cur < 0) return undefined
  const col = block[cur].indexOf('❯') + 2
  const isItem = (l: string) => l.length > col && l.slice(0, col).trim() === '' && l[col] !== ' '
  let start = cur
  while (start > 0 && isItem(block[start - 1])) start--
  let end = cur
  while (end < block.length - 1 && isItem(block[end + 1])) end++
  if (end === start) return undefined
  if (footerAt < 0 && block.slice(end + 1).some((l) => l.trim())) return undefined
  const options: PromptOption[] = []
  for (let i = start; i <= end; i++) {
    const text = i === cur ? block[i].slice(block[i].indexOf('❯') + 1).trim() : block[i].trim()
    // "Deny — drop it and tell the sender it was declined": the button, then what it does
    const [label, ...rest] = text.split(/\s{3,}| — /)
    options.push({ n: options.length + 1, label, detail: rest.join(' ') || undefined, selected: i === cur })
  }
  // the title and description sit above the items, after the last rule
  let top = start - 1
  while (top > 0 && !RULE.test(block[top]) && !/^▔+$/.test(block[top].trim())) top--
  if (footerAt < 0 && top <= 0) return undefined
  // a quoted message is framed by dashes and marked "│ "; keep the frame as one '╌' marker
  const body = block
    .slice(top + 1, start)
    .map((l) => (/^\s*╌+\s*$/.test(l) ? '╌' : l.trim().replace(/^│ ?/, '')))
    .filter(Boolean)
  return { body, options, footer: footerAt >= 0 ? tail[footerAt].trim() : undefined, multi: false, navigate: true }
}

function parsePrompt(lines: string[], rules: number[], width: number): ScreenPrompt | undefined {
  // Box top = last full-width rule that opens the box (its next line isn't an option)
  // and has options somewhere below it.
  let top = -1
  for (let k = rules.length - 1; k >= 0; k--) {
    const r = rules[k]
    const below = lines.slice(r + 1)
    if (!isOption(lines[r + 1] ?? '') && below.filter(isOption).length >= 1) {
      top = r
      break
    }
  }
  // Some prompts have no rule above them (e.g. dialogs at the top of a fresh screen).
  if (top < 0) {
    const first = lines.findIndex(isOption)
    if (first < 0) return undefined
    top = Math.max(-1, first - 12)
  }
  const box = lines.slice(top + 1)
  const options: PromptOption[] = []
  const body: string[] = []
  let footer: string | undefined
  let tabs: ScreenPrompt['tabs']
  let current: PromptOption | null = null
  let optIndent = 0
  let prevLen = 0
  let prevText = ''

  for (const l of box) {
    if (RULE.test(l)) {
      current = null
      continue
    }
    const tm = l.match(TABS)
    if (tm && !options.length) {
      tabs = [...tm[1].matchAll(/([☐☒✔])\s+([^☐☒✔]+)/g)].map((m) => ({
        label: m[2].trim(),
        done: m[1] !== '☐',
        current: false,
      }))
      continue
    }
    const om = l.match(OPTION)
    if (om) {
      let label = om[4].trim()
      let checked: boolean | undefined
      const cb = label.match(CHECKBOX)
      if (cb) {
        checked = cb[1] !== ' '
        label = label.slice(cb[0].length)
      }
      current = { n: +om[3], label, selected: !!om[2], checked }
      optIndent = om[1].length + (om[2]?.length ?? 0)
      options.push(current)
      prevLen = l.length
      prevText = label
      continue
    }
    if (FOOTER.test(l) && !l.startsWith('  ')) {
      footer = l.trim()
      continue
    }
    if (current) {
      const t = l.trim()
      if (!t) continue
      const indent = l.length - l.trimStart().length
      if (/^(❯\s*)?(Submit|Next)$/.test(t)) continue
      if (indent > optIndent) {
        // Claude word-wraps labels; only a "word" too long for a whole line (a path) is broken
        // mid-word. Short continuation lines that wouldn't have fit are wrapped label text;
        // anything else is a description line.
        const firstWord = t.split(/\s/)[0]
        const lastWord = prevText.split(/\s/).pop() ?? ''
        const room = width - indent
        if (!current.detail && prevLen >= width - 1 && lastWord.length + firstWord.length > room) current.label += t
        else if (!current.detail && prevLen + 1 + firstWord.length > width) current.label += ` ${t}`
        else current.detail = current.detail ? `${current.detail} ${t}` : t
        prevText = t
        prevLen = l.length
        continue
      }
      // text after the options ends the option block
      current = null
    }
    if (!options.length) body.push(l.replace(/^ /, ''))
  }

  if (!options.length) return undefined
  // drop separator-only lines at the edges
  while (body.length && !body[0].trim()) body.shift()
  while (body.length && !body[body.length - 1].trim()) body.pop()

  const multi = options.some((o) => o.checked !== undefined)
  const free = options.find((o) => /^Type something\.?$/i.test(o.label))
  if (tabs?.length) {
    // The strip doesn't mark the current tab in plain text; infer it. The last tab is "Submit".
    const last = tabs.length - 1
    const reviewing = body.some((l) => /Review your answers|Ready to submit/i.test(l))
    const firstOpen = tabs.slice(0, last).findIndex((t) => !t.done)
    const idx = reviewing ? last : firstOpen < 0 ? Math.max(0, last - 1) : firstOpen
    // the Submit tab always shows ✔; it is only "done" once you're on it
    tabs = tabs.map((t, i) => ({ ...t, current: i === idx, done: i === last ? false : t.done }))
  }
  return {
    body: tidyBody(body, width),
    wholeLines: true,
    options,
    tabs,
    footer,
    multi,
    freeTextOption: free?.n,
  }
}

/**
 * One line for a prompt: the alert's text and the Needs-you card. A command prompt reads as what
 * the command is for, then its first line ("Re-run the test suite: npm test"); other framed
 * prompts as their title and the first framed line; the rest as their question.
 */
export function promptSummary(prompt: ScreenPrompt): string {
  const raw = prompt.body.map((l) => l.trim())
  const sep = raw.indexOf('╌')
  // the framed block (between ╌ separators) is the command or file being asked about
  const framed = sep >= 0 ? raw.slice(sep + 1).find((l) => l && l !== '╌') : undefined
  const keep = (l: string) => !!l && l !== '╌' && !/^Tip:/.test(l)
  const body = raw.filter(keep)
  const question = body.find((l) => /\?$/.test(l))
  const title = body[0]
  if (framed && title) {
    const about = raw.slice(raw.indexOf(title) + 1, sep).filter(keep).join(' ')
    // "Bash command" / "PowerShell command", then a line saying what it's for
    if (/command$/i.test(title)) return `${(about || title).replace(/[?:.]$/, '')}: ${framed}`.slice(0, 200)
    // "Edit file" / "Create file": the file's name sits above the frame, which holds the diff
    if (/file$/i.test(title) && about) return `${title}: ${about}`.slice(0, 200)
    return `${title.replace(/[?:.]$/, '')}: ${framed}`.slice(0, 200)
  }
  return prompt.input?.label ?? question ?? title ?? 'Needs your input'
}

/** a "│ " gutter Claude draws down the left of a framed command (psmux, newer Claude Code) */
const GUTTER = /^(\s*)[│╎┃](?: |$)/

/**
 * A dialog's text as its real lines. Dashed separators frame a command or file: they become one
 * '╌' marker, and a "│ " gutter inside the frame goes. Prose lines Claude wrapped at the pane width
 * are joined again; a line that ends short of the edge was a real line break and stays one.
 */
function tidyBody(body: string[], width: number) {
  const out: string[] = []
  let frame: string[] | undefined
  // on-screen length of the previous prose line (the parser dropped its first space)
  let prevLen = 0
  for (const l of body) {
    if (/^╌+$/.test(l.trim())) {
      if (frame) {
        const gutter = frame.every((f) => !f.trim() || GUTTER.test(f))
        out.push(...frame.map((f) => (gutter ? f.replace(GUTTER, '$1') : f)), '╌')
        frame = undefined
      } else {
        out.push('╌')
        frame = []
      }
      prevLen = 0
      continue
    }
    if (frame) {
      frame.push(l)
      continue
    }
    const t = l.trim()
    const first = t.split(/\s/)[0] ?? ''
    // the next word would have fit on the line above (a little slack for the dialog's padding)
    // (a long link is left for extractLinks, which joins its pieces without a space)
    const wrapped = prevLen > 0 && t && !/^([●•◦→\-*]|\d+[.)])\s/.test(t) && prevLen + 1 + first.length > width - 3 && !/https?:\/\/\S*$/.test(out[out.length - 1]!)
    if (wrapped) out[out.length - 1] += ` ${t}`
    else out.push(l)
    prevLen = t ? l.length + 1 : 0
  }
  if (frame) out.push(...frame)
  return out
}

/**
 * Agents other than Claude Code: working = an "esc to interrupt" line near the bottom; a prompt =
 * numbered options with an approval-style footer or question.
 */
function parseGeneric(raw: string[], paneWidth?: number): ScreenState {
  // Codex marks the highlighted row with ›, Gemini CLI with ●; read them like Claude's ❯
  const lines = raw.map((l) => l.replace(/\s+$/, '').replace(GENERIC_CURSOR, '$1❯ '))
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  const width = paneWidth || Math.max(0, ...lines.map((l) => l.length))
  const state: ScreenState = { working: false, width }
  const tail = lines.slice(-14)
  const busy = tail.find((l) => INTERRUPTIBLE.test(l))
  if (busy) {
    state.working = true
    state.activity = busy.replace(/^[\s│|]+|[\s│|]+$/g, '').replace(/^[^\w(]+\s*/u, '').replace(/\s*[•·(]?\s*(esc|ctrl\+c) to (interrupt|cancel|stop)\)?/i, '').trim()
  }
  const rules = lines.map((l, i) => (RULE.test(l) ? i : -1)).filter((i) => i >= 0)
  const bottom = lines.slice(-24)
  const looksLikePrompt =
    bottom.some((l) => /(allow|approve|proceed|run this|apply|continue|trust)\b.*\?|press enter|enter (to )?(continue|confirm|select)|esc (to )?(cancel|deny|back)|\(y\/n\)/i.test(l)) ||
    bottom.some((l) => /^\s*❯ \d{1,2}\.\s/.test(l))
  if (!state.working && looksLikePrompt) {
    const p = parsePrompt(lines, rules, width)
    if (p && p.options.length >= 2) {
      // these agents don't all take a digit as the answer; moving the highlight and pressing Enter always works
      if (p.options.some((o) => o.selected)) p.navigate = true
      const after = lines.slice(lines.findLastIndex((l) => OPTION.test(l)) + 1)
      p.footer ??= after.map((l) => l.trim()).find((l) => /\b(enter|esc)\b/i.test(l))
      state.prompt = p
    }
  }
  return state
}

const AGY_SPINNER = /^\s*[⠀-⣿]\s+(\S.*?)\s*$/
const AGY_MODE = /(?:^|\s{2,})(accept-edits|plan)\s+·\s/
const AGY_NAV = /↑\/↓ Navigate/
const AGY_FOOTER = /(?:^|\s{2,})(?:(?:accept-edits|plan) · )?([^\s·]+(?: [^\s·]+)*) · (low|medium|high|xhigh|max)(?: · [^·]+)*?\s*$/
const AGY_ITEM = /^(\s*)(>\s+)?(?:(\d{1,2})\.\s+)?(\S.*)$/

/**
 * Antigravity CLI (agy): an input box (rule, "> text", rule) with the footer under it; while it
 * works, a braille spinner ("⣽  Generating...") above the box, and queued messages as "▸ …".
 * Its slash and @ pickers open under the box. Approval and trust menus replace the box: "> " marks
 * the highlighted item (numbered for approvals, plain for the trust question) with a
 * "↑/↓ Navigate" line below.
 */
function parseAntigravity(raw: string[], paneWidth?: number): ScreenState {
  const lines = raw.map((l) => l.replace(/\s+$/, ''))
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  const width = paneWidth || Math.max(0, ...lines.map((l) => l.length))
  const state: ScreenState = { working: false, width }
  // the footer's right side always names the model and effort: "[plan · ]Gemini 3.8 Flash · high"
  const foot = lines[lines.length - 1]?.match(AGY_FOOTER)
  if (foot) {
    state.model = foot[1]
    state.effort = foot[2]
  }
  // "· 1 task(s) · /tasks" after the effort: shells agy left running, which die with it
  const tasks = lines[lines.length - 1]?.match(/ · (\d+) task\(s\) · \/tasks\s*$/)
  if (tasks && +tasks[1] > 0) state.background = `${tasks[1]} background ${+tasks[1] === 1 ? 'task' : 'tasks'}`
  const remote = agyRemote(lines, width)
  if (remote !== undefined) state.remote = remote
  const rules = lines.map((l, i) => (RULE.test(l) ? i : -1)).filter((i) => i >= 0)

  for (let k = rules.length - 2; k >= 0; k--) {
    const top = rules[k]
    const bottom = rules[k + 1]
    if (!/^\s*>(\s|$)/.test(lines[top + 1] ?? '') || bottom - top > 15) continue
    // only footer and picker lines may follow the box; a menu below means it's a past message, framed
    const after = lines.slice(bottom + 1)
    if (after.length > 16 || after.some((l) => /^\s*>\s+\d{1,2}\.\s/.test(l) || (AGY_NAV.test(l) && !/tab Complete/.test(l)))) break
    state.inputVisible = true
    const rows = lines.slice(top + 1, bottom)
    let draft = ''
    rows.forEach((l, i) => {
      const text = i === 0 ? l.replace(/^\s*>\s?/, '') : l.replace(/^ {2}/, '')
      const prevFull = i > 0 && rows[i - 1].length >= width - 2
      draft += i === 0 ? text : prevFull ? ` ${text}` : `\n${text}`
    })
    // an empty box in plan or accept-edits mode shows a grey hint, not something you typed
    if (draft.trim() && !/^[\w-]+ mode: .*\(shift\+tab to cycle\)$/.test(draft.trim())) state.draft = draft.trim()
    state.mode = 'default'
    for (const l of after) {
      const m = l.match(AGY_MODE)
      if (m) state.mode = m[1]
    }
    // queued messages ("▸ text", wrapped lines indented) sit between the spinner and the box. A
    // folded thought ("▸ Thought for 4s") looks the same, so only trust them under a spinner.
    const queue: string[] = []
    let wrap = ''
    for (let i = top - 1; i >= Math.max(0, top - 16); i--) {
      const l = lines[i]
      const q = l.match(/^▸\s+(.*)$/)
      if (q) {
        queue.unshift(`${q[1].trim()}${wrap}`)
        wrap = ''
        continue
      }
      if (/^ {2}\S/.test(l)) {
        wrap = ` ${l.trim()}${wrap}`
        continue
      }
      break
    }
    for (let i = top - 1; i >= 0; i--) {
      const m = lines[i].match(AGY_SPINNER)
      if (m) {
        state.working = true
        state.activity = m[1].replace(/\.{3}$|…$/, '')
        if (queue.length) state.queue = queue
        break
      }
      if (RULE.test(lines[i]) || /^\s*>\s/.test(lines[i])) break
    }
    return state
  }

  state.prompt = parseAgyMenu(lines)
  return state
}

/**
 * agy's list pickers (/rewind, /resume): a title at column 0, items indented two ("> " on the
 * highlighted one), a deeper line under an item for its detail ("(7m ago)"), a "[2-9 of 9 items]"
 * counter when the list scrolls, and "Keyboard: ↑/↓ Navigate  enter Select  esc Cancel" last.
 */
function parseAgyPicker(tail: string[], navAt: number): ScreenPrompt | undefined {
  const options: PromptOption[] = []
  let detail: string | undefined
  let title = ''
  for (let i = navAt - 1; i >= 0; i--) {
    const l = tail[i]
    if (!l.trim() || /^\s*\[\d+-\d+ of \d+ items?\]$/.test(l)) continue
    const sub = l.match(/^ {4,}(\S.*)$/)
    if (sub) {
      detail = detail ? `${sub[1].trim()} ${detail}` : sub[1].trim()
      continue
    }
    const item = l.match(/^(> | {2})(\S.*)$/)
    if (item) {
      options.unshift({ n: 0, label: item[2].trim(), detail: detail?.replace(/^\((.*)\)$/, '$1'), selected: item[1] === '> ' })
      detail = undefined
      continue
    }
    title = l.trim()
    break
  }
  // /model: the search field isn't an item, the effort slider under the list isn't either (its
  // ←/→ keys work on it), and "(current)" marks the model in use
  for (let i = options.length - 1; i >= 0; i--) {
    const o = options[i]
    if (/^Search:?$/.test(o.label) || /^Effort\s+◂/.test(o.label)) options.splice(i, 1)
    else if (/\s{2,}\(current\)$/.test(o.label)) {
      o.label = o.label.replace(/\s{2,}\(current\)$/, '')
      o.detail = ['current', o.detail].filter(Boolean).join(' · ')
    }
  }
  // a table (/resume: title, folder, steps, age) has a heading and a search line above its rows
  let rows = options
  if (options.some((o) => / {3,}/.test(o.label))) {
    const head = options.filter((o) => !/ {3,}/.test(o.label) && !/^Type to search/i.test(o.label))
    if (head.length) title = head[head.length - 1].label
    rows = options.filter((o) => / {3,}/.test(o.label))
    for (const o of rows) {
      const [label, ...cols] = o.label.split(/ {3,}/)
      o.label = label
      o.detail = [...cols, o.detail].filter(Boolean).join(' · ')
    }
  }
  rows.forEach((o, i) => (o.n = i + 1))
  if (rows.length < 1 || !rows.some((o) => o.selected)) return undefined
  return { body: title ? [title] : [], options: rows, footer: tail[navAt].trim(), multi: false, navigate: true }
}

/**
 * The latest /remote-control answer on screen: "Remote control on for this session." with an
 * "Open <link> on another device" line (wrapped at the pane edge when long), or "Remote control off."
 */
function agyRemote(lines: string[], width: number): string | null | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*(?:⎿\s+)?Remote control off\b/.test(lines[i])) return null
    if (!/^\s*(?:⎿\s+)?Remote control on for this session/.test(lines[i])) continue
    let text = ''
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      const l = lines[j]
      text += (j > i + 1 && lines[j - 1].length >= width - 1 ? '' : ' ') + l.trim()
      if (/on another device/.test(l)) break
    }
    return text.match(/https:\/\/\S+/)?.[0] ?? null
  }
  return undefined
}

function parseAgyMenu(lines: string[]): ScreenPrompt | undefined {
  const tail = lines.slice(-30)
  const navAt = tail.findLastIndex((l) => AGY_NAV.test(l))
  if (navAt < 0 || /tab Complete/.test(tail[navAt])) return undefined
  if (/^Keyboard:.*enter Select/.test(tail[navAt].trim())) return parseAgyPicker(tail, navAt)
  let end = navAt - 1
  while (end >= 0 && !tail[end].trim()) end--
  // walk up through the items (all at one indent); wrapped labels continue deeper
  type Row = { indent: number; n?: number; label: string; selected: boolean; full: boolean }
  const width = Math.max(0, ...lines.map((l) => l.length))
  const parse = (l: string): Row | undefined => {
    const m = l.trim() ? l.match(AGY_ITEM) : null
    return m ? { indent: m[1].length + (m[2]?.length ?? 0), n: m[3] ? Number(m[3]) : undefined, label: m[4].trim(), selected: !!m[2], full: l.length >= width - 1 } : undefined
  }
  const rows: Row[] = []
  const last = parse(tail[end] ?? '')
  const itemIndent = last?.indent ?? -1
  let first = end + 1
  for (let i = end; i >= 0; i--) {
    const r = parse(tail[i])
    if (!r) break
    if (last?.n) {
      // numbered (approvals): a long label wraps onto lines of any indent, even column 0
      if (r.n && r.indent !== itemIndent) break
    } else if (r.indent < itemIndent || (r.indent > itemIndent && r.n)) break
    rows.unshift(r)
    first = i
    if (r.n === 1) break
  }
  const numbered = rows.some((r) => r.n)
  const options: PromptOption[] = []
  for (const [i, r] of rows.entries()) {
    // wrapped label: the terminal drops the space at the edge, so join with one unless it broke after a hyphen
    if (numbered && !r.n && options.length) options[options.length - 1].label += `${rows[i - 1]?.full && /-$/.test(options[options.length - 1].label) ? '' : ' '}${r.label}`
    else if (numbered && !r.n) continue
    else options.push({ n: r.n ?? options.length + 1, label: r.label, selected: r.selected })
  }
  if (options.length < 2 || !options.some((o) => o.selected)) return undefined
  // the text above the menu, up to a blank pair or a rule
  const above: string[] = []
  for (let i = first - 1, blanks = 0; i >= 0 && above.length < 12; i--) {
    const l = tail[i]
    if (RULE.test(l)) break
    blanks = l.trim() ? 0 : blanks + 1
    if (blanks >= 2) break
    above.unshift(l)
  }
  while (above.length && !above[0].trim()) above.shift()
  let body = above.filter((l) => l.trim())
  // "Requesting permission for: <command>  Run this command?" → question, then the command framed
  const ask = body.findIndex((l) => /^Requesting permission for:?$/i.test(l.trim()))
  if (ask >= 0) {
    const question = body.slice(ask + 1).find((l) => /\?$/.test(l.trim()))
    const detail = body.slice(ask + 1).filter((l) => l !== question)
    const indent = Math.min(...detail.map((l) => l.length - l.trimStart().length))
    detail.forEach((l, i) => (detail[i] = l.slice(indent)))
    body = [question?.trim() ?? body[ask].trim(), '╌', ...detail, '╌']
  }
  return { body, options, footer: tail[navAt].trim(), multi: false, navigate: true }
}

// ---------- Codex ----------

/** "GPT-6-Luna high · ~/project" under the composer; the effort reads "default" until you pick one */
const CX_FOOTER = /^ {2}(\S.*?) (default|none|minimal|low|medium|high|xhigh|max|ultra) · [~/]/
const CX_WORKING = /^•\s+(.+?)\s+\((?:\d+[hms][^•)]*)•\s*esc to interrupt\)(.*)$/
const CX_NAV = /^\s*(Press enter to confirm|enter (select|default|continue|confirm)|.*\besc (back|to cancel)\b)/
const CX_OPTION = /^(›| ) (\d{1,2})\. (.*)$/

/**
 * Codex 0.16x: transcript lines start with "•" (or "›" for your messages), then the composer
 * ("› text", wrapped lines indented two), a footer with the model, effort and folder ("… Plan mode"
 * at the end in Plan mode) and a hint line. While it works, "• Working (5s • esc to interrupt)"
 * sits above the composer, then "• Queued follow-up inputs" with "↳ text" rows. Menus (approvals,
 * /model, /permissions) replace the composer: a title, "› 1. Option  detail" rows and a key hint.
 */
function parseCodex(raw: string[], ghost: boolean[], paneWidth?: number): ScreenState {
  const lines = raw.map((l) => l.replace(/\s+$/, ''))
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  const width = paneWidth || Math.max(0, ...lines.map((l) => l.length))
  const state: ScreenState = { working: false, width }
  const footAt = lines.findLastIndex((l, i) => i >= lines.length - 4 && CX_FOOTER.test(l))
  let box = -1
  if (footAt > 0) {
    for (let i = footAt - 1; i >= 0; i--) {
      // "»" instead of "›" when Ultra effort lets Codex delegate
      if (/^[›»!] /.test(lines[i]) || /^[›»!]$/.test(lines[i])) {
        // a highlighted menu row is not the composer
        if (!CX_OPTION.test(lines[i])) box = i
        break
      }
      if (lines[i] && !/^ {2}/.test(lines[i])) break
    }
  }
  if (box < 0) {
    state.prompt = parseCodexMenu(lines)
    return state
  }
  const foot = lines[footAt].match(CX_FOOTER)!
  state.inputVisible = true
  state.model = foot[1]
  state.effort = foot[2]
  if (/ Plan mode$/.test(lines[footAt])) state.mode = 'plan'
  const rows = lines.slice(box, footAt)
  while (rows.length > 1 && !rows[rows.length - 1]) rows.pop()
  let draft = ''
  rows.forEach((l, i) => {
    const text = i === 0 ? l.replace(/^[›»]\s?/, '') : l.replace(/^ {2}/, '')
    const prevFull = i > 0 && rows[i - 1].length >= width - 2
    draft += i === 0 ? text : prevFull ? ` ${text}` : `\n${text}`
  })
  // the empty composer shows a dimmed suggestion ("Ask Codex to do anything")
  if (draft.trim() && !ghost[box]) state.draft = draft.trim()

  const queue: string[] = []
  let wrap = ''
  for (let i = box - 1; i >= 0; i--) {
    const l = lines[i]
    const w = l.match(CX_WORKING)
    if (w) {
      state.working = true
      state.activity = w[1]
      const bg = w[2].match(/(\d+) background terminals? running/)
      if (bg) state.background = `${bg[1]} background ${+bg[1] === 1 ? 'terminal' : 'terminals'}`
      break
    }
    const q = l.match(/^ {2}↳ (.*)$/)
    if (q) {
      queue.unshift(`${q[1].trim()}${wrap}`)
      wrap = ''
    } else if (/^ {4}\S/.test(l)) {
      if (!/edit last queued/.test(l)) wrap = ` ${l.trim()}${wrap}`
    } else if (/^[›»•] /.test(l) && l !== '• Queued follow-up inputs') break
  }
  if (state.working && queue.length) state.queue = queue
  if (!state.working) {
    // idle, with shells still running in the background
    const tail = lines.slice(Math.max(0, box - 6), box).join(' ')
    const bg = tail.match(/(\d+) background terminals? running/)
    if (bg) state.background = `${bg[1]} background ${+bg[1] === 1 ? 'terminal' : 'terminals'}`
  }
  // the composer was read: nothing listed means nothing running
  state.background ??= null
  return state
}

/** An approval or picker: title and body lines, numbered options with a detail column, a key hint. */
function parseCodexMenu(lines: string[]): ScreenPrompt | undefined {
  const tail = lines.slice(-40)
  const navAt = tail.findLastIndex((l) => CX_NAV.test(l))
  if (navAt < 0) return undefined
  const options: PromptOption[] = []
  let i = navAt - 1
  while (i >= 0 && !tail[i].trim()) i--
  let wrap = ''
  for (; i >= 0; i--) {
    const l = tail[i]
    const m = l.match(CX_OPTION)
    if (m) {
      let [label, ...cols] = m[3].split(/ {2,}/)
      const detail = [...cols, wrap.trim()].filter(Boolean).join(' ')
      // "(y)" is the option's key, "(current)" marks what's set now
      const current = /\(current\)/.test(label)
      label = label.replace(/\s*\((?:y|p|a|n|esc)\)\s*$/i, '').replace(/\s*\(current\)/, '').trim()
      options.unshift({ n: +m[2], label, detail: detail || undefined, selected: m[1] === '›', ...(current && { current }) })
      wrap = ''
      continue
    }
    if (/^ {4,}\S/.test(l)) {
      wrap = ` ${l.trim()}${wrap}`
      continue
    }
    break
  }
  // a submenu can have a single row ("Advanced Reasoning": Max)
  if (!options.length || !options.some((o) => o.selected)) return undefined
  // the body: lines above the options up to the last transcript entry ("• Running …" stays as context)
  const body: string[] = []
  for (let j = i; j >= Math.max(0, i - 14); j--) {
    const l = tail[j]
    if (/^[›•] /.test(l)) {
      if (/^• (Running|Ran) /.test(l)) body.unshift(l.replace(/^• /, '').trim())
      break
    }
    // a dialog on a fresh screen sits under Codex's banner (">_ OpenAI Codex (v…)" and the folder)
    if (/^\s*>_ OpenAI Codex\b/.test(l)) {
      body.splice(0, body.length && /^[~/]/.test(body[0]) ? 1 : 0)
      break
    }
    if (l.trim()) body.unshift(l.trim())
  }
  return { body, options, footer: tail[navAt].trim(), multi: false, navigate: true }
}

/**
 * Codex's rewind browser (Esc Esc: "Browsing · ↑↓ · ↵ rewind · esc") shows the chosen past message
 * in reverse video after its "›". Returns that message's first line, or undefined when not browsing.
 */
export function codexBrowsing(captured: string[]): { selected?: string; screen?: string } | undefined {
  const text = captured.map((l) => unstyle(l).text.replace(/\s+$/, ''))
  if (!text.slice(-4).some((l) => /^\s*Browsing · /.test(l))) return undefined
  for (let i = captured.length - 1; i >= 0; i--) {
    const m = captured[i].match(/^(?:\x1b\[[\d;]*m)*[›»] (?:\x1b\[[\d;]*m)*\x1b\[(?:0;)?7m/)
    if (m) return { selected: text[i].replace(/^[›»]\s?/, '').trim(), screen: captured.join('\n') }
  }
  return {}
}
