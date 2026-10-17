import type { PromptOption, ScreenState } from '@inyon/protocol'

/** a row of OpenCode's input box (or the permission/question panel that replaces it): the bar sits at column 2 */
const BOX = /^\s{0,3}┃/
/** what /undo leaves in the box ("1 message reverted", "ctrl+x r or /redo to restore"): not typed text */
const NOTICE = /^(\d+ messages? reverted|.*\/redo to restore)$/
/** "1. Tabs", or "2. [✓] Green" in a multi-select question */
const OPTION = /^(\d+)\.\s+(?:\[([ ✓✔x×])\]\s+)?(.+)$/
/** the hint row under a question: "↑↓ select  enter submit  esc dismiss" (toggle for multi-select, confirm in a multi-question dialog) */
const QUESTION_FOOTER = /enter (submit|confirm|toggle)|esc dismiss/
/** "15.8K (8%)" in the status row, which wraps on narrow panes ("16.1K (8%ctrl+p") */
const STATUS_PCT = /\((\d{1,3})%/
const SIDE_TOKENS = /^([\d,]+) tokens$/
const SIDE_PCT = /^(\d{1,3})% used$/
const SIDE_COST = /^\$(\d+(?:\.\d+)?) spent$/

/**
 * OpenCode 1.19 TUI. The input box is a column of "┃" rows ending in a footer row
 * ("Build · Big Pickle OpenCode · high": agent, model with its provider, variant) above a "╹▀▀▀"
 * edge, with a status row under it ("⬝⬝⬝ esc interrupt … 16.6K (8%)  ctrl+p commands"). A
 * permission request or a question from the agent takes the box's place. Wide windows add a
 * sidebar on the right (title, context tokens, % used, $ spent), which is cut off the rows and
 * read on its own. `styled` is the same screen with its colours, used to tell which tab of a
 * multi-question dialog is open.
 */
export function parseOpenCodeScreen(lines: string[], width = 120, styled?: string[]): ScreenState {
  const state: ScreenState = { working: false, width }
  const all = lines.map((l) => l.replace(/\s+$/, ''))
  while (all.length && !all[all.length - 1]) all.pop()
  const w = width || Math.max(0, ...all.map((l) => l.length))
  // the sidebar starts ~40 columns from the right edge, after a wide gap
  const split = (l: string): [string, string | undefined] => {
    const gap = /\s{4,}(?=\S)/g
    for (let m; (m = gap.exec(l)); ) {
      const at = m.index + m[0].length
      if (w >= 100 && at >= w - 46) return [l.slice(0, m.index), l.slice(at).trim()]
    }
    return [l, undefined]
  }
  const cut = (l: string) => split(l)[0]
  for (const l of all) {
    const side = split(l)[1]
    if (!side) continue
    const tokens = side.match(SIDE_TOKENS)
    const pct = side.match(SIDE_PCT)
    const cost = side.match(SIDE_COST)
    if (tokens) state.contextUsed = Number(tokens[1].replace(/,/g, ''))
    if (pct) state.contextPct = Number(pct[1])
    if (cost) state.costUsd = Number(cost[1])
  }

  // the box ends in a "╹▀▀▀" edge; on the home screen (no conversation yet) it's centred, so its
  // column is read off that edge rather than assumed
  const edge = all.findLastIndex((l) => /╹▀▀/.test(l))
  const col = edge >= 0 ? all[edge].indexOf('╹') : -1
  const below = edge >= 0 ? all.slice(edge + 1) : all.slice(-3)
  const status = below.find((l) => /esc interrupt|esc again to interrupt|ctrl\+p\b/.test(l))
  if (status && /esc (again to )?interrupt/.test(status)) {
    state.working = true
    const text = status.replace(/^[\s⬝■]+/, '').split(/\s{2,}/)[0]
    state.activity = /retrying/i.test(status) ? `Retrying${text.match(/retrying in \d+s/i) ? ` (${text.match(/retrying in \d+s/i)![0].replace(/^retrying /i, '')})` : ''}` : 'Working'
  }
  // the status row's percentage is the context window; its token count isn't (the sidebar's is).
  // Nothing under the edge is sidebar, however far right it sits.
  if (state.contextPct === undefined) {
    const pct = below.map((l) => l.match(STATUS_PCT)).find(Boolean)
    if (pct) state.contextPct = Number(pct[1])
  }

  const inBox = (l: string) => (col > 3 ? l[col] === '┃' && !l.slice(0, col).trim() : BOX.test(l))
  const end = col > 3 ? edge - 1 : all.findLastIndex((l) => BOX.test(l))
  if (end < 0 || !inBox(all[end])) return state
  let start = end
  while (start > 0 && inBox(all[start - 1]) && end - start < 40) start--
  // each row with the line it came from, so its colours can be looked up
  const rows = all
    .slice(start, end + 1)
    .map((l, i) => ({ at: start + i, text: l }))
    // the slash-command popup is drawn inside its own ┃…┃ frame right above the box (filtered
    // before the sidebar cut, which would take its right edge)
    .filter(({ text }) => !/┃.*\S.*┃\s*$/.test(text))
    .map(({ at, text }) => ({ at, text: (col > 3 ? text.slice(col) : cut(text)).replace(/^\s{0,3}┃ {0,2}/, '').replace(/\s+$/, '') }))
  const texts = rows.map((r) => r.text)

  // a menu opened from the TUI (models, variants, agents, sessions) sits over everything with "esc" in its title row
  // (transcript text can show to its left, and the sidebar to its right)
  const title = all.slice(0, start).map((l) => l.match(/(?:^|\s{3,})([A-Z][\w ]{2,40}?) {3,}esc(?: {2,}|$)/)?.[1]).find(Boolean)
  const dialog = !!title || all.slice(0, start).some((l) => /\S {3,}esc(?: {2,}|$)/.test(l))
  // on the home screen the menu can cover the footer too
  if (dialog) {
    state.inputVisible = false
    if (title) state.dialog = title.trim()
  }

  // "Allow always" asks once more ("Always allow … until OpenCode is restarted", Confirm / Cancel)
  const permission = texts.findIndex((r) => /Permission required|△ Always allow\s*$/.test(r))
  if (permission >= 0) {
    const always = /Always allow\s*$/.test(texts[permission])
    const optionRow = texts.findIndex((r, i) => i > permission && (always ? /Confirm\s{2,}Cancel/ : /Allow once/).test(r))
    const labels = (optionRow >= 0 ? texts[optionRow] : always ? 'Confirm   Cancel' : 'Allow once   Allow always   Reject')
      .split(/\s{2,}/)
      .map((s) => s.trim())
      .filter((s) => s && !/fullscreen|select|confirm|ctrl\+/.test(s))
    const body = texts
      .slice(permission + 1, optionRow >= 0 ? optionRow : undefined)
      .map((r) => r.replace(/^[\s←→↳]+/, '').trim())
      .filter(Boolean)
    state.prompt = {
      body: [always ? 'Always allow this until OpenCode restarts?' : 'OpenCode needs permission', ...body],
      options: labels.map((label, i) => ({ n: i + 1, label, selected: i === 0 })),
      multi: false,
      navigate: true,
    }
    return state
  }

  const footerAt = texts.findIndex((r) => QUESTION_FOOTER.test(r))
  if (footerAt >= 0 && !texts.slice(0, footerAt).some((r) => /^\S.* · \S/.test(r.trim()))) {
    const panel = rows.slice(0, footerAt)
    while (panel.length && !panel[0].text.trim()) panel.shift()
    // a dialog with several questions (or one with checkboxes) opens with a tab strip:
    // "Indentation   Colours   Confirm", the open tab drawn on its own background
    const first = panel[0]?.text.trim().split(/\s{2,}/) ?? []
    let tabs: NonNullable<ScreenState['prompt']>['tabs']
    if (first.length >= 2 && first[first.length - 1] === 'Confirm') {
      const current = currentTab(styled?.[panel[0].at], first)
      tabs = first.map((label, i) => ({ label, done: current >= 0 && i < current, current: i === current }))
      panel.shift()
    }
    const body = panel.map((r) => r.text)
    const questions = (tabs?.length ?? 1) - (tabs ? 1 : 0)
    const current = tabs?.findIndex((t) => t.current) ?? -1
    const last = current < 0 ? questions <= 1 : current >= questions - 1
    const firstOption = body.findIndex((r) => OPTION.test(r))
    // the Confirm tab: what was answered, and Enter sends it all
    if (firstOption < 0 && /^Review$/i.test(body.find((r) => r.trim()) ?? '')) {
      state.prompt = { body: body.map((r) => r.trim()).filter(Boolean), options: [], multi: false, confirm: 'Submit', tabs }
      return state
    }
    if (firstOption >= 0) {
      const options: PromptOption[] = []
      let multi = false
      for (const r of body.slice(firstOption)) {
        const m = r.match(OPTION)
        if (m) {
          const option: PromptOption = { n: +m[1], label: m[3].trim(), selected: options.length === 0 }
          if (m[2] !== undefined) {
            option.checked = m[2] !== ' '
            multi = true
          }
          options.push(option)
        } else if (r.trim() && options.length) {
          const prev = options[options.length - 1]
          prev.detail = [prev.detail, r.trim()].filter(Boolean).join(' ')
        }
      }
      const free = options.find((o) => /^Type your own answer$/i.test(o.label))
      state.prompt = {
        body: body.slice(0, firstOption).map((r) => r.trim()).filter(Boolean),
        options,
        multi,
        freeTextOption: free?.n,
        tabs,
        // checkboxes are toggled one by one; Tab moves on to the next question or the Confirm step
        ...(multi ? { confirm: last ? 'Confirm' : 'Next' } : {}),
      }
      return state
    }
  }

  // the input box: text rows, then the agent · model footer
  const footer = texts.findLastIndex((r) => /^\S.* · \S/.test(r.trim()))
  if (footer < 0) return state
  state.inputVisible = !dialog
  const parts = texts[footer].trim().split(' · ')
  state.mode = parts[0].trim().toLowerCase()
  // a third part is the model's variant, whatever it's called (low, max, a name from the config)
  const variant = parts.length > 2 && /^[\w.-]+$/.test(parts[parts.length - 1].trim()) ? parts.pop()!.trim().toLowerCase() : undefined
  state.model = parts.slice(1).join(' · ').trim() || undefined
  state.effort = variant
  const draft = texts.slice(0, footer).filter((r) => !NOTICE.test(r.trim())).join('\n').replace(/^\n+|\n+$/g, '')
  // the dimmed placeholder isn't typed text
  if (draft.trim() && !/^Ask anything…/.test(draft.trim())) state.draft = draft.trim()
  return state
}

/**
 * Which tab of a question dialog is open: the one drawn on a background of its own (the theme's
 * accent), where the others share the box's. -1 when the row's colours aren't there to read.
 */
export function currentTab(styledRow: string | undefined, labels: string[]): number {
  if (!styledRow) return -1
  let bg = ''
  let text = ''
  const under: string[] = []
  for (let i = 0; i < styledRow.length; i++) {
    const ch = styledRow[i]
    if (ch === '\x1b') {
      const sgr = /^\x1b\[([\d;:]*)m/.exec(styledRow.slice(i))
      if (sgr) {
        const codes = sgr[1] === '' ? [0] : sgr[1].split(/[;:]/).map(Number)
        for (let k = 0; k < codes.length; k++) {
          const c = codes[k]
          if (c === 0 || c === 49) bg = ''
          else if (c === 48) {
            const n = codes[k + 1] === 2 ? 4 : codes[k + 1] === 5 ? 2 : 0
            bg = codes.slice(k, k + n + 1).join(';')
            k += n
          } else if ((c >= 40 && c <= 47) || (c >= 100 && c <= 107)) bg = String(c)
          else if (c === 38 || c === 58) k += codes[k + 1] === 5 ? 2 : codes[k + 1] === 2 ? 4 : 0
        }
        i += sgr[0].length - 1
        continue
      }
      const other = /^\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[\d;?]*[A-Za-z]|.)/.exec(styledRow.slice(i))
      i += (other?.[0].length ?? 1) - 1
      continue
    }
    text += ch
    under.push(bg)
  }
  // the box's own background is the one under its bar
  const bar = text.indexOf('┃')
  const base = under[bar >= 0 ? bar : text.search(/\S/)] ?? ''
  let from = bar + 1
  for (let i = 0; i < labels.length; i++) {
    const at = text.indexOf(labels[i], from)
    if (at < 0) return -1
    if (under[at] !== base) return i
    from = at + labels[i].length
  }
  return -1
}
