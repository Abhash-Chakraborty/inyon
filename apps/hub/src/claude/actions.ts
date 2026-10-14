import { sleep } from '../platform/store.ts'
import { AGENTS, agyModelId, promptKey, type AgentKind, type ScreenPrompt } from '@inyon/protocol'
import { shq, type Host } from '../hosts/host.ts'
import { HttpError, registry } from '../hosts/registry.ts'
import { capturePanes, sendKeys, typeText } from '../tmux/tmux.ts'
import { codexBrowsing, parseScreen } from './screen.ts'
import { watchers } from './watcher.ts'
import { clearInput } from './drafts.ts'
import { keepClaudeDefaults } from './keep-default.ts'
import { startDriving } from './driving.ts'
import { bareTitle, originalTitle, ownsTitle, pendingName, setSessionName } from '../hosts/names.ts'
import { isTaskFile } from '../features/features.ts'
import { PATHS } from '../features/setup.ts'
import { codexModels } from '../agents/codex-models.ts'
import { codexAccepted, inputContains, hasPastePreview } from './delivery.ts'
import { setCopilotControl } from '../agents/copilot-controls.ts'
import { agyModels } from '../agents/antigravity-models.ts'

import { OpenCodeClient } from '../agents/opencode-api.ts'
import { opencodeSelection, setOpenCodeSelection } from '../agents/opencode-controls.ts'
import { modelFromFooter, opencodeCliModels } from '../agents/opencode-models.ts'

function agentPane(hostId: string, paneId: string) {
  const found = registry.findPane(hostId, paneId)
  if (!found) throw new HttpError(404, 'Pane not found')
  return { host: registry.host(hostId), found }
}

async function currentScreen(hostId: string, paneId: string) {
  const caps = await capturePanes(registry.host(hostId), [paneId])
  const pane = registry.findPane(hostId, paneId)?.pane
  return parseScreen(caps.get(paneId) ?? [], pane?.width, pane?.agent?.kind)
}

const nudge = (hostId: string, paneId: string) => {
  const w = watchers.peek(hostId, paneId)
  w?.pollScreen()
  setTimeout(() => w?.pollScreen(), 350)
  registry.refresh(hostId, 250)
}

const squash = (s: string) => s.replace(/\s+/g, '')

/** agents whose input box Inyon can read back off the screen */
const CHECKED = new Set<AgentKind>(['claude', 'codex', 'antigravity', 'copilot', 'opencode'])
const lanes = new Map<string, Promise<unknown>>()

/** One keyboard per pane: actions that type into it take turns instead of failing each other. */
function inLane<T>(hostId: string, paneId: string, fn: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([hostId, paneId])
  const run = (lanes.get(key) ?? Promise.resolve()).then(fn)
  const done = run.catch(() => {})
  lanes.set(key, done)
  done.then(() => lanes.get(key) === done && lanes.delete(key))
  return run
}

/**
 * Sends a message and follows it until the agent has it. `id` names the send for every device
 * (the app passes its own, so a retry is the same send); its state is in the chat info's `sends`.
 * `fromComposer`: the text came out of the app's message box, so the saved draft goes with it.
 * `setting`: a change made with the app's controls, which no device shows as a message.
 */
export async function sendMessage(hostId: string, paneId: string, text: string, fromComposer = false, id = `hub-${crypto.randomUUID()}`, setting = false) {
  const w = watchers.get(hostId, paneId)
  w.trackSend(id, text, setting)
  try {
    await inLane(hostId, paneId, () => sendMessageToPane(hostId, paneId, text, fromComposer))
    await confirmDelivery(hostId, paneId, id, text)
  } catch (err) {
    w.settleSend(id, { state: 'failed', error: (err as Error).message })
    throw err
  } finally {
    w.idleLater()
  }
}

/**
 * Keys accepted on screen don't prove the agent took the message: a dialog can swallow them, or
 * the box can be cleared under us. Agents write every message down at once (queued while they
 * work, or as a new turn), and the ledger matches it, so wait for that. A new conversation's
 * transcript only appears with its first message, so not following yet is part of the wait.
 */
async function confirmDelivery(hostId: string, paneId: string, id: string, text: string) {
  const w = watchers.get(hostId, paneId)
  // a slash command often opens a menu or changes a setting without writing anything down
  if (text.trimStart().startsWith('/')) return w.settleSend(id, { state: 'delivered' })
  w.settleSend(id, { state: 'sent' })
  for (let i = 0; i < 48; i++) {
    const s = w.delivery(id)?.state
    if (s === 'queued' || s === 'delivered') return
    await sleep(250)
  }
  const agent = registry.findPane(hostId, paneId)?.pane.agent
  if (agent?.kind === 'claude' && w.following) {
    throw new HttpError(409, "Claude didn't record the message, so it may not have reached it (a dialog on screen can take the keys). Open the terminal to check before retrying.")
  }
  // typed and accepted on screen, but not in a record we can read yet: the ledger keeps looking
}

