import { Host, shq } from '../hosts/host.ts'
import { HttpError } from '../hosts/registry.ts'
import { ACCOUNT_SH, MARKER, PANE_SH } from './integration-sh.ts'

/**
 * The hook only appends Claude Code's own hook payload, tagged with the tmux pane, to a local
 * log. It prints nothing and always exits 0, so it never changes what Claude does.
 */
export const HOOK_SCRIPT = `#!/bin/sh
# Inyon: records Claude Code events so Inyon knows which tmux pane runs which session.
# Safe to delete; remove the matching entries from ~/.claude/settings.json too.
# ${MARKER}
# the events hold your prompts: readable by you only
umask 077
d="$HOME/.inyon"
mkdir -p "$d/panes" 2>/dev/null
p=$(tr -d '\\n\\r')
[ -n "$p" ] || exit 0
${PANE_SH}
line=$(printf '{"pane":"%s","ts":%s,"data":%s}' "$pane" "$(date +%s)" "$p")
printf '%s\\n' "$line" >> "$d/events.jsonl"
[ -n "$pane" ] && printf '%s\\n' "$line" > "$d/panes/\${pane#%}.json"
# after a compaction, so Inyon stops showing the context size from before it
case "$p" in
  *'"hook_event_name":"SessionStart"'*'"source":"compact"'*|*'"source":"compact"'*'"hook_event_name":"SessionStart"'*)
    [ -n "$pane" ] && date +%s > "$d/panes/\${pane#%}.compact" ;;
esac
s=$(wc -c < "$d/events.jsonl" 2>/dev/null || echo 0)
[ "$s" -gt 2097152 ] && mv -f "$d/events.jsonl" "$d/events.old.jsonl"
exit 0
`

/**
 * Claude Code hands its status line command a JSON payload with the model, context window, cost
 * and rate limits. The wrapper saves it per tmux pane, then runs the user's own status line.
 */
export const STATUS_SCRIPT = `#!/bin/sh
# Inyon: saves Claude Code's status line data per tmux pane, then runs your own status line.
# ${MARKER}
in=$(cat)
${PANE_SH}
# (in a subshell, so your own status line below keeps your umask)
if [ -n "$pane" ]; then (
  umask 077
  d="$HOME/.inyon/status"; f="$d/\${pane#%}"
  mkdir -p "$d" 2>/dev/null
  printf '%s' "$in" | tr -d '\\n\\r' > "$f.json.$$" && mv -f "$f.json.$$" "$f.json"
  # the signed-in account, so limits reported for a previous account are never shown as this one's
  cfg="\${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
  printf '%s %s\\n' "$(${ACCOUNT_SH} "$cfg")" "$cfg" > "$f.acct"
)
fi
orig="$HOME/.inyon/statusline.orig"
# never this wrapper a second time: a saved command that leads back here would start itself forever
[ -s "$orig" ] && [ -z "\${INYON_STATUSLINE:-}" ] && printf '%s' "$in" | INYON_STATUSLINE=1 sh "$orig"
exit 0
`

/**
 * Antigravity CLI (agy) runs its status line command with a similar payload: model and effort,
 * context window, the Gemini and third-party quotas, and whether it is working. Saved per pane in
 * its own folder, then your own agy status line runs.
 */
export const AGY_STATUS_SCRIPT = `#!/bin/sh
# Inyon: saves Antigravity CLI's status line data per tmux pane, then runs your own status line.
# Safe to delete; remove "statusLine" from ~/.gemini/antigravity-cli/settings.json too.
# ${MARKER}
in=$(cat)
${PANE_SH}
if [ -n "$pane" ]; then (
  umask 077
  d="$HOME/.inyon/agy-status"; f="$d/\${pane#%}"
  mkdir -p "$d" 2>/dev/null
  printf '%s' "$in" | tr -d '\\n\\r' > "$f.json.$$" && mv -f "$f.json.$$" "$f.json"
)
fi
orig="$HOME/.inyon/agy-statusline.orig"
[ -s "$orig" ] && [ -z "\${INYON_STATUSLINE:-}" ] && printf '%s' "$in" | INYON_STATUSLINE=1 sh "$orig"
exit 0
`

const HOOK_CMD = '~/.inyon/hook.sh'
const STATUS_CMD = '~/.inyon/statusline.sh'
// entries written before the rename to Inyon name ~/.tether: still ours, so they're replaced, not doubled
const ours = (c: unknown, file: string) => typeof c === 'string' && (c.includes(`.inyon/${file}`) || c.includes(`.tether/${file}`))
const isOurStatus = (c: unknown) => ours(c, 'statusline.sh')
const EVENTS: { name: string; matcher?: string }[] = [
  { name: 'SessionStart' },
  { name: 'SessionEnd' },
  { name: 'UserPromptSubmit' },
  { name: 'Notification' },
  { name: 'PermissionRequest', matcher: '*' },
  { name: 'Stop' },
]

