import type { PromptOption, ScreenState } from '@inyon/protocol'

/** a row of OpenCode's input box (or the permission/question panel that replaces it): the bar sits at column 2 */
const BOX = /^\s{0,3}┃/
const EFFORTS = /^(none|minimal|low|medium|high|xhigh|max)$/i

/**
 * OpenCode 1.18 TUI. The input box is a column of "┃" rows ending in a footer row
 * ("Build · Big Pickle OpenCode Zen · medium") above a "╹▀▀▀" edge, with a status line under it
 * ("■⬝⬝ esc interrupt … 16.6K (8%)  ctrl+p commands"). A permission request or a question from
 * the agent takes the box's place. Wide windows add a sidebar on the right, which is cut off.
 */
export function parseOpenCodeScreen(lines: string[], width = 120): ScreenState {
  const state: ScreenState = { working: false, width }
  const all = lines.map((l) => l.replace(/\s+$/, ''))
  while (all.length && !all[all.length - 1]) all.pop()
  const w = width || Math.max(0, ...all.map((l) => l.length))
  // the sidebar starts ~40 columns from the right edge, after a wide gap
  const cut = (l: string) => {
    const gap = /\s{4,}(?=\S)/g
    for (let m; (m = gap.exec(l)); ) {
      const at = m.index + m[0].length
      if (w >= 100 && at >= w - 46) return l.slice(0, m.index)
    }
    return l
  }

  // the box ends in a "╹▀▀▀" edge; on the home screen (no conversation yet) it's centred, so its
  // column is read off that edge rather than assumed
  const edge = all.findLastIndex((l) => /╹▀▀/.test(l))
  const col = edge >= 0 ? all[edge].indexOf('╹') : -1
  const status = (edge >= 0 ? all.slice(edge + 1) : all.slice(-3)).find((l) => /esc interrupt|esc again to interrupt|ctrl\+p\b/.test(l))
  if (status && /esc (again to )?interrupt/.test(status)) {
    state.working = true
    const text = status.replace(/^[\s⬝■]+/, '').split(/\s{2,}/)[0]
    state.activity = /retrying/i.test(status) ? `Retrying${text.match(/retrying in \d+s/i) ? ` (${text.match(/retrying in \d+s/i)![0].replace(/^retrying /i, '')})` : ''}` : 'Working'
  }

  const inBox = (l: string) => (col > 3 ? l[col] === '┃' && !l.slice(0, col).trim() : BOX.test(l))
  const end = col > 3 ? edge - 1 : all.findLastIndex((l) => BOX.test(l))
  if (end < 0 || !inBox(all[end])) return state
  let start = end
  while (start > 0 && inBox(all[start - 1]) && end - start < 40) start--
  const rows = all
    .slice(start, end + 1)
    // the slash-command popup is drawn inside its own ┃…┃ frame right above the box (filtered
    // before the sidebar cut, which would take its right edge)
    .filter((l) => !/┃.*\S.*┃\s*$/.test(l))
    .map((l) => (col > 3 ? l.slice(col) : cut(l)))
    .map((l) => l.replace(/^\s{0,3}┃ {0,2}/, '').replace(/\s+$/, ''))

  // a menu opened from the TUI (models, agents, sessions) sits over everything with "esc" in its title row
  // (transcript text can show to its left, and the sidebar to its right)
  const dialog = all.slice(0, start).some((l) => /\S {3,}esc(?: {2,}|$)/.test(l))
  // on the home screen the menu can cover the footer too
  if (dialog) state.inputVisible = false

  // "Allow always" asks once more ("Always allow … until OpenCode is restarted", Confirm / Cancel)
  const permission = rows.findIndex((r) => /Permission required|△ Always allow\s*$/.test(r))
  if (permission >= 0) {
    const always = /Always allow\s*$/.test(rows[permission])
    const optionRow = rows.findIndex((r, i) => i > permission && (always ? /Confirm\s{2,}Cancel/ : /Allow once/).test(r))
    const labels = (optionRow >= 0 ? rows[optionRow] : always ? 'Confirm   Cancel' : 'Allow once   Allow always   Reject')
      .split(/\s{2,}/)
      .map((s) => s.trim())
      .filter((s) => s && !/fullscreen|select|confirm|ctrl\+/.test(s))
    const body = rows
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

  const submit = rows.findIndex((r) => /enter submit/.test(r))
  const firstOption = rows.findIndex((r) => /^\d+\.\s+\S/.test(r))
  if (submit >= 0 && firstOption >= 0) {
    const options: PromptOption[] = []
    for (const r of rows.slice(firstOption, submit)) {
      const m = r.match(/^(\d+)\.\s+(.+)$/)
      if (m) options.push({ n: +m[1], label: m[2].trim(), selected: options.length === 0 })
      else if (r.trim() && options.length) {
        const last = options[options.length - 1]
        last.detail = [last.detail, r.trim()].filter(Boolean).join(' ')
      }
    }
    const free = options.find((o) => /^Type your own answer$/i.test(o.label))
    state.prompt = {
      body: rows.slice(0, firstOption).map((r) => r.trim()).filter(Boolean),
      options,
      multi: false,
      freeTextOption: free?.n,
    }
    return state
  }

  // the input box: text rows, then the agent · model footer
  const footerAt = rows.findLastIndex((r) => /^\S.* · \S/.test(r.trim()))
  if (footerAt < 0) return state
  state.inputVisible = !dialog
  const parts = rows[footerAt].trim().split(' · ')
  state.mode = parts[0].trim().toLowerCase()
  const variant = parts.length > 2 && EFFORTS.test(parts[parts.length - 1].trim()) ? parts.pop()!.trim().toLowerCase() : undefined
  state.model = parts.slice(1).join(' · ').trim() || undefined
  state.effort = variant
  const draft = rows.slice(0, footerAt).join('\n').replace(/^\n+|\n+$/g, '')
  // the dimmed placeholder isn't typed text
  if (draft.trim() && !/^Ask anything…/.test(draft.trim())) state.draft = draft.trim()
  return state
}