/** Claude's preview of a paste, and nothing else: text left in front of it would be sent too. */
const onlyPastePreview = (squashed: string) => /^(\[Pastedtext#\d+(\+\d+lines?)?\])+$/.test(squashed)

/**
 * Clears the input box and waits until it reads empty. Pasting next to leftovers of an older
 * draft would send both, with the start of the message twice.
 */
async function emptyInput(hostId: string, paneId: string, draft: string) {
  for (let round = 0; round < 3; round++) {
    await clearInput(hostId, paneId, draft)
    for (let i = 0; i < 6; i++) {
      await sleep(i < 2 ? 60 : 120)
      const left = (await currentScreen(hostId, paneId)).draft
      if (!left?.trim()) return
      draft = left
    }
  }
  throw new HttpError(409, "Couldn't clear what was already in the agent's input box, so nothing was sent. Open the terminal to check.")
}

/**
 * Types a message into the agent's input box and submits it. For Claude we confirm on screen that
 * the text arrived before pressing Enter (a fast Enter can be swallowed while Claude is still
 * taking in the typing), then confirm the box emptied, retrying Enter if it didn't.
 */
export async function sendMessageToPane(hostId: string, paneId: string, text: string, fromComposer: boolean) {
  const { host, found } = agentPane(hostId, paneId)
  if (!found.pane.agent) throw new HttpError(409, 'No agent is running in this pane')
  if (!text.trim()) throw new HttpError(400, 'Message is empty')
  const startedAt = fromComposer ? Date.now() : 0
  if (hasPastePreview(text) && /^\[Pasted[^\n]+\]$/i.test(text.trim())) throw new HttpError(409, 'This saved message contains only a terminal paste preview. Paste the original text again; the preview does not contain the message.')
  if (found.pane.agent.kind === 'opencode' && !viaApi(found.pane.agent.transcriptPath)) {
    const setting = text.trim().match(/^\/(model|effort|agent)\s+(\S+)$/)
    if (setting?.[1] === 'model') return openCodeModel(hostId, paneId, setting[2])
    if (setting?.[1] === 'effort') return openCodeEffort(hostId, paneId, setting[2])
    if (setting?.[1] === 'agent') return openCodeAgent(hostId, paneId, setting[2])
    const command = text.trim().match(/^\/(\S+)\s*$/)?.[1]
    if (command && OPENCODE_TERMINAL.has(command)) {
      throw new HttpError(400, command === 'models' || command === 'model'
        ? 'Pick the model from the model menu under the message box.'
        : `/${command} opens a menu in OpenCode's terminal. Open the terminal to use it.`)
    }
  }
  if (found.pane.agent.kind === 'opencode' && viaApi(found.pane.agent.transcriptPath)) {
    let uri = found.pane.agent.transcriptPath!
    let client = new OpenCodeClient(host, uri, found.pane.cwd)
    if (!client.session) {
      const created = await client.request('/session', 'POST', {})
      if (!created?.id) throw new HttpError(502, 'OpenCode did not create a session')
      await client.request('/tui/select-session', 'POST', { sessionID: created.id })
      uri += created.id
      client = new OpenCodeClient(host, uri, found.pane.cwd)
      found.pane.agent.transcriptPath = uri
      found.pane.agent.sessionId = created.id
    }
    const setting = text.trim().match(/^\/(model|effort|agent)\s+(\S+)$/)
    if (setting) {
      await setOpenCodeSelection(host, uri, { [setting[1] === 'model' ? 'model' : setting[1] === 'effort' ? 'variant' : 'agent']: setting[2] }, found.pane.cwd)
      return nudge(hostId, paneId)
    }
    const selection = await opencodeSelection(host, uri, found.pane.cwd)
    if (text.trimStart().startsWith('!')) await client.shell(text.trimStart().slice(1).trim(), selection.agent ?? 'build', selection.model)
    else if (text.startsWith('/')) {
      const [, command, args = ''] = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/) ?? []
      if (command === 'compact' && selection.model) {
        const { openCodeModel } = await import('../agents/opencode-api.ts')
        await client.request(`/session/${encodeURIComponent(client.session)}/summarize`, 'POST', openCodeModel(selection.model), 300)
      } else {
        const commands = await client.request('/command')
        if (!Array.isArray(commands) || !commands.some((c: any) => c.name === command)) throw new HttpError(400, 'This OpenCode command is a terminal control. Open the terminal to use it.')
        await client.command(command, args, selection)
      }
    } else await client.prompt(text, selection)
    watchers.peek(hostId, paneId)?.draftSent(text, startedAt)
    return nudge(hostId, paneId)
  }
  await watchers.peek(hostId, paneId)?.beginSend()
  if (found.pane.agent.kind === 'copilot') {
    const model = text.trim().match(/^\/model\s+(\S+)$/)
    const permission = text.trim().match(/^\/permissions\s+(default|allow-all)$/)
    if (model || permission) {
      await setCopilotControl(host, paneId, model ? { model: model[1] } : { permission: permission![1] as 'default' | 'allow-all' })
      return nudge(hostId, paneId)
    }
  }
  // Codex takes no arguments to /model; Inyon's "/model id [effort]" and "/effort level" drive its picker
  if (found.pane.agent.kind === 'codex') {
    const m = text.trim().match(/^\/model\s+(\S+)(?:\s+(\S+))?$/) ?? text.trim().match(/^\/effort\s+()(\S+)$/)
    if (m) return codexModel(hostId, paneId, m[1] || undefined, m[2])
  }
  // Claude Code saves a /model or /effort pick as the default for new sessions; from Inyon it's for this one
  if (found.pane.agent.kind === 'claude' && /^\/(model|effort)(\s|$)/.test(text.trim())) await keepClaudeDefaults(host)
  const screen = await currentScreen(hostId, paneId)
  if (screen.prompt) throw new HttpError(409, 'The agent is waiting for an answer to a question first')
  const isCodex = found.pane.agent.kind === 'codex'
  const isAgy = found.pane.agent.kind === 'antigravity'
  const isOpenCode = found.pane.agent.kind === 'opencode'
  const checkedInput = isCodex || isAgy || isOpenCode || found.pane.agent.kind === 'copilot'
  if (isOpenCode && !screen.inputVisible) throw new HttpError(409, 'OpenCode input is not visible. Open the terminal to check before sending.')
  const setting = isAgy ? text.trim().match(/^\/(model|effort)\s+(\S+)$/) : undefined
  const settingDraft = setting && screen.draft && squash(screen.draft) !== squash(text) ? screen.draft : undefined
  if (isAgy && !screen.inputVisible) throw new HttpError(409, 'Antigravity input is not visible. Open the terminal to check before sending.')
  if (setting) {
    if (screen.working) throw new HttpError(409, 'Change Antigravity settings when it finishes working')
    const catalog = await agyModels(host)
    if (catalog.source === 'cli') {
      const offered = setting[1] === 'model'
        ? catalog.models.some((m) => m.id === setting[2] || Object.values(m.variants ?? {}).includes(setting[2]))
        : catalog.models.find((m) => m.label.toLowerCase() === (screen.model ?? '').toLowerCase())?.efforts?.includes(setting[2])
      if (!offered) throw new HttpError(400, 'That model or effort is not offered by this Antigravity session')
    }
  }
  const releaseDraft = settingDraft ? await watchers.peek(hostId, paneId)?.holdDraft(settingDraft) : undefined
  try {
    if (isCodex && !screen.model) throw new HttpError(409, 'Codex input is not visible. Open the terminal to check before sending.')
    // Claude, Codex and agy show their input box, so the text can be checked into place before Enter
    if (!CHECKED.has(found.pane.agent.kind)) {
      await typeText(host, paneId, text)
      await sleep(300)
      await sendKeys(host, paneId, ['Enter'])
      watchers.peek(hostId, paneId)?.draftSent()
      return nudge(hostId, paneId)
    }
    const full = squash(text)
    // set once this send has emptied the box and typed the message: only then is a paste preview
    // known to be this message rather than a shorter draft the mirror put there earlier
    let typed = false
    const arrived = (d?: string) => {
      if (checkedInput) return inputContains(d, text, typed)
      const now = squash(d ?? '')
      // the whole message, Claude's paste preview of it, or the end of a long one whose start has
      // scrolled out of the box. Never "most of it": a draft mirrored from the app before the last
      // edits is a shorter prefix, and pressing Enter on it sends the old text.
      return inputContains(d, text, typed) || (typed && onlyPastePreview(now)) || (typed && now.length >= 200 && full.endsWith(now))
    }
    // the draft may already be in the box (mirrored from the app); otherwise replace whatever is there
    if (!inputContains(screen.draft, text)) {
      // a second go when the first doesn't show up: a mirrored draft still being typed (or a slow
      // first frame after a hub restart) can leave the box with something else in it
      // (only when the box can be read: typing blind again would double the text)
      let draft = screen.draft
      let readable = screen.inputVisible || !checkedInput
      for (let round = 0; round < 2 && !arrived(draft) && (round === 0 || readable); round++) {
        if (draft) await emptyInput(hostId, paneId, draft)
        await typeText(host, paneId, text)
        typed = true
        for (let i = 0; i < 15; i++) {
          await sleep(i < 3 ? 80 : 150)
          const now = await currentScreen(hostId, paneId)
          draft = now.draft
          readable = !!now.inputVisible
          if (arrived(draft)) break
        }
      }
    }
    if (checkedInput && !arrived((await currentScreen(hostId, paneId)).draft)) {
      throw new HttpError(409, `Could not confirm the message reached ${AGENTS[found.pane.agent.kind].name}. Your message is available to copy or retry.`)
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const beforeSubmit = checkedInput ? await currentScreen(hostId, paneId) : undefined
      if (beforeSubmit && (beforeSubmit.prompt || !(beforeSubmit.model || beforeSubmit.inputVisible) || !arrived(beforeSubmit.draft))) {
        throw new HttpError(409, `${AGENTS[found.pane.agent.kind].name} input changed before sending. Open the terminal to check before retrying.`)
      }
      await sendKeys(host, paneId, [isCodex && beforeSubmit?.working && !text.trimStart().startsWith('!') ? 'Tab' : 'Enter'])
      for (let i = 0; i < 8; i++) {
        await sleep(140)
        const s = await currentScreen(hostId, paneId)
        // a command that opens the agent's own menu (e.g. a bare /model) has arrived once the menu shows
        const slash = text.trimStart().startsWith('/')
        const opensMenu = slash && (!!s.prompt || (s.inputVisible === false && !s.draft) ||
          // OpenCode's /undo puts the undone message back in the box
          (isOpenCode && !!s.inputVisible && squash(s.draft ?? '') !== squash(text)))
        if (opensMenu || (checkedInput ? codexAccepted(s, text) : s.prompt || !arrived(s.draft))) {
          if (!releaseDraft) watchers.peek(hostId, paneId)?.draftSent(text, startedAt)
          if (isOpenCode && text.trimStart().startsWith('/')) await closeOpenCodeMenu(hostId, paneId)
          if (settingDraft && !releaseDraft) {
            await typeText(host, paneId, settingDraft)
            watchers.peek(hostId, paneId)?.draftFromApp(settingDraft)
          }
          return nudge(hostId, paneId)
        }
      }
    }
    nudge(hostId, paneId)
    throw new HttpError(409, `The text is in ${AGENTS[found.pane.agent.kind].name}'s input box but Enter was not accepted. Open the terminal to check.`)
  } finally {
    await releaseDraft?.()
  }
}

/** Answers a dialog that asks for typed input (e.g. the /login code). */
export async function inputAnswer(hostId: string, paneId: string, text: string) {
  const { host } = agentPane(hostId, paneId)
  const s = await currentScreen(hostId, paneId)
  if (!s.prompt?.input) throw new HttpError(409, 'That prompt is no longer on screen')
  await typeText(host, paneId, text)
  await sleep(250)
  await sendKeys(host, paneId, ['Enter'])
  nudge(hostId, paneId)
}

/**
 * Stops a background task (shell, monitor) for real: finds the processes writing to its output
 * file and terminates them with their children. The agent itself is never touched.
 */
export async function stopTask(hostId: string, outputFile: string | undefined, id?: string) {
  const host = registry.host(hostId)
  if (!outputFile && id) outputFile = await findTaskOutput(hostId, id)
  if (!outputFile || !isTaskFile(outputFile, registry.get(hostId)?.probe?.home)) throw new HttpError(404, 'Could not find that task on the machine')
  const script = `
F=${shq(outputFile)}
pids=""
for d in /proc/[0-9]*; do
  for fd in 1 2; do
    [ "$(readlink "$d/fd/$fd" 2>/dev/null)" = "$F" ] && pids="$pids \${d#/proc/}" && break
  done
done
[ -z "$pids" ] && { echo none; exit 0; }
tree() { echo "$1"; for c in $(pgrep -P "$1" 2>/dev/null); do tree "$c"; done; }
all=""; for p in $pids; do all="$all $(tree "$p")"; done
kill -TERM $all 2>/dev/null; sleep 1.5; kill -KILL $all 2>/dev/null
echo "stopped $all"`
  const r = await host.exec(script, { timeoutMs: 15000 })
  const out = r.stdout.trim()
  registry.refresh(hostId, 300)
  return { stopped: out.startsWith('stopped'), detail: out }
}

/**
 * Picks an option in the prompt on screen, optionally typing free text after it. `question` is the
 * promptKey of the question the answer was given for; another question on screen now is refused.
 */
export async function answer(hostId: string, paneId: string, option: number, text?: string, question?: string) {
  const { host, found } = agentPane(hostId, paneId)
  if (await watchers.peek(hostId, paneId)?.answerApi(option)) return nudge(hostId, paneId)
  const screen = await currentScreen(hostId, paneId)
  const p = screen.prompt
  if (!p?.options.some((o) => o.n === option)) throw new HttpError(409, 'That question is no longer on screen')
  if (question && promptKey(p) !== question) throw new HttpError(409, 'That question was answered and another one is waiting. Check it before answering.')
  // a permission or a question in the middle of a turn: answered (other than No), Claude carries on
  const carriesOn = found.pane.agent?.kind === 'claude' && midTurn(p) && !/^no\b/i.test(p.options.find((o) => o.n === option)?.label ?? '')
  if (p.navigate && found.pane.agent?.kind === 'opencode') {
    // "Allow once  Allow always  Reject" in a row, the highlight shown only by colour: go to the
    // first button, then right
    await sendKeys(host, paneId, [...Array(p.options.length).fill('Left'), ...Array(option - 1).fill('Right'), 'Enter'])
    // "Allow always" asks to confirm; picking it here was the confirmation
    if (p.options[option - 1]?.label === 'Allow always') {
      const next = await waitScreen(hostId, paneId, (s) => !!s.prompt?.options.some((o) => o.label === 'Confirm'), 1500)
      if (next.prompt?.options[0]?.label === 'Confirm') await sendKeys(host, paneId, ['Left', 'Left', 'Enter'])
    }
    nudge(hostId, paneId)
    return
  }
  if (p.navigate) {
    // no numbers on screen: move the cursor from the highlighted item to the target, then Enter
    const from = p.options.find((o) => o.selected)?.n ?? 1
    const delta = option - from
    await sendKeys(host, paneId, [...Array(Math.abs(delta)).fill(delta > 0 ? 'Down' : 'Up'), 'Enter'])
    if (carriesOn) registry.turnGoesOn(hostId, paneId)
    nudge(hostId, paneId)
    return
  }
  await sendKeys(host, paneId, [String(option)])
  if (text?.trim()) {
    await sleep(250)
    await typeText(host, paneId, text, true)
  }
  if (carriesOn) registry.turnGoesOn(hostId, paneId)
  nudge(hostId, paneId)
}

/** Claude's tool permissions ("Do you want to proceed?", "Tab to amend") and its questions come mid-turn; menus don't. */
const midTurn = (p: ScreenPrompt) => !!p.tabs?.length || /Tab to amend/i.test(p.footer ?? '') || p.body.some((l) => /^Do you want to /.test(l.trim()))

export async function keys(hostId: string, paneId: string, list: string[]) {
  const { host } = agentPane(hostId, paneId)
  await sendKeys(host, paneId, list)
  // Esc cancels the question and the turn with it
  if (list.includes('Escape')) registry.turnEnded(hostId, paneId)
  nudge(hostId, paneId)
}

/** OpenCode started with --port has an HTTP API; plain `opencode` is driven through its screen */
const viaApi = (uri?: string) => !!uri?.startsWith('opencode://')
/** OpenCode commands that open a terminal menu or program instead of acting */
const OPENCODE_TERMINAL = new Set(['model', 'models', 'agents', 'sessions', 'themes', 'connect', 'mcps', 'skills', 'status', 'export', 'rename', 'move', 'fork', 'diff', 'debug', 'editor', 'help', 'copy', 'exit'])

/** OpenCode's box must be showing (no question, no menu) before its keys are pressed. */
async function openCodeReady(hostId: string, paneId: string) {
  const s = await currentScreen(hostId, paneId)
  if (s.prompt) throw new HttpError(409, 'Answer the open question first')
  if (!s.inputVisible) throw new HttpError(409, 'OpenCode input is not visible. Open the terminal to check.')
  return s
}

async function waitScreen(hostId: string, paneId: string, done: (s: Awaited<ReturnType<typeof currentScreen>>) => boolean, ms = 2000) {
  let s = await currentScreen(hostId, paneId)
  for (let t = 0; !done(s) && t < ms; t += 150) {
    await sleep(150)
    s = await currentScreen(hostId, paneId)
  }
  return s
}

/** Tab steps through OpenCode's agents (Build, Plan, custom ones) until the footer names the target. */
async function openCodeAgent(hostId: string, paneId: string, target: string) {
  const { host } = agentPane(hostId, paneId)
  const want = target.toLowerCase()
  let start: string | undefined
  for (let i = 0; i < 10; i++) {
    const s = await openCodeReady(hostId, paneId)
    if (s.mode === want) return nudge(hostId, paneId)
    // back where it started: every agent has been shown
    if (i === 0) start = s.mode
    else if (s.mode === start) break
    await sendKeys(host, paneId, ['Tab'])
    await waitScreen(hostId, paneId, (n) => n.mode !== s.mode, 1200)
  }
  throw new HttpError(409, `OpenCode has no ${target} agent to switch to`)
}

/** Ctrl+T steps through the model's variants and back to the default. */
async function openCodeEffort(hostId: string, paneId: string, level: string) {
  const { host } = agentPane(hostId, paneId)
  const want = level === 'default' ? undefined : level
  const first = await openCodeReady(hostId, paneId)
  const catalog = await opencodeCliModels(host)
  const model = first.model ? modelFromFooter(catalog.models, first.model) : undefined
  if (model && want && !model.efforts?.includes(want)) throw new HttpError(400, 'This OpenCode model does not have that reasoning level')
  if (model && !model.efforts?.length) throw new HttpError(400, 'This OpenCode model has no reasoning levels')
  for (let i = 0; i < 10; i++) {
    const s = await openCodeReady(hostId, paneId)
    if (s.effort === want) return nudge(hostId, paneId)
    await sendKeys(host, paneId, ['C-t'])
    await waitScreen(hostId, paneId, (n) => n.effort !== s.effort, 1200)
  }
  throw new HttpError(409, 'OpenCode did not switch to that reasoning level')
}

/** Picks a model in OpenCode's "/models" menu by typing its name, keeping whatever was in the box. */
async function openCodeModel(hostId: string, paneId: string, id: string) {
  const { host } = agentPane(hostId, paneId)
  const catalog = await opencodeCliModels(host)
  const model = catalog.models.find((m) => m.id === id)
  if (!model) throw new HttpError(400, 'That model is not offered by OpenCode on this machine')
  const before = await openCodeReady(hostId, paneId)
  if (before.model && modelFromFooter(catalog.models, before.model)?.id === id) return nudge(hostId, paneId)
  const draft = before.draft
  const stopDriving = startDriving(hostId, paneId)
  const release = await watchers.peek(hostId, paneId)?.holdDraft(draft)
  let picked = false
  try {
    if (draft) await clearInput(hostId, paneId, draft)
    await typeText(host, paneId, '/models')
    await waitScreen(hostId, paneId, (s) => s.draft === '/models', 1500)
    await sendKeys(host, paneId, ['Enter'])
    const menu = await waitScreen(hostId, paneId, (s) => s.inputVisible === false, 2500)
    if (menu.inputVisible !== false) throw new HttpError(409, 'OpenCode did not open its model menu. Open the terminal to check.')
    await typeText(host, paneId, model.label.split(' · ').pop()!)
    await sleep(350)
    await sendKeys(host, paneId, ['Enter'])
    // the footer shows the new model at once, even under the "Select variant" menu that the first
    // pick of a model with variants opens (closed below with Esc, which keeps the default)
    const on = (s: Awaited<ReturnType<typeof currentScreen>>) => !!s.model && modelFromFooter(catalog.models, s.model)?.id === id
    const after = await waitScreen(hostId, paneId, on, 3000)
    picked = on(after) && after.inputVisible !== false
  } finally {
    // the driving flag must end even if the screen can't be read, or prompts stay hidden
    try {
      const now = await currentScreen(hostId, paneId)
      if (now.inputVisible === false && !now.prompt) {
        await sendKeys(host, paneId, ['Escape'])
        const closed = await waitScreen(hostId, paneId, (s) => s.inputVisible !== false, 1500)
        picked ||= closed.inputVisible !== false && !!closed.model && modelFromFooter(catalog.models, closed.model)?.id === id
      }
    } catch {}
    stopDriving()
    if (release) await release()
    else if (draft) await typeText(host, paneId, draft).catch(() => {})
  }
  if (!picked) throw new HttpError(409, 'OpenCode did not switch to that model. Open the terminal to check.')
  nudge(hostId, paneId)
}

/** A custom command that turned out to open a menu: close it rather than leave the app stuck. */
async function closeOpenCodeMenu(hostId: string, paneId: string) {
  const s = await waitScreen(hostId, paneId, (n) => n.inputVisible === false, 600)
  if (s.inputVisible !== false || s.prompt) return
  await sendKeys(agentPane(hostId, paneId).host, paneId, ['Escape'])
  throw new HttpError(409, "That command opens a menu in OpenCode's terminal. Open the terminal to use it.")
}

const MODE_ALIASES: Record<string, RegExp> = {
  default: /^(manual|default|normal)?$/,
  acceptEdits: /accept/,
  plan: /plan/,
  auto: /^auto/,
  bypassPermissions: /bypass/,
}

/** Cycles the permission mode (Shift+Tab) until the target shows on screen (Claude Code, Antigravity). */
export async function setMode(hostId: string, paneId: string, target: string) {
  return inLane(hostId, paneId, () => setPaneMode(hostId, paneId, target))
}

async function setPaneMode(hostId: string, paneId: string, target: string) {
  const { host, found } = agentPane(hostId, paneId)
  const kind = found.pane.agent?.kind
  if (!kind || !AGENTS[kind].modes.some((m) => m.id === target)) throw new HttpError(400, 'That permission mode is not supported by this agent')
  if (kind === 'opencode') {
    const uri = found.pane.agent?.transcriptPath
    if (!viaApi(uri)) return openCodeAgent(hostId, paneId, target)
    await setOpenCodeSelection(host, uri!, { agent: target }, found.pane.cwd)
    return nudge(hostId, paneId)
  }
  if (kind === 'codex') return codexMode(hostId, paneId, target)
  if (kind === 'copilot') {
    await watchers.peek(hostId, paneId)?.beginSend()
    await setCopilotControl(host, paneId, { permission: target as 'default' | 'allow-all' })
    return nudge(hostId, paneId)
  }
  if (kind !== 'claude' && kind !== 'antigravity') throw new HttpError(400, 'Mode switching is only supported for Claude Code, Codex and Antigravity')
  const want = MODE_ALIASES[target]
  if (!want) throw new HttpError(400, 'Unknown mode')
  for (let i = 0; i < 7; i++) {
    const s = await currentScreen(hostId, paneId)
    if (s.prompt) throw new HttpError(409, 'Answer the open question first')
    if (s.working) throw new HttpError(409, 'Change permission mode when the agent finishes working')
    if (kind === 'antigravity' && !s.inputVisible) throw new HttpError(409, 'Antigravity input is not visible. Open the terminal to check.')
    if ((s.mode !== undefined && want.test(s.mode.trim())) || (kind === 'claude' && s.mode === undefined && target === 'default')) return nudge(hostId, paneId)
    await sendKeys(host, paneId, ['BTab'])
    await sleep(260)
  }
  throw new HttpError(409, 'That mode is not available in this session')
}

// ---------- Codex settings, through its own pickers ----------

const CODEX_PERMISSIONS: Record<string, string> = {
  default: 'Ask for approval',
  'auto-review': 'Approve for me',
  'full-access': 'Full Access',
  'read-only': 'Read Only',
}
const CODEX_EFFORTS: Record<string, string> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }
const bare = (label: string) => label.replace(/\s*\((default|current)\)/gi, '').trim().toLowerCase()