/**
 * A turn that ended on an error (a rate limit, signed out, overloaded). Only for Claude Code 2.1.78
 * and later, which have it: before 2.1.101 a hook event Claude Code doesn't know makes it ignore
 * the whole settings file.
 */
const STOP_FAILURE: { name: string; matcher?: string } = { name: 'StopFailure' }

/** Whether `claude --version` (e.g. "2.1.309 (Claude Code)") names a version with StopFailure. */
export function knowsStopFailure(version: string): boolean {
  const m = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!m) return false
  const [a, b, c] = [m[1], m[2], m[3]].map(Number)
  return a !== 2 ? a > 2 : b !== 1 ? b > 1 : c >= 78
}

const isOurs = (h: any) => ours(h?.command, 'hook.sh')

async function readSettings(host: Host): Promise<any> {
  const r = await host.exec('cat "$HOME/.claude/settings.json" 2>/dev/null')
  if (!r.stdout.trim()) return {}
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new HttpError(409, '~/.claude/settings.json on that machine is not valid JSON; fix it first')
  }
}

async function writeSettings(host: Host, settings: any) {
  // private to you (settings.json often holds API keys), and no half-written copy left if the connection drops
  const cmd = [
    `umask 077; trap 'rm -f "$HOME/.claude/settings.json.inyon-tmp"' EXIT HUP INT TERM`,
    'mkdir -p "$HOME/.claude"',
    '[ -f "$HOME/.claude/settings.json" ] && [ ! -f "$HOME/.claude/settings.json.tether-backup" ] && [ ! -f "$HOME/.claude/settings.json.inyon-backup" ] && cp "$HOME/.claude/settings.json" "$HOME/.claude/settings.json.inyon-backup"',
    'cat > "$HOME/.claude/settings.json.inyon-tmp" && mv "$HOME/.claude/settings.json.inyon-tmp" "$HOME/.claude/settings.json"',
  ].join('; ')
  const r = await host.exec(cmd, { input: JSON.stringify(settings, null, 2) + '\n' })
  if (r.code !== 0) throw new HttpError(500, r.stderr.trim() || 'Could not write settings')
}

async function writeFile(host: Host, path: string, content: string, mode = '600') {
  const r = await host.exec(`umask 077; mkdir -p "$HOME/.inyon" && cat > "$HOME/${path}" && chmod ${mode} "$HOME/${path}"`, { input: content })
  if (r.code !== 0) throw new HttpError(500, r.stderr.trim() || `Could not write ~/${path}`)
}

/** The status line command in the settings backup made when Inyon was first installed, if it can run here. */
async function statusBeforeInyon(host: Host): Promise<string> {
  for (const f of ['settings.json.inyon-backup', 'settings.json.tether-backup']) {
    const r = await host.exec(`cat "$HOME/.claude/${f}" 2>/dev/null`)
    if (!r.stdout.trim()) continue
    try {
      const sl = JSON.parse(r.stdout).statusLine
      const cmd = sl?.type === 'command' && typeof sl.command === 'string' ? sl.command.trim() : ''
      return cmd && !isOurStatus(cmd) && !windowsPath(cmd) ? cmd : ''
    } catch {}
  }
  return ''
}

