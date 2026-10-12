import { AGENT_KINDS, type AgentKind, type PromptOption, type ScreenState } from '@inyon/protocol'
import { parseScreen } from '../claude/screen.ts'
import { shq } from '../hosts/host.ts'
import { HttpError, registry } from '../hosts/registry.ts'
import { LOGIN_PREFIX, sendKeys, typeText } from '../tmux/tmux.ts'
import { PATHS } from './setup.ts'
import { shellReady } from '../claude/actions.ts'

/**
 * Sign-in commands that work without a browser on the machine: a device code (Codex) or a link
 * whose page hands back a code to paste (Claude Code, OpenCode, Gemini CLI).
 */
const SIGN_IN: Record<AgentKind, string> = {
  claude: 'claude auth login',
  codex: 'codex login --device-auth',
  opencode: 'opencode auth login',
  gemini: 'NO_BROWSER=true gemini',
  copilot: 'copilot login --device-code',
  // signs in on first run: a menu, then a link and a prompt for the code the page shows. It runs
  // in an empty folder (so it never asks to trust your home) and is closed once the token lands.
  antigravity: `F="$HOME/.gemini/antigravity-cli/antigravity-oauth-token"; d=$(mktemp -d); cd "$d"; ( while [ ! -s "$F" ]; do sleep 1; done; sleep 2; pkill -P $$ -x agy ) & agy; cd /; rmdir "$d" 2>/dev/null; test -s "$F"`,
}

/**
 * The same on Windows, typed into PowerShell: psmux panes run PowerShell, and there's no sh to
 * hand a script to. Antigravity stays open after signing in there; closing the sign-in ends it.
 */
const SIGN_IN_WINDOWS: Record<AgentKind, string> = {
  ...SIGN_IN,
  gemini: "$env:NO_BROWSER='true'; gemini",
  antigravity: 'agy',
}

const EXIT_MARK = /^\[inyon-exit (\d+)\]$/

export interface SignInScreen {
  lines: string[]
  links: string[]
  /** a device code to type on the sign-in page, e.g. ABCD-12345 */
  code?: string
  input?: { label: string; secret?: boolean }
  /** set once the command has finished */
  exit?: number
  /** a menu on screen (e.g. "Select login method"), to answer with `{ option }` */
  menu?: { question?: string; options: PromptOption[] }
}

/**
 * Runs the agent's sign-in in its own hidden tmux session, so it can be driven from the app. The
 * session ends by itself an hour after the command finishes.
 */
/** sign-ins the app is watching, and when it last looked; one nobody looks at is closed */
const watched = new Map<string, { hostId: string; pane: string; seen: number }>()
const ABANDONED_MS = 3 * 60_000
setInterval(() => {
  for (const [key, w] of watched) {
    if (Date.now() - w.seen < ABANDONED_MS) continue
    watched.delete(key)
    stopSignIn(w.hostId, w.pane).catch(() => {})
  }
}, 60_000).unref?.()
const seen = (hostId: string, pane: string) => watched.set(`${hostId} ${pane}`, { hostId, pane, seen: Date.now() })

export async function startSignIn(hostId: string, kind: AgentKind) {
  if (!AGENT_KINDS.includes(kind)) throw new HttpError(400, 'Unknown agent')
  const host = registry.host(hostId)
  const name = `${LOGIN_PREFIX}${kind}-${Math.random().toString(36).slice(2, 7)}`
  const windows = registry.get(hostId)?.state?.os === 'Windows'
  const script = `${PATHS}; ${SIGN_IN[kind]}; s=$?; echo; echo "[inyon-exit $s]"; exec sleep 3600`
  // wide, so links wrap as little as possible; capture -J re-joins what still wraps
  const r = await host.exec(`tmux new-session -d -s ${shq(name)} -x 220 -y 50 -P -F '#{pane_id}'${windows ? '' : ` ${shq(`sh -c ${shq(script)}`)}`}`)
  const pane = r.stdout.trim()
  if (r.code !== 0 || !/^%\d+(\.\d+)?$/.test(pane)) throw new HttpError(500, r.stderr.trim() || 'Could not start the sign-in')
  if (windows) {
    await shellReady(host, pane)
    await typeText(host, pane, signInWindows(kind), true)
  }
  seen(hostId, pane)
  return { pane }
}

/** The PowerShell line for a sign-in on Windows; it prints the same exit mark as the sh script. */
export const signInWindows = (kind: AgentKind) => `${SIGN_IN_WINDOWS[kind]}; Write-Output ''; Write-Output "[inyon-exit $([int]$LASTEXITCODE)]"`

async function ownPane(hostId: string, pane: string) {
  if (!/^%\d+(\.\d+)?$/.test(pane)) throw new HttpError(400, 'Bad pane')
  const host = registry.host(hostId)
  const r = await host.exec(`tmux display-message -p -t ${shq(pane)} '#{session_name}' 2>/dev/null`)
  const session = r.stdout.trim()
  if (!session.startsWith(LOGIN_PREFIX)) throw new HttpError(404, 'That sign-in has ended')
  // the session is named inyon-login-<agent>-<random>
  const kind = AGENT_KINDS.find((k) => session.startsWith(`${LOGIN_PREFIX}${k}-`))
  return { host, signInKind: kind }
}

/** OpenCode's Clack provider/auth prompts have radio bullets, not numbered choices.
 * Only expose the current visible window; arrow navigation uses its selected row.
 */