/** Waits for a Codex menu whose body matches `title`; undefined if the composer came back instead. */
async function codexMenu(hostId: string, paneId: string, title: RegExp) {
  for (let i = 0; i < 30; i++) {
    await sleep(150)
    const s = await currentScreen(hostId, paneId)
    if (s.prompt?.body.some((l) => title.test(l))) return s.prompt
    if (i > 12 && !s.prompt && s.model) return undefined
  }
  return undefined
}

/** Moves the highlight from where it is to option `n`, then presses `key`. */
async function codexChoose(hostId: string, paneId: string, p: { options: { n: number; selected: boolean }[] }, n: number, key: string) {
  const { host } = agentPane(hostId, paneId)
  const from = p.options.find((o) => o.selected)?.n ?? 1
  const d = n - from
  await sendKeys(host, paneId, [...Array(Math.abs(d)).fill(d > 0 ? 'Down' : 'Up')])
  await sleep(120)
  await sendKeys(host, paneId, [key])
}

/** The screen once Codex's composer is back (a menu takes a moment to close; Max effort plays a banner), or as it is after `ms`. */
async function codexComposer(hostId: string, paneId: string, ms = 4000) {
  let s = await currentScreen(hostId, paneId)
  for (let t = 0; !s.model && !s.prompt && t < ms; t += 150) {
    await sleep(150)
    s = await currentScreen(hostId, paneId)
  }
  return s
}