const windowsPath = (cmd: string) => /(^|[\s"'])[A-Za-z]:[\\/]/.test(cmd)

export async function installIntegration(host: Host) {
  await writeFile(host, '.inyon/hook.sh', HOOK_SCRIPT, '700')
  await writeFile(host, '.inyon/statusline.sh', STATUS_SCRIPT, '700')
  // ~/.inyon holds your prompts (events.jsonl, panes/): earlier versions left it readable by others
  await host.exec('umask 077; mkdir -p "$HOME/.inyon/panes" "$HOME/.inyon/status" && chmod 700 "$HOME/.inyon" && chmod 600 "$HOME/.inyon/events.jsonl" "$HOME/.inyon/events.old.jsonl" 2>/dev/null; true')
  const settings = await readSettings(host)
  const sl = settings.statusLine
  if (!isOurStatus(sl?.command)) {
    const cmd = sl?.type === 'command' && typeof sl.command === 'string' ? sl.command : ''
    const prev = (await host.exec('cat "$HOME/.inyon/statusline.orig" 2>/dev/null')).stdout.trim()
    // Settings synced from a Windows machine bring a status line that can't run here. Keep the one that does.
    if (!(windowsPath(cmd) && prev && !windowsPath(prev))) await writeFile(host, '.inyon/statusline.orig', cmd ? `${cmd}\n` : '')
    settings.statusLine = { ...(sl ?? { padding: 0 }), type: 'command', command: STATUS_CMD }
  } else {
    if (sl.command !== STATUS_CMD) settings.statusLine = { ...sl, command: STATUS_CMD }
    // a saved "own" status line that is this wrapper again would start itself forever: use the one
    // from before Inyon was installed instead, if there was one
    const prev = (await host.exec('cat "$HOME/.inyon/statusline.orig" 2>/dev/null')).stdout.trim()
    if (isOurStatus(prev)) {
      const before = await statusBeforeInyon(host)
      await writeFile(host, '.inyon/statusline.orig', before ? `${before}\n` : '')
    }
  }
  const version = (await host.exec('claude --version 2>/dev/null')).stdout
  settings.hooks ??= {}
  for (const ev of knowsStopFailure(version) ? [...EVENTS, STOP_FAILURE] : EVENTS) {
    const groups: any[] = (settings.hooks[ev.name] ??= [])
    // an entry naming the old folder points at the new one
    for (const g of groups) for (const h of g.hooks ?? []) if (isOurs(h)) h.command = HOOK_CMD
    if (groups.some((g) => (g.hooks ?? []).some(isOurs))) continue
    groups.push({ ...(ev.matcher ? { matcher: ev.matcher } : {}), hooks: [{ type: 'command', command: HOOK_CMD }] })
  }
  // a Claude Code older than StopFailure (one downgraded since, say) ignores a settings file that has it
  if (!knowsStopFailure(version)) dropOurs(settings.hooks, STOP_FAILURE.name)
  await writeSettings(host, settings)
  await installAgyIntegration(host)
}

/** Takes Inyon's hook out of one event's groups, leaving yours; a group left empty goes, and so does the event when nothing is left. */
function dropOurs(hooks: Record<string, any[]>, name: string) {
  const groups = hooks[name]
  if (!Array.isArray(groups)) return
  const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h)) })).filter((g) => g.hooks.length)
  if (kept.length) hooks[name] = kept
  else delete hooks[name]
}

const AGY_SETTINGS = '$HOME/.gemini/antigravity-cli/settings.json'
const AGY_STATUS_CMD = '~/.inyon/agy-statusline.sh'
const isOurAgyStatus = (c: unknown) => ours(c, 'agy-statusline.sh')

/** agy's settings, or undefined when agy isn't on the machine (nothing to install into). */
async function readAgySettings(host: Host): Promise<any | undefined> {
  const r = await host.exec(`if command -v agy >/dev/null 2>&1 || [ -d "$HOME/.gemini/antigravity-cli" ]; then echo @@; cat "${AGY_SETTINGS}" 2>/dev/null; fi`)
  if (!r.stdout.startsWith('@@')) return undefined
  const text = r.stdout.slice(2).trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(409, '~/.gemini/antigravity-cli/settings.json on that machine is not valid JSON; fix it first')
  }
}

async function writeAgySettings(host: Host, settings: any) {
  const f = AGY_SETTINGS
  const cmd = [
    `umask 077; trap 'rm -f "${f}.inyon-tmp"' EXIT HUP INT TERM`,
    'mkdir -p "$HOME/.gemini/antigravity-cli"',
    `[ -f "${f}" ] && [ ! -f "${f}.tether-backup" ] && [ ! -f "${f}.inyon-backup" ] && cp "${f}" "${f}.inyon-backup"`,
    `cat > "${f}.inyon-tmp" && mv "${f}.inyon-tmp" "${f}"`,
  ].join('; ')
  const r = await host.exec(cmd, { input: JSON.stringify(settings, null, 2) + '\n' })
  if (r.code !== 0) throw new HttpError(500, r.stderr.trim() || 'Could not write agy settings')
}

/** Adds the status line wrapper to agy's settings. Sessions already running pick it up when restarted. */
export async function installAgyIntegration(host: Host) {
  const settings = await readAgySettings(host)
  if (!settings) return false
  await writeFile(host, '.inyon/agy-statusline.sh', AGY_STATUS_SCRIPT, '700')
  const sl = settings.statusLine
  if (!isOurAgyStatus(sl?.command)) {
    const cmd = sl?.type === 'command' && typeof sl.command === 'string' ? sl.command : ''
    await writeFile(host, '.inyon/agy-statusline.orig', cmd ? `${cmd}\n` : '')
    // with no status line of your own, agy keeps drawing its default one (the wrapper prints nothing)
    settings.statusLine = cmd ? { ...sl, type: 'command', command: AGY_STATUS_CMD } : { type: 'command', command: AGY_STATUS_CMD, stack_with_default: true }
    await writeAgySettings(host, settings)
  } else {
    if (sl.command !== AGY_STATUS_CMD) await writeAgySettings(host, { ...settings, statusLine: { ...sl, command: AGY_STATUS_CMD } })
    const prev = (await host.exec('cat "$HOME/.inyon/agy-statusline.orig" 2>/dev/null')).stdout.trim()
    if (isOurAgyStatus(prev)) await writeFile(host, '.inyon/agy-statusline.orig', '')
  }
  return true
}

