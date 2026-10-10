import type { ScreenState, PromptOption } from '@tether/protocol'

// box edges, including the corners of frames nested inside a dialog (the trust question's folder box)
const rule = (line: string) => /^\s*[╭╰└┌]?[─━]{8,}[╮╯┘┐]?\s*$/.test(line)
const clean = (line: string) => line.replace(/^(\s*│)+\s?/, '').replace(/(\s*│)+\s*$/, '').trimEnd()
/** "No (Esc)" -> "No": the key hint means nothing in the app */
const label = (text: string) => text.replace(/\s*\((?:esc|enter|tab|y|n|ctrl\+\w)\)\s*$/i, '')

/** Copilot 1.0 TUI: a framed ❯ composer and live state in the final status row. */
export function parseCopilotScreen(lines: string[], width = 120): ScreenState {
  const state: ScreenState = { working: false, width }
  const tail = lines.slice(-60).map((line) => clean(line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')))
  const footer = tail.findLast((line) => /(?:esc interrupt|\/ commands · \? help|\b(?:Manual Approval|Assisted Approval|Allow All)\b)/i.test(line))
  if (footer) {
    state.working = /esc interrupt/i.test(footer)
    if (state.working) state.activity = footer.trim().split(/\s{3,}/)[0].replace(/^[◎●◉]\s*/, '')
    if (/Manual Approval/.test(footer)) state.mode = 'default'
    else if (/Assisted Approval/.test(footer)) state.mode = 'assisted'
    else if (/Allow All/.test(footer)) state.mode = 'allow-all'
    const model = footer.trim().split(/\s{3,}/).at(-1)
    if (model && model !== footer.trim()) state.model = /^Auto(?:\s|$)/.test(model) ? 'auto' : model.replace(/\s*\([^)]*\)$/, '')
    state.effort = footer.match(/\b(none|minimal|low|medium|high|xhigh|max)\b/i)?.[1]?.toLowerCase()
  }
  const menuFooter = tail.findLastIndex((line) => /(?:enter to select|esc to cancel)/i.test(line) && !/\/ commands/.test(line))
  if (menuFooter >= 0) {
    const menu = tail.slice(0, menuFooter)
    const options: PromptOption[] = []
    for (const line of menu) {
      const numbered = line.match(/^\s*(❯\s*)?(\d+)\.\s+(.+?)\s*$/)
      if (numbered) options.push({ n: +numbered[2], label: label(numbered[3]), selected: !!numbered[1] })
    }
    // Model menus are unnumbered and include a search composer. Only expose selectable rows.
    if (!options.length && /Search models|group: recommended|routing profile/i.test(tail.join('\n'))) {
      for (const line of menu) {
        const match = line.match(/^\s*(❯\s*)?(Auto|(?:gpt|claude|gemini|o\d)[\w. -]*?)(?:\s+✓)?(?:\s{2,}.*)?\s*$/)
        if (match) options.push({ n: options.length + 1, label: match[2].trim(), selected: !!match[1], current: /✓/.test(line) })
      }
    }
    const firstOption = menu.findIndex((line) => /❯\s*(?:\d+\.|Auto)/.test(line))
    state.prompt = { body: menu.slice(Math.max(0, firstOption - 8), firstOption < 0 ? undefined : firstOption).map((s) => s.trim()).filter((s) => s && !rule(s)).slice(-8), options, footer: tail[menuFooter].trim(), multi: false, navigate: true }
    return state
  }
  for (let i = tail.length - 1; i > 0; i--) {
    if (!/^\s*[❯!](?:\s|$)/.test(tail[i]) || !rule(tail[i - 1])) continue
    const end = tail.findIndex((line, n) => n > i && rule(line))
    if (end < 0 || !footer) continue
    state.inputVisible = true
    const shell = /^\s*!/.test(tail[i])
    const draft = [tail[i].replace(/^\s*[❯!]\s?/, ''), ...tail.slice(i + 1, end)].join('\n').trim()
    state.draft = draft ? (shell ? '!' + draft : draft).replace(/^(\/plan) \[prompt\]$/, '$1').replace(/^(\/model auto) \[efficiency\|balance\|intelligence\|<tier>\]$/, '$1') : undefined
    break
  }
  // the block-style composer some Copilot builds draw instead: ╻▄▄▄ / ┃ text / ╹▀▀▀
  if (!state.inputVisible && footer) {
    const bottom = tail.findLastIndex((line) => /^\s*╹▀{8,}/.test(line))
    const top = bottom > 0 ? tail.findLastIndex((line, n) => n < bottom && /^\s*╻▄{8,}/.test(line)) : -1
    if (top >= 0 && tail.slice(top + 1, bottom).every((line) => /^\s*┃/.test(line))) {
      state.inputVisible = true
      const body = tail.slice(top + 1, bottom).map((line) => line.replace(/^\s*┃\s?/, '').replace(/\s*┃\s*$/, ''))
      const shell = /^\s*!/.test(body[0] ?? '')
      const draft = body.join('\n').replace(/^\s*[❯!]\s?/, '').trim()
      state.draft = draft ? (shell ? '!' + draft : draft) : undefined
    }
  }
  return state
}