/** Types a slash command into an idle, empty Codex composer. */
async function codexCommand(hostId: string, paneId: string, cmd: string) {
  const { host } = agentPane(hostId, paneId)
  const s = await codexComposer(hostId, paneId)
  if (s.prompt) throw new HttpError(409, 'Answer the open question first')
  // no composer on screen means some menu is open; typing into it could pick something
  if (!s.model) throw new HttpError(409, 'Codex is showing a menu; close it in the terminal first')
  if (s.working) throw new HttpError(409, 'Codex is working; change this when it finishes')
  if (s.draft) await clearInput(hostId, paneId, s.draft)
  await typeText(host, paneId, cmd)
  // an Enter that lands while Codex is still taking in the typing gets lost
  for (let i = 0; i < 10 && (await currentScreen(hostId, paneId)).draft?.trim() !== cmd; i++) await sleep(100)
  await sleep(400)
  await sendKeys(host, paneId, ['Enter'])
}

/** Runs a slash command that opens a Codex menu, trying once more if the menu doesn't show. */
async function codexOpen(hostId: string, paneId: string, cmd: string, title: RegExp) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await codexCommand(hostId, paneId, cmd)
    const menu = await codexMenu(hostId, paneId, title)
    if (menu) return menu
  }
  throw new HttpError(409, `Codex did not open ${cmd}`)
}

/**
 * Switches model and/or effort with /model, for this session only ("s" in the effort step; Enter
 * would make it the default for every session). Max and Ultra sit under "More reasoning…".
 */
export async function codexModel(hostId: string, paneId: string, model?: string, effort?: string) {
  return keepingDraft(hostId, paneId, () => pickCodexModel(hostId, paneId, model, effort))
}

/**
 * Runs a settings change that has to use Codex's input box, keeping whatever was typed there: the
 * draft is set aside and typed back once the composer returns, whether the change worked or not.
 */
async function keepingDraft<T>(hostId: string, paneId: string, fn: () => Promise<T>): Promise<T> {
  const stopDriving = startDriving(hostId, paneId)
  try {
    return await keepingDraftInner(hostId, paneId, fn)
  } finally {
    stopDriving()
  }
}

async function keepingDraftInner<T>(hostId: string, paneId: string, fn: () => Promise<T>): Promise<T> {
  const before = await codexComposer(hostId, paneId, 0)
  const release = await watchers.peek(hostId, paneId)?.holdDraft(before.draft)
  const draft = before.draft
  try {
    return await fn()
  } finally {
    const after = await codexComposer(hostId, paneId)
    if (release) await release()
    // no watcher (nobody has the chat open): put it back ourselves
    else if (draft && !after.draft && after.model) await typeText(agentPane(hostId, paneId).host, paneId, draft).catch(() => {})
  }
}