export async function uninstallAgyIntegration(host: Host) {
  const settings = await readAgySettings(host)
  if (settings && isOurAgyStatus(settings.statusLine?.command)) {
    const orig = (await host.exec('cat "$HOME/.inyon/agy-statusline.orig" 2>/dev/null')).stdout.trim()
    if (orig && !isOurAgyStatus(orig)) settings.statusLine = { ...settings.statusLine, command: orig }
    else delete settings.statusLine
    await writeAgySettings(host, settings)
  }
  await host.exec('rm -rf "$HOME/.inyon/agy-statusline.sh" "$HOME/.inyon/agy-statusline.orig" "$HOME/.inyon/agy-status"')
}

/** Project settings files Inyon added its status line to (see reconnectStatusLine). */
const PROJECT_LIST = '.inyon/project-statuslines'

/**
 * Gets a running Claude session reporting again without restarting it. A session whose user
 * settings were swapped under it stops reloading them, but it still watches its project's
 * .claude/settings.local.json; putting the status line there makes it pick it up within seconds.
 * The file stays out of git (via .git/info/exclude) and is listed so turning the integration
 * off removes it again.
 */
export async function reconnectStatusLine(host: Host, cwd: string) {
  const dir = `${cwd.replace(/\/+$/, '')}/.claude`
  const file = `${dir}/settings.local.json`
  const cur = (await host.exec(`cat ${shq(file)} 2>/dev/null`)).stdout
  let settings: any = {}
  if (cur.trim()) {
    try {
      settings = JSON.parse(cur)
    } catch {
      throw new HttpError(409, `${file} is not valid JSON`)
    }
  }
  if (settings.statusLine && !isOurStatus(settings.statusLine.command)) throw new HttpError(409, 'This project has its own status line')
  if (!isOurStatus(settings.statusLine?.command)) {
    settings.statusLine = { type: 'command', command: STATUS_CMD, padding: 0 }
    const w = await host.exec(`umask 077; mkdir -p ${shq(dir)} && cat > ${shq(file)}`, { input: JSON.stringify(settings, null, 2) + '\n' })
    if (w.code !== 0) throw new HttpError(500, w.stderr.trim() || `Could not write ${file}`)
  }
  await host.exec(
    `cd ${shq(cwd)} 2>/dev/null && x=$(git rev-parse --git-path info/exclude 2>/dev/null) && { git check-ignore -q .claude/settings.local.json || { mkdir -p "$(dirname "$x")"; echo '.claude/settings.local.json' >> "$x"; }; }; ` +
      `l="$HOME/${PROJECT_LIST}"; grep -qxF ${shq(file)} "$l" 2>/dev/null || echo ${shq(file)} >> "$l"`,
  )
}

/** Takes Inyon's status line back out of the project settings it was added to. */
async function removeProjectStatusLines(host: Host) {
  const files = (await host.exec(`cat "$HOME/${PROJECT_LIST}" 2>/dev/null`)).stdout.split('\n').filter(Boolean)
  for (const file of files) {
    const cur = (await host.exec(`cat ${shq(file)} 2>/dev/null`)).stdout
    let s: any
    try {
      s = JSON.parse(cur)
    } catch {
      continue
    }
    if (!isOurStatus(s?.statusLine?.command)) continue
    delete s.statusLine
    if (Object.keys(s).length) await host.exec(`cat > ${shq(file)}`, { input: JSON.stringify(s, null, 2) + '\n' })
    else await host.exec(`rm -f ${shq(file)}`)
  }
  await host.exec(`rm -f "$HOME/${PROJECT_LIST}"`)
}

export async function uninstallIntegration(host: Host) {
  await removeProjectStatusLines(host)
  const settings = await readSettings(host)
  if (isOurStatus(settings.statusLine?.command)) {
    const orig = (await host.exec('cat "$HOME/.inyon/statusline.orig" 2>/dev/null')).stdout.trim()
    if (orig && !isOurStatus(orig)) settings.statusLine = { ...settings.statusLine, command: orig }
    else delete settings.statusLine
  }
  for (const name of Object.keys(settings.hooks ?? {})) dropOurs(settings.hooks, name)
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks
  await writeSettings(host, settings)
  // the hook's log holds your prompts: it goes with the hook
  await host.exec('rm -f "$HOME/.inyon/hook.sh" "$HOME/.inyon/statusline.sh" "$HOME/.inyon/statusline.orig" "$HOME/.inyon/events.jsonl" "$HOME/.inyon/events.old.jsonl"')
  await uninstallAgyIntegration(host)
}