export function parseOpenCodeAuthMenu(lines: string[]): ScreenState['prompt'] | undefined {
  const start = lines.findLastIndex((line) => /^\s*[◆◇]\s+/.test(line))
  if (start < 0 || !/^\s*◆/.test(lines[start])) return undefined
  const options: PromptOption[] = []
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s*[│┃]?\s*([●○◯])\s+(.+?)\s*$/)
    if (match) options.push({ n: options.length + 1, label: match[2], selected: match[1] === '●' })
  }
  if (!options.length || !options.some((option) => option.selected)) return undefined
  return { body: [lines[start].replace(/^\s*◆\s*/, '').trim()], options, multi: false, navigate: true }
}

/** The menu on the sign-in's visible screen, read the way chat reads the agent's own menus. */
async function signInMenu(owned: Awaited<ReturnType<typeof ownPane>>, pane: string) {
  const { host, signInKind } = owned
  const r = await host.exec(`tmux display -p -t ${shq(pane)} '#{pane_width}'; tmux capture-pane -p -t ${shq(pane)}`)
  const [width, ...lines] = r.stdout.split('\n')
  if (signInKind === 'opencode') {
    const menu = parseOpenCodeAuthMenu(lines)
    if (menu) return menu
  }
  const p = parseScreen(lines, Number(width) || 0, signInKind ?? 'claude').prompt
  return p && !p.input && p.options.length >= 2 ? p : undefined
}

export async function readSignIn(hostId: string, pane: string): Promise<SignInScreen> {
  const owned = await ownPane(hostId, pane)
  const { host } = owned
  seen(hostId, pane)
  const r = await host.exec(`tmux capture-pane -p -J -S -200 -t ${shq(pane)}`)
  const screen = parseSignIn(r.stdout)
  if (screen.exit !== undefined) registry.refresh(hostId, 0)
  else {
    const p = await signInMenu(owned, pane)
    if (p) {
      const question = p.body.map((l) => l.trim()).filter((l) => l && !/^[╌─]+$/.test(l)).at(-1)
      screen.menu = { question, options: p.options }
    } else if (owned.signInKind === 'opencode') {
      screen.input = parseOpenCodeAuthInput(screen.lines)
    }
  }
  return screen
}

export function parseOpenCodeAuthInput(lines: string[]): SignInScreen['input'] {
  const heading = lines.findLast((line) => /^\s*[◆◇]\s+/.test(line))
  if (!heading || !/^\s*◆/.test(heading)) return undefined
  const label = heading.replace(/^\s*◆\s*/, '').trim()
  if (!/\b(?:enter|paste)\b/i.test(label)) return undefined
  return { label, secret: /\b(?:key|token|password|secret)\b/i.test(label) }
}

/**
 * Full-screen sign-ins (agy) draw a long link across several lines of their own, which `capture -J`
 * can't re-join: a line that ends in a link and fills the width continues on the next unbroken line.
 */
function rejoinLinks(lines: string[]) {
  const width = Math.max(0, ...lines.map((l) => l.length))
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    if (/https?:\/\/\S+$/.test(line) && line.length >= width - 3) {
      while (i + 1 < lines.length && /^\s*[^\s─━]\S*$/.test(lines[i + 1]) && !/^\s*https?:/.test(lines[i + 1])) {
        const next = lines[++i]
        line += next.trim()
        if (next.length < width - 3) break
      }
    }
    out.push(line)
  }
  return out
}

export function parseSignIn(captured: string): SignInScreen {
  const lines = captured.split('\n').map((l) => l.replace(/\s+$/, ''))
  let exit: number | undefined
  const shown = lines.filter((l) => {
    const m = l.trim().match(EXIT_MARK)
    if (m) exit = Number(m[1])
    return !m
  })
  while (shown.length && !shown[shown.length - 1]) shown.pop()
  while (shown.length && !shown[0]) shown.shift()
  const text = rejoinLinks(shown).join('\n')
  const links = [...new Set([...text.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0].replace(/[).,;]+$/, '')))]
  const code = text.replace(/https?:\/\/\S+/g, '').match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0]
  return { lines: shown.slice(-60), links, code, exit }
}

/** Types into the sign-in (a pasted code), or presses keys to move through its menus. */
export async function answerSignIn(hostId: string, pane: string, b: { text?: string; keys?: string[]; option?: number }) {
  const owned = await ownPane(hostId, pane)
  const { host } = owned
  if (typeof b.option === 'number') {
    const p = await signInMenu(owned, pane)
    if (!p?.options.some((o) => o.n === b.option)) throw new HttpError(409, 'That choice is no longer on screen')
    if (p.navigate) {
      const delta = b.option - (p.options.find((o) => o.selected)?.n ?? 1)
      await sendKeys(host, pane, [...Array(Math.abs(delta)).fill(delta > 0 ? 'Down' : 'Up'), 'Enter'])
    } else await sendKeys(host, pane, [String(b.option)])
  } else if (typeof b.text === 'string' && b.text.trim()) await typeText(host, pane, b.text.trim(), true)
  else if (Array.isArray(b.keys) && b.keys.length <= 10) await sendKeys(host, pane, b.keys.map(String))
  else throw new HttpError(400, 'Nothing to send')
}

export async function stopSignIn(hostId: string, pane: string) {
  watched.delete(`${hostId} ${pane}`)
  const owned = await ownPane(hostId, pane)
  const { host } = owned
  await host.exec(`tmux kill-session -t "$(tmux display-message -p -t ${shq(pane)} '#{session_name}')"`)
  registry.refresh(hostId, 0)
}