async function pickCodexModel(hostId: string, paneId: string, model?: string, effort?: string) {
  const { host } = agentPane(hostId, paneId)
  const before = await currentScreen(hostId, paneId)
  const models = await codexOpen(hostId, paneId, '/model', /^Select Model/)
  const known = model ? (await codexModels(host)).models.find((m) => m.id === model) : undefined
  const label = model ? (known?.label ?? AGENTS.codex.models.find((m) => m.id === model)?.label ?? model) : undefined
  const pick = label ? models.options.find((o) => bare(o.label) === label.toLowerCase() || bare(o.label) === model!.toLowerCase()) : models.options.find((o) => o.current)
  if (!pick) {
    await sendKeys(host, paneId, ['Escape'])
    throw new HttpError(400, `Codex doesn't offer ${label ?? 'that model'} here`)
  }
  await codexChoose(hostId, paneId, models, pick.n, 'Enter')
  const levels = await codexMenu(hostId, paneId, /^Select Reasoning Level/)
  // a model with one level skips this step
  if (!levels) return nudge(hostId, paneId)
  // keep the level you had when only the model changes; fall back to the model's default
  const want = (effort ?? before.effort ?? '').toLowerCase()
  const name = CODEX_EFFORTS[want]?.toLowerCase()
  let opt = levels.options.find((o) => bare(o.label) === name)
  if (!opt && name && /^(max|ultra)$/.test(want)) {
    const more = levels.options.find((o) => /^More reasoning/i.test(o.label))
    if (more) {
      await codexChoose(hostId, paneId, levels, more.n, 'Enter')
      const adv = await codexMenu(hostId, paneId, /^Advanced Reasoning/)
      const o = adv?.options.find((x) => bare(x.label) === name)
      if (adv && o) {
        await codexChoose(hostId, paneId, adv, o.n, 's')
        await codexComposer(hostId, paneId)
        return nudge(hostId, paneId)
      }
      await sendKeys(host, paneId, ['Escape', 'Escape', 'Escape'])
      throw new HttpError(400, `${label ?? 'This model'} has no ${CODEX_EFFORTS[want]} effort`)
    }
  }
  opt ??= effort ? undefined : (levels.options.find((o) => /\(default\)/i.test(o.label)) ?? levels.options.find((o) => o.current))
  if (!opt) {
    await sendKeys(host, paneId, ['Escape', 'Escape'])
    throw new HttpError(400, `${label ?? 'This model'} has no ${CODEX_EFFORTS[want] ?? want} effort`)
  }
  await codexChoose(hostId, paneId, levels, opt.n, 's')
  await codexComposer(hostId, paneId)
  nudge(hostId, paneId)
}

/**
 * Rewinds Codex to one of your earlier messages (Esc Esc, then ← until that message is the one
 * highlighted, then Enter): the later turns are dropped and the message comes back into the box to
 * edit. With no text, it picks your last message.
 */
export async function codexRewind(hostId: string, paneId: string, text?: string) {
  const { host, found } = agentPane(hostId, paneId)
  if (found.pane.agent?.kind !== 'codex') throw new HttpError(400, 'Only for Codex')
  const s = await codexComposer(hostId, paneId)
  if (s.prompt || !s.model) throw new HttpError(409, 'Codex is showing a menu; close it in the terminal first')
  if (s.working) throw new HttpError(409, 'Codex is working; stop it or wait, then rewind')
  if (s.draft) await clearInput(hostId, paneId, s.draft)
  const browse = async () => codexBrowsing((await capturePanes(host, [paneId])).get(paneId) ?? [])
  await sendKeys(host, paneId, ['Escape'])
  await sleep(200)
  await sendKeys(host, paneId, ['Escape'])
  let b: { selected?: string; screen?: string } | undefined
  for (let i = 0; i < 10 && !(b = await browse())?.selected; i++) await sleep(150)
  if (!b?.selected) {
    if (b) await sendKeys(host, paneId, ['Escape'])
    throw new HttpError(409, 'Codex has no earlier message to go back to')
  }
  const want = text ? squash(text.split('\n')[0]).slice(0, 60) : undefined
  const matches = (sel: string) => !want || squash(sel).startsWith(want) || want.startsWith(squash(sel))
  for (let i = 0; i < 80; i++) {
    const sel: string = b!.selected!
    if (matches(sel)) {
      await sendKeys(host, paneId, ['Enter'])
      return nudge(hostId, paneId)
    }
    // ←/→ step between your messages (↑/↓ only scroll)
    await sendKeys(host, paneId, ['Left'])
    await sleep(150)
    const before = b!.screen
    b = await browse()
    // nothing moved: the oldest message, so it isn't there (two messages can read the same, so
    // compare the whole screen, not just the highlighted text)
    if (b?.screen === before) {
      await sleep(200)
      b = await browse()
    }
    if (!b?.selected || b.screen === before) break
  }
  await sendKeys(host, paneId, ['Escape'])
  throw new HttpError(404, "Couldn't find that message in Codex's history")
}

/** Plan mode is Shift+Tab; the permission presets are /permissions. */
async function codexMode(hostId: string, paneId: string, target: string) {
  return keepingDraft(hostId, paneId, () => pickCodexMode(hostId, paneId, target))
}

async function pickCodexMode(hostId: string, paneId: string, target: string) {
  const { host } = agentPane(hostId, paneId)
  const s = await currentScreen(hostId, paneId)
  if (s.prompt) throw new HttpError(409, 'Answer the open question first')
  const inPlan = s.mode === 'plan'
  if (s.working) throw new HttpError(409, 'Change permission mode when Codex finishes working')
  if (!s.model) throw new HttpError(409, 'Codex input is not visible. Open the terminal to check.')
  if (target === 'plan') {
    if (!inPlan) await sendKeys(host, paneId, ['BTab'])
    return nudge(hostId, paneId)
  }
  const label = CODEX_PERMISSIONS[target]
  if (!label) throw new HttpError(400, 'Unknown mode')
  if (inPlan) {
    await sendKeys(host, paneId, ['BTab'])
    await sleep(250)
  }
  const menu = await codexOpen(hostId, paneId, '/permissions', /Permissions$/)
  const opt = menu.options.find((o) => bare(o.label) === label.toLowerCase())
  if (!opt) {
    await sendKeys(host, paneId, ['Escape'])
    throw new HttpError(400, `Codex doesn't offer "${label}" here`)
  }
  if (!opt.current) await codexChoose(hostId, paneId, menu, opt.n, 'Enter')
  else await sendKeys(host, paneId, ['Escape'])
  await codexComposer(hostId, paneId)
  registry.forgetStatus(hostId)
  nudge(hostId, paneId)
}

/**
 * The agent's command as the pane's shell will find it: the plain name when it is on that shell's
 * PATH, otherwise the full path the hub found (e.g. installed under another nvm Node version).
 */
async function launchBin(host: ReturnType<typeof registry.host>, agent: AgentKind) {
  const bin = AGENTS[agent].launch.split(' ')[0]
  const r = await host.exec(
    `b=${shq(bin)}; if "\${SHELL:-/bin/sh}" -lic 'command -v "$0"' "$b" </dev/null >/dev/null 2>&1; then echo "$b"; else ${PATHS}; command -v "$b" || echo "$b"; fi`,
    { timeoutMs: 10_000 },
  )
  const found = r.stdout.trim().split('\n').pop() || bin
  return found === bin || !found.startsWith('/') ? bin : /^[\w./-]+$/.test(found) ? found : shq(found)
}
/** `cmd` with its first word (the agent's command) replaced by `bin`. */
const withBin = (cmd: string, bin: string) => cmd.replace(/^\S+/, bin)

/**
 * No session (start fresh), or a conversation id, nothing a shell would read as more: a UUID, or
 * for OpenCode its own "ses_…" form.
 */
export const isSessionId = (id: unknown, agent?: AgentKind): id is string | null | undefined =>
  id === undefined || id === null || id === '' ||
  (typeof id === 'string' && (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || (agent === 'opencode' && /^ses_[A-Za-z0-9]{1,64}$/.test(id))))

/** Starts (or resumes) an agent in a pane that is sitting at a shell prompt. */
export async function startAgent(hostId: string, paneId: string, agent: AgentKind = 'claude', resume?: unknown) {
  // both end up typed into a shell
  if (typeof agent !== 'string' || !Object.hasOwn(AGENTS, agent)) throw new HttpError(400, 'Unknown agent')
  if (!isSessionId(resume, agent)) throw new HttpError(400, 'Bad session id')
  const { found } = agentPane(hostId, paneId)
  if (found.pane.agent) throw new HttpError(409, 'An agent is already running here')
  await typeStart(hostId, paneId, agent, resume)
}

/**
 * Types the command that starts the agent (resuming `resume`, if given) at the pane's shell
 * prompt. The caller has checked the agent and the id, and that the pane is at its shell.
 */
export async function typeStart(hostId: string, paneId: string, agent: AgentKind, resume?: string | null) {
  const { host } = agentPane(hostId, paneId)
  const def = AGENTS[agent]
  const cmd = !resume ? def.launch
    : agent === 'codex' ? `codex resume ${resume}`
    : agent === 'antigravity' ? `agy --conversation ${resume}`
    : agent === 'opencode' ? `${def.launch} --session ${resume}`
    : `${def.launch} --resume ${resume}`
  await typeText(host, paneId, withBin(cmd, await launchBin(host, agent)), true)
  registry.refresh(hostId, 1500)
}

/** Reconnects a Claude session's live numbers without restarting it (see reconnectStatusLine). */
export async function reconnectAgent(hostId: string, paneId: string) {
  const { host, found } = agentPane(hostId, paneId)
  if (found.pane.agent?.kind !== 'claude') throw new HttpError(400, 'Only Claude Code sessions report live numbers')
  const cwd = registry.agentProc(hostId, paneId)?.cwd ?? found.pane.cwd
  if (!cwd) throw new HttpError(409, 'Unknown working folder')
  const { reconnectStatusLine } = await import('./integration.ts')
  await reconnectStatusLine(host, cwd)
  registry.refresh(hostId, 3000)
}

/**
 * Stops the current turn. Esc only while the spinner is up (a stray double Esc on an idle Claude
 * opens the rewind menu), then waits for the spinner to go and tries once more if it hasn't.
 */
export async function interrupt(hostId: string, paneId: string) {
  const { host, found } = agentPane(hostId, paneId)
  if (found.pane.agent?.kind === 'opencode' && viaApi(found.pane.agent.transcriptPath)) {
    await new OpenCodeClient(host, found.pane.agent.transcriptPath!, found.pane.cwd).abort()
    return nudge(hostId, paneId)
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await currentScreen(hostId, paneId)
    if (!s.working) break
    // OpenCode stops on the second Esc ("esc again to interrupt")
    await sendKeys(host, paneId, found.pane.agent?.kind === 'opencode' ? ['Escape', 'Escape'] : ['Escape'])
    for (let i = 0; i < 8; i++) {
      await sleep(250)
      if (!(await currentScreen(hostId, paneId)).working) {
        nudge(hostId, paneId)
        registry.refresh(hostId, 100)
        return
      }
    }
  }
  nudge(hostId, paneId)
  registry.refresh(hostId, 100)
}

/** Flags that take a value, per agent; everything else positional (an initial prompt) is dropped. */
const VALUE_FLAGS: Record<string, Set<string>> = {
  claude: new Set(['--model', '--permission-mode', '--add-dir', '--mcp-config', '--settings', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--fallback-model', '--agent', '--effort', '--plugin-dir']),
  codex: new Set(['-m', '--model', '-c', '--config', '-p', '--profile', '-a', '--ask-for-approval', '-s', '--sandbox', '-C', '--cd']),
  antigravity: new Set(['--model', '--effort', '--mode', '--add-dir', '--agent', '--project', '--log-file']),
}
const DROP: Record<string, Set<string>> = {
  claude: new Set(['--resume', '-r', '--continue', '-c', '--session-id', '--fork-session', '-p', '--print']),
  codex: new Set([]),
  antigravity: new Set(['--conversation', '--continue', '-c', '-p', '--print', '--prompt', '-i', '--prompt-interactive', '--new-project', '--print-timeout', '--output-format', '--input-format', '--json-schema']),
}

/**
 * The command that reopens this conversation with the flags the agent was started with. `args` is
 * the real argument list where the machine can give it; `ps` text loses where a value with spaces
 * in it ends, so that's split on spaces as a last resort.
 */
export function resumeCommand(kind: AgentKind, sessionId: string | undefined, args: string | string[]): string {
  const tokens = Array.isArray(args) ? args : args.trim().split(/\s+/)
  // skip the interpreter and binary ("node /…/codex.js", "/…/claude")
  const name = kind === 'antigravity' ? 'agy' : kind
  const bin = tokens.findIndex((t) => new RegExp(`(^|/)${name}(\\.js)?$`).test(t))
  const rest = tokens.slice(bin + 1)
  if (kind === 'codex' && rest[0] === 'resume') rest.splice(0, /^[0-9a-f-]{36}$/.test(rest[1] ?? '') ? 2 : 1)
  const keep: string[] = []
  const takes = VALUE_FLAGS[kind] ?? new Set()
  const drop = DROP[kind] ?? new Set()
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    const [flag] = t.split('=')
    if (!t.startsWith('-')) continue
    const hasValue = takes.has(flag) && !t.includes('=') && rest[i + 1] && !rest[i + 1].startsWith('-')
    const dropValue = drop.has(flag) && !t.includes('=') && rest[i + 1] && !rest[i + 1].startsWith('-') && flag !== '--fork-session'
    if (drop.has(flag)) {
      if (dropValue) i++
      continue
    }
    keep.push(shq(t))
    if (hasValue) keep.push(shq(rest[++i]))
  }
  const base = AGENTS[kind].launch
  // no conversation yet (nothing was said): start fresh with the same flags
  if (!sessionId) return [base, ...keep].join(' ')
  if (kind === 'codex') return [base, 'resume', sessionId, ...keep].join(' ')
  if (kind === 'antigravity') return [base, '--conversation', sessionId, ...keep].join(' ')
  return [base, '--resume', sessionId, ...keep].join(' ')
}

/** A process's arguments as it was given them (Linux), or undefined where there's no /proc. */
export async function argv(host: Host, pid: number) {
  const r = await host.exec(`tr '\\0' '\\n' < /proc/${Math.trunc(pid)}/cmdline 2>/dev/null`).catch(() => undefined)
  const args = r?.code === 0 ? r.stdout.replace(/\n$/, '').split('\n') : []
  return args.length && args[0] ? args : undefined
}

/**
 * Exits the agent and reopens the same conversation in the same pane, e.g. so it picks up
 * settings that changed under it. Refuses while it's busy, since a restart would cut that off.
 */
export async function restartAgent(hostId: string, paneId: string) {
  const { host, found } = agentPane(hostId, paneId)
  const a = found.pane.agent
  if (!a || (a.kind !== 'claude' && a.kind !== 'codex' && a.kind !== 'antigravity')) throw new HttpError(400, 'Only Claude Code, Codex and Antigravity sessions can be resumed')
  if (!a.sessionId || !/^[0-9a-f-]{36}$/.test(a.sessionId)) throw new HttpError(409, 'No conversation to resume yet')
  const proc = registry.agentProc(hostId, paneId)
  if (!proc) throw new HttpError(409, 'The agent process is gone')
  const s = await currentScreen(hostId, paneId)
  if (s.working) throw new HttpError(409, 'It is working; stop it or wait, then restart')
  if (s.prompt) throw new HttpError(409, 'Answer the open question first')
  if (s.background) throw new HttpError(409, `Restarting would stop ${s.background} running in the background`)
  const saved = a.transcriptPath && (await host.exec(`test -s ${shq(a.transcriptPath)} && echo yes`)).stdout.includes('yes')
  const cmd = resumeCommand(a.kind, saved ? a.sessionId : undefined, (await argv(host, proc.pid)) ?? proc.args)
  const p = shq(paneId)
  // started as the pane's own command: keep the pane open across the exit, then respawn it
  const direct = proc.pid === proc.panePid
  const win = onPsmux(hostId)
  if (direct) await host.exec(remainOnExit(win, p, true))
  // the "/exit" typed below is Inyon's, not a draft to keep
  const w = watchers.peek(hostId, paneId)
  await w?.beginSend()
  try {
    await sendKeys(host, paneId, ['C-u'])
    await typeText(host, paneId, EXIT_COMMAND[a.kind] ?? '/exit', true)
    let gone = false
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(250)
      gone = !(await host.exec(`kill -0 ${proc.pid} 2>/dev/null && echo alive`)).stdout.includes('alive')
    }
    if (!gone) throw new HttpError(504, 'It did not exit; restart it from the terminal')
    if (direct) {
      const cwd = proc.cwd ? `-c ${shq(proc.cwd)}` : ''
      await paneDead(host, p)
      await host.exec(`tmux respawn-pane ${win ? '-k ' : ''}-t ${p} ${cwd} ${shq(cmd)}`)
    } else {
      await sleep(400)
      await typeText(host, paneId, withBin(cmd, await launchBin(host, a.kind)), true)
    }
  } finally {
    w?.draftSent()
    if (direct) await host.exec(remainOnExit(win, p, false))
  }
  registry.refresh(hostId, 1500)
}

/**
 * psmux (tmux on Windows) keeps remain-on-exit on the window rather than the pane, and its panes
 * run PowerShell, not $SHELL.
 */
const onPsmux = (hostId: string) => registry.get(hostId)?.state?.os === 'Windows'
export const remainOnExit = (win: boolean, p: string, on: boolean) => `tmux set-option ${win ? '-w' : '-p'} -t ${p} ${on ? 'remain-on-exit on' : '-u remain-on-exit'}`
/** The command that gives a pane its shell back once the agent it ran has exited. */
export const respawnShell = (win: boolean, p: string, cwd?: string) =>
  win
    ? `tmux respawn-pane -k -t ${p} ${cwd ? `-c ${shq(cwd)}` : ''} "$(command -v pwsh.exe >/dev/null 2>&1 && echo pwsh.exe || echo powershell.exe)"`
    : `tmux respawn-pane -t ${p} ${cwd ? `-c ${shq(cwd)}` : ''} "\${SHELL:-/bin/sh}" -l`

/** tmux marks a pane dead a moment after its process is gone, and refuses to respawn it before that. */
async function paneDead(host: { exec: (cmd: string) => Promise<{ stdout: string }> }, p: string) {
  for (let i = 0; i < 20; i++) {
    // display answers even for a pane that's gone, with nothing: that's as done as dead
    const [id, dead] = (await host.exec(`tmux display -p -t ${p} '#{pane_id} #{pane_dead}' 2>/dev/null`)).stdout.trim().split(' ')
    if (!id || dead === '1') return
    await sleep(100)
  }
}

/** Each agent's own way out. */
const EXIT_COMMAND: Partial<Record<AgentKind, string>> = { claude: '/exit', codex: '/exit', gemini: '/quit', opencode: '/exit', antigravity: '/exit', copilot: '/exit' }

/**
 * Quits the agent and leaves the pane at its shell (or closes it, if the agent was the pane's own
 * command). Stops a running turn first and backs out of any dialog, then asks the agent to exit;
 * Ctrl+C is the fallback when that doesn't work.
 */
export async function exitAgent(hostId: string, paneId: string, o: { end?: boolean } = {}) {
  const { host, found } = agentPane(hostId, paneId)
  const a = found.pane.agent
  if (!a) throw new HttpError(409, 'No agent is running in this pane')
  const p = shq(paneId)
  // ending the session closes the pane after the agent, and anything still running in it
  const close = async () => {
    await host.exec(`tmux kill-pane -t ${p} 2>/dev/null; true`)
    registry.refresh(hostId, 300)
  }
  const proc = registry.agentProc(hostId, paneId)
  // an agent that was its pane's own command takes the pane with it, and kill -0 can still answer
  // for its pid a while after (a process not yet reaped), so a pane that's gone counts as gone too.
  // tmux display exits 0 for a pane that no longer exists and prints nothing, so the id it prints
  // is what says the pane is there
  const alive = async () =>
    (await host.exec(`[ "$(tmux display -p -t ${p} '#{pane_id}' 2>/dev/null)" = ${p} ]${proc ? ` && kill -0 ${proc.pid} 2>/dev/null` : ''} && echo alive`)).stdout.includes('alive')
  const waitGone = async (ms: number) => {
    for (let t = 0; t < ms; t += 250) {
      await sleep(250)
      if (!(await alive())) return true
    }
    return false
  }
  const s = await currentScreen(hostId, paneId)
  if (s.background && !o.end) throw new HttpError(409, `Exiting would stop ${s.background} running in the background`)
  if (s.working) await interrupt(hostId, paneId)
  // a dialog (permission, folder trust): back out of it before typing the command
  if (s.prompt && !s.prompt.api) {
    await sendKeys(host, paneId, ['Escape'])
    await sleep(300)
  }
  // started as the pane's own command (`tmux new agy`): keep the pane, and give it a shell after
  const direct = !!proc && proc.pid === proc.panePid && !o.end
  const win = onPsmux(hostId)
  if (direct) await host.exec(remainOnExit(win, p, true))
  // the "/exit" and Ctrl+C below are Inyon's, not a draft to keep
  const w = watchers.peek(hostId, paneId)
  await w?.beginSend()
  const done = async () => {
    w?.draftSent()
    if (o.end) return close()
    if (direct) {
      await paneDead(host, p)
      // with no command tmux would rerun the agent; ask for the login shell instead
      await host.exec(`${respawnShell(win, p, proc.cwd)}; ${remainOnExit(win, p, false)}`)
    }
    registry.refresh(hostId, 300)
  }
  // an agent that leaves the moment it is asked takes its pane with it, and the keystroke being
  // checked on screen then finds no pane: that is the exit, not a failure
  const left = async (err: unknown) => /can't find pane|no such pane/i.test(String((err as Error)?.message ?? err)) && !(await alive())
  const cmd = EXIT_COMMAND[a.kind]
  if (cmd && !(await currentScreen(hostId, paneId)).prompt) {
    try {
      await sendKeys(host, paneId, ['C-u'])
      await typeText(host, paneId, cmd, true)
    } catch (err) {
      if (!(await left(err))) throw err
      return done()
    }
    if (await waitGone(5000)) return done()
  }
  for (let i = 0; i < 2; i++) {
    try {
      await sendKeys(host, paneId, ['C-c'])
      await sleep(300)
      await sendKeys(host, paneId, ['C-c'])
    } catch (err) {
      if (!(await left(err))) throw err
      return done()
    }
    if (await waitGone(2500)) return done()
  }
  w?.draftSent()
  // it wouldn't go: closing its pane ends it anyway
  if (o.end) return close()
  if (direct) await host.exec(remainOnExit(win, p, false))
  registry.refresh(hostId, 300)
  throw new HttpError(504, `${AGENTS[a.kind].name} did not exit; close it from the terminal`)
}

/** What closing a pane takes with it: tmux closes a window with its last pane, a session with its last window. */
export function closes(found: { session: { windows: unknown[] }; window: { panes: unknown[] } }): 'pane' | 'window' | 'session' {
  if (found.window.panes.length > 1) return 'pane'
  return found.session.windows.length > 1 ? 'window' : 'session'
}

/**
 * Ends a session for good. The agent exits the way /exit would (a running turn is stopped first,
 * a dialog backed out of), then its tmux pane is killed. Only that pane: its window goes too only
 * when it was the last pane there, and the tmux session only when that was its last window.
 */
export async function endSession(hostId: string, paneId: string) {
  const { host, found } = agentPane(hostId, paneId)
  const closed = closes(found)
  if (found.pane.agent) await exitAgent(hostId, paneId, { end: true })
  else {
    await host.exec(`tmux kill-pane -t ${shq(paneId)} 2>/dev/null; true`)
    registry.refresh(hostId, 300)
  }
  return { closed }
}

export interface LaunchOpts {
  session?: string
  name?: string
  cwd?: string
  agent?: AgentKind | 'shell'
  model?: string
  mode?: string
  prompt?: string
}

/** New tmux window (in an existing or new session) at `cwd`, optionally starting an agent. */
/** zsh's first-run questions in a home with no ~/.zshrc; "q" leaves it for next time and changes nothing */
export const ZSH_NEWUSER = /zsh-newuser-install|Type one of the keys in parentheses/

/**
 * Waits for a new pane's shell to show its prompt before typing a command into it: a slow
 * startup (oh-my-zsh, nvm) or a question the shell asks first would otherwise take the keys.
 */
export async function shellReady(host: ReturnType<typeof registry.host>, paneId: string, ms = 8000) {
  const end = Date.now() + ms
  let last = ''
  let stableSince = Date.now()
  let skipped = false
  await sleep(150)
  while (Date.now() < end) {
    const lines = (await capturePanes(host, [paneId]).catch(() => new Map<string, string[]>())).get(paneId) ?? []
    const text = lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
    // the question stays on screen after it's answered, so press q once and wait for the prompt below it
    if (!skipped && ZSH_NEWUSER.test(text)) {
      skipped = true
      await sendKeys(host, paneId, ['q'])
      await sleep(300)
      continue
    }
    const tail = text.trimEnd().split('\n').at(-1) ?? ''
    // a prompt ends in one of these, usually with a space after it
    if (/[$%#>❯➜»]\s*$/.test(tail)) return
    if (text !== last) {
      last = text
      stableSince = Date.now()
    } else if (text.trim() && Date.now() - stableSince > 800) return
    await sleep(150)
  }
}

export async function launch(hostId: string, opts: LaunchOpts) {
  const host = registry.host(hostId)
  const agent = opts.agent && opts.agent !== 'shell' ? opts.agent : undefined
  // before anything is created: an unknown agent would fail after the window exists
  if (agent && (typeof agent !== 'string' || !Object.hasOwn(AGENTS, agent))) throw new HttpError(400, 'Unknown agent')
  const cwd = opts.cwd?.trim() || '~'
  const dir = cwd === '~' || cwd.startsWith('~/') ? `"$HOME"${shq(cwd.slice(1))}` : shq(cwd)
  const fmt = shq('#{pane_id}')
  let cmd: string
  if (opts.session) {
    cmd = `tmux new-window -t ${shq(opts.session)} -c ${dir} -P -F ${fmt}`
  } else {
    const name = (opts.name?.trim() || agent || 'shell').replace(/[.:]/g, '-')
    // a second "claude" becomes "claude-2" rather than failing on the taken name
    cmd = `n=${shq(name)}; i=2; while tmux has-session -t "=$n" 2>/dev/null; do n=${shq(name)}-$i; i=$((i+1)); done; tmux new-session -d -s "$n" -c ${dir} -P -F ${fmt}`
  }
  const r = await host.exec(`[ -d ${dir} ] || { echo "No such folder: ${cwd.replace(/["$`\\]/g, '')}" >&2; exit 3; }; ${cmd}`)
  const paneId = r.stdout.trim()
  if (r.code !== 0 || !paneId.startsWith('%')) throw new HttpError(400, r.stderr.trim() || 'Could not create window')
  if (agent) {
    const parts = [AGENTS[agent].launch]
    // OpenCode names models "provider/model"
    if (opts.model && (agent === 'opencode' ? /^[\w.:-]+\/[\w.:/-]+$/ : /^[\w.:-]+$/).test(opts.model)) parts.push(agent === 'codex' ? `-m ${opts.model}` : agent === 'antigravity' ? `--model ${agyModelId(opts.model)}` : `--model ${opts.model}`)
    if (agent === 'claude' && opts.mode && /^\w+$/.test(opts.mode)) parts.push(`--permission-mode ${opts.mode}`)
    if (agent === 'antigravity' && (opts.mode === 'acceptEdits' || opts.mode === 'plan')) parts.push(`--mode ${opts.mode === 'plan' ? 'plan' : 'accept-edits'}`)
    // files you attach land in ~/.inyon/uploads; without this agy asks before reading each one
    if (agent === 'antigravity') {
      await host.exec('mkdir -p "$HOME/.inyon/uploads"')
      parts.push('--add-dir "$HOME/.inyon/uploads"')
    }
    // the first message: Claude and Codex take it as an argument; OpenCode's argument is a folder
    // (--prompt instead), and agy and Copilot use -i (runs it and stays interactive)
    if (opts.prompt?.trim()) {
      const text = shq(opts.prompt.trim())
      parts.push(agent === 'antigravity' || agent === 'copilot' || agent === 'gemini' ? `-i ${text}` : agent === 'opencode' ? `--prompt ${text}` : text)
    }
    parts[0] = withBin(parts[0], await launchBin(host, agent))
    await shellReady(host, paneId)
    await typeText(host, paneId, parts.join(' '), true)
  }
  registry.refresh(hostId, agent ? 1500 : 100)
  return paneId
}

/**
 * Opens a copy of the conversation in a new tmux window next to this one, in the same folder and
 * with the same flags: both carry on from here separately. Claude Code, Codex and OpenCode fork
 * a conversation themselves; this only starts them that way.
 */
export async function forkConversation(hostId: string, paneId: string) {
  const { host, found } = agentPane(hostId, paneId)
  const a = found.pane.agent
  if (!a || (a.kind !== 'claude' && a.kind !== 'codex' && a.kind !== 'opencode')) throw new HttpError(400, 'Only Claude Code, Codex and OpenCode conversations can be forked')
  if (!a.sessionId || !isSessionId(a.sessionId, a.kind)) throw new HttpError(409, 'No conversation to fork yet')
  if (a.kind !== 'opencode' && !(a.transcriptPath && (await host.exec(`test -s ${shq(a.transcriptPath)} && echo yes`)).stdout.includes('yes'))) {
    throw new HttpError(409, 'Say something first; there is nothing to fork yet')
  }
  const proc = registry.agentProc(hostId, paneId)
  const cwd = proc?.cwd ?? found.pane.cwd
  const args = proc ? ((await argv(host, proc.pid)) ?? proc.args) : AGENTS[a.kind].launch
  const cmd = a.kind === 'claude' ? `${resumeCommand('claude', a.sessionId, args)} --fork-session`
    : a.kind === 'codex' ? resumeCommand('codex', a.sessionId, args).replace(/^(\S+) resume /, '$1 fork ')
    : `${AGENTS.opencode.launch} --session ${a.sessionId} --fork`
  const r = await host.exec(`tmux new-window -t ${shq(found.session.name)} -c ${shq(cwd)} -P -F ${shq('#{pane_id}')}`)
  const newPane = r.stdout.trim()
  if (r.code !== 0 || !newPane.startsWith('%')) throw new HttpError(500, r.stderr.trim() || 'Could not open a window')
  await shellReady(host, newPane)
  await typeText(host, newPane, withBin(cmd, await launchBin(host, a.kind)), true)
  registry.refresh(hostId, 1500)
  return newPane
}

/** Turns Remote Control on, or off (opens the /remote-control menu and picks Disconnect). */
export async function remoteControl(hostId: string, paneId: string, on: boolean) {
  const { found } = agentPane(hostId, paneId)
  const kind = found.pane.agent?.kind
  if (kind === 'antigravity') return void (await sendMessage(hostId, paneId, on ? '/remote-control' : '/remote-control off'))
  if (kind !== 'claude') throw new HttpError(400, 'Remote Control works with Claude Code and Antigravity')
  await sendMessage(hostId, paneId, '/remote-control')
  for (let i = 0; i < 12; i++) {
    await sleep(300)
    const s = await currentScreen(hostId, paneId)
    const opt = s.prompt?.options.find((o) => (on ? /^continue/i : /disconnect/i).test(o.label))
    if (s.prompt && opt) {
      if (on) await keys(hostId, paneId, ['Escape']) // already on: just close the menu
      else await answer(hostId, paneId, opt.n)
      return
    }
    if (!s.prompt && i > 3) return // turning on shows no menu
  }
}

/** Claude writes background task output to /tmp/claude-<uid>/<project>/<session>/tasks/<id>.output. */
export async function findTaskOutput(hostId: string, id: string): Promise<string | undefined> {
  if (!/^[\w-]{4,40}$/.test(id)) throw new HttpError(400, 'Bad task id')
  const r = await registry.host(hostId).exec(`find /tmp -maxdepth 6 -path ${shq(`*/tasks/${id}.output`)} 2>/dev/null | head -1`)
  return r.stdout.trim() || undefined
}

/**
 * Names a session. Claude, Codex and agy keep the name themselves (/rename), so it shows the same
 * everywhere: in this hub, the phone app and their own resume pickers. While the agent is busy the
 * name waits and goes in as soon as it's idle. Other agents keep the name in Inyon against their
 * conversation; plain terminals get their tmux window renamed. An empty name goes back to the
 * automatic one.
 */
export async function renamePane(hostId: string, paneId: string, raw: string) {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, 80)
  const { host, found } = agentPane(hostId, paneId)
  const a = found.pane.agent
  if (!a) {
    const r = await host.exec(name ? `tmux rename-window -t ${shq(paneId)} ${shq(name)}` : `tmux set-window-option -t ${shq(paneId)} automatic-rename on`)
    if (r.code !== 0) throw new HttpError(500, r.stderr.trim() || 'Could not rename the window')
    return registry.refresh(hostId, 0)
  }
  if (!a.sessionId) throw new HttpError(409, 'Send a first message, then name the session')
  // the title the agent made up, so the automatic name can put it back
  const made = ownsTitle(a.kind) ? bareTitle(watchers.peek(hostId, paneId)?.info.title ?? found.pane.title) || undefined : undefined
  setSessionName(hostId, a.sessionId, name, originalTitle(hostId, a.sessionId) ?? made, a.kind)
  renameTried.delete(`${hostId}:${paneId}`)
  await applyPendingName(hostId, paneId)
  registry.refresh(hostId, 0)
}

const renameTried = new Map<string, number>()

/**
 * Types /rename for a name the agent hasn't taken yet, once it's idle with nothing open on screen.
 * Called after a rename and again by the registry while one waits; tried at most every 20 s.
 */
export async function applyPendingName(hostId: string, paneId: string) {
  const found = registry.findPane(hostId, paneId)
  const a = found?.pane.agent
  const want = pendingName(hostId, a?.sessionId)
  if (!found || !a || !want || !ownsTitle(a.kind) || a.state !== 'idle') return
  const key = `${hostId}:${paneId}`
  if (Date.now() - (renameTried.get(key) ?? 0) < 20_000) return
  renameTried.set(key, Date.now())
  const s = await currentScreen(hostId, paneId)
  // leave a half-typed message alone (Codex's is set aside and put back); try again later
  if (s.prompt || s.working || (s.draft && a.kind !== 'codex')) return
  const host = registry.host(hostId)
  if (a.kind === 'codex') await keepingDraft(hostId, paneId, () => codexCommand(hostId, paneId, `/rename ${want.name}`))
  else await typeText(host, paneId, `/rename ${want.name}`, true)
}

registry.on((e) => {
  if (e.type === 'rename-due') applyPendingName(e.host, e.pane).catch(() => {})
})
