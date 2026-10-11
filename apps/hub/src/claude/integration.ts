import { Host, shq } from '../hosts/host.ts'
import { HttpError } from '../hosts/registry.ts'
import { ACCOUNT_SH, MARKER } from './integration-sh.ts'

/**
 * The hook only appends Claude Code's own hook payload, tagged with the tmux pane, to a local
 * log. It prints nothing and always exits 0, so it never changes what Claude does.
 */
export const HOOK_SCRIPT = `#!/bin/sh
# Tether: records Claude Code events so Tether knows which tmux pane runs which session.
# Safe to delete; remove the matching entries from ~/.claude/settings.json too.
# ${MARKER}
# the events hold your prompts: readable by you only
umask 077
d="$HOME/.tether"
mkdir -p "$d/panes" 2>/dev/null
p=$(tr -d '\\n\\r')
[ -n "$p" ] || exit 0
line=$(printf '{"pane":"%s","ts":%s,"data":%s}' "\${TMUX_PANE:-}" "$(date +%s)" "$p")
printf '%s\\n' "$line" >> "$d/events.jsonl"
[ -n "\${TMUX_PANE:-}" ] && printf '%s\\n' "$line" > "$d/panes/\${TMUX_PANE#%}.json"
# after a compaction, so Tether stops showing the context size from before it
case "$p" in
  *'"hook_event_name":"SessionStart"'*'"source":"compact"'*|*'"source":"compact"'*'"hook_event_name":"SessionStart"'*)
    [ -n "\${TMUX_PANE:-}" ] && date +%s > "$d/panes/\${TMUX_PANE#%}.compact" ;;
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
# Tether: saves Claude Code's status line data per tmux pane, then runs your own status line.
# ${MARKER}
in=$(cat)
# (in a subshell, so your own status line below keeps your umask)
if [ -n "\${TMUX_PANE:-}" ]; then (
  umask 077
  d="$HOME/.tether/status"; f="$d/\${TMUX_PANE#%}"
  mkdir -p "$d" 2>/dev/null
  printf '%s' "$in" | tr -d '\\n\\r' > "$f.json.$$" && mv -f "$f.json.$$" "$f.json"
  # the signed-in account, so limits reported for a previous account are never shown as this one's
  cfg="\${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
  printf '%s %s\\n' "$(${ACCOUNT_SH} "$cfg")" "$cfg" > "$f.acct"
)
fi
orig="$HOME/.tether/statusline.orig"
[ -s "$orig" ] && printf '%s' "$in" | sh "$orig"
exit 0
`

/**
 * Antigravity CLI (agy) runs its status line command with a similar payload: model and effort,
 * context window, the Gemini and third-party quotas, and whether it is working. Saved per pane in
 * its own folder, then your own agy status line runs.
 */
export const AGY_STATUS_SCRIPT = `#!/bin/sh
# Tether: saves Antigravity CLI's status line data per tmux pane, then runs your own status line.
# Safe to delete; remove "statusLine" from ~/.gemini/antigravity-cli/settings.json too.
# ${MARKER}
in=$(cat)
if [ -n "\${TMUX_PANE:-}" ]; then (
  umask 077
  d="$HOME/.tether/agy-status"; f="$d/\${TMUX_PANE#%}"
  mkdir -p "$d" 2>/dev/null
  printf '%s' "$in" | tr -d '\\n\\r' > "$f.json.$$" && mv -f "$f.json.$$" "$f.json"
)
fi
orig="$HOME/.tether/agy-statusline.orig"
[ -s "$orig" ] && printf '%s' "$in" | sh "$orig"
exit 0
`

const HOOK_CMD = '~/.tether/hook.sh'
const STATUS_CMD = '~/.tether/statusline.sh'
const isOurStatus = (c: unknown) => typeof c === 'string' && c.includes('.tether/statusline.sh')
const EVENTS: { name: string; matcher?: string }[] = [
  { name: 'SessionStart' },
  { name: 'SessionEnd' },
  { name: 'UserPromptSubmit' },
  { name: 'Notification' },
  { name: 'PermissionRequest', matcher: '*' },
  { name: 'Stop' },
]

const isOurs = (h: any) => typeof h?.command === 'string' && h.command.includes('.tether/hook.sh')

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
  const cmd = [
    'mkdir -p "$HOME/.claude"',
    '[ -f "$HOME/.claude/settings.json" ] && [ ! -f "$HOME/.claude/settings.json.tether-backup" ] && cp "$HOME/.claude/settings.json" "$HOME/.claude/settings.json.tether-backup"',
    'cat > "$HOME/.claude/settings.json.tether-tmp" && mv "$HOME/.claude/settings.json.tether-tmp" "$HOME/.claude/settings.json"',
  ].join('; ')
  const r = await host.exec(cmd, { input: JSON.stringify(settings, null, 2) + '\n' })
  if (r.code !== 0) throw new HttpError(500, r.stderr.trim() || 'Could not write settings')
}

async function writeFile(host: Host, path: string, content: string, mode = '600') {
  const r = await host.exec(`umask 077; mkdir -p "$HOME/.tether" && cat > "$HOME/${path}" && chmod ${mode} "$HOME/${path}"`, { input: content })
  if (r.code !== 0) throw new HttpError(500, r.stderr.trim() || `Could not write ~/${path}`)
}

const windowsPath = (cmd: string) => /(^|[\s"'])[A-Za-z]:[\\/]/.test(cmd)

export async function installIntegration(host: Host) {
  await writeFile(host, '.tether/hook.sh', HOOK_SCRIPT, '700')
  await writeFile(host, '.tether/statusline.sh', STATUS_SCRIPT, '700')
  // ~/.tether holds your prompts (events.jsonl, panes/): earlier versions left it readable by others
  await host.exec('umask 077; mkdir -p "$HOME/.tether/panes" "$HOME/.tether/status" && chmod 700 "$HOME/.tether" && chmod 600 "$HOME/.tether/events.jsonl" "$HOME/.tether/events.old.jsonl" 2>/dev/null; true')
  const settings = await readSettings(host)
  const sl = settings.statusLine
  if (!isOurStatus(sl?.command)) {
    const cmd = sl?.type === 'command' && typeof sl.command === 'string' ? sl.command : ''
    const prev = (await host.exec('cat "$HOME/.tether/statusline.orig" 2>/dev/null')).stdout.trim()
    // Settings synced from a Windows machine bring a status line that can't run here. Keep the one that does.
    if (!(windowsPath(cmd) && prev && !windowsPath(prev))) await writeFile(host, '.tether/statusline.orig', cmd ? `${cmd}\n` : '')
    settings.statusLine = { ...(sl ?? { padding: 0 }), type: 'command', command: STATUS_CMD }
  }
  settings.hooks ??= {}
  for (const ev of EVENTS) {
    const groups: any[] = (settings.hooks[ev.name] ??= [])
    if (groups.some((g) => (g.hooks ?? []).some(isOurs))) continue
    groups.push({ ...(ev.matcher ? { matcher: ev.matcher } : {}), hooks: [{ type: 'command', command: HOOK_CMD }] })
  }
  await writeSettings(host, settings)
  await installAgyIntegration(host)
  await installCodexIntegration(host)
}

// ---------- Codex ----------

const CODEX_HOOKS = '$HOME/.codex/hooks.json'
/** Codex sends the same hook input as Claude (session_id, transcript_path, hook_event_name), so the
 * same script records it: which pane runs which thread, exactly, with no guessing by folder or title */
const CODEX_EVENTS: { name: string; matcher?: string }[] = [
  { name: 'SessionStart' },
  { name: 'UserPromptSubmit' },
  { name: 'PermissionRequest', matcher: '*' },
  { name: 'Stop' },
  { name: 'SessionEnd' },
]

/** Codex's hooks file, or undefined when Codex isn't on the machine or it's Windows (hooks run in cmd there). */
async function readCodexHooks(host: Host): Promise<any | undefined> {
  const r = await host.exec(`[ "$(uname -s 2>/dev/null)" = Windows_NT ] && exit 0; if command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]; then echo @@; cat "${CODEX_HOOKS}" 2>/dev/null; fi`)
  if (!r.stdout.startsWith('@@')) return undefined
  const text = r.stdout.slice(2).trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(409, '~/.codex/hooks.json on that machine is not valid JSON; fix it first')
  }
}

async function writeCodexHooks(host: Host, file: any) {
  const f = CODEX_HOOKS
  const cmd = [
    'mkdir -p "$HOME/.codex"',
    `[ -f "${f}" ] && [ ! -f "${f}.tether-backup" ] && cp "${f}" "${f}.tether-backup"`,
    `cat > "${f}.tether-tmp" && mv "${f}.tether-tmp" "${f}"`,
  ].join('; ')
  const r = await host.exec(cmd, { input: JSON.stringify(file, null, 2) + '\n' })
  if (r.code !== 0) throw new HttpError(500, r.stderr.trim() || 'Could not write ~/.codex/hooks.json')
}

/**
 * Adds Tether's hook to ~/.codex/hooks.json, next to any hooks already there. Codex asks once to
 * trust new hooks ("Hooks need review"); sessions started before pick it up when restarted.
 */
export async function installCodexIntegration(host: Host) {
  const file = await readCodexHooks(host)
  if (!file) return false
  await writeFile(host, '.tether/hook.sh', HOOK_SCRIPT, '700')
  file.hooks ??= {}
  let changed = false
  for (const ev of CODEX_EVENTS) {
    const groups: any[] = (file.hooks[ev.name] ??= [])
    if (groups.some((g) => (g.hooks ?? []).some(isOurs))) continue
    groups.push({ ...(ev.matcher ? { matcher: ev.matcher } : {}), hooks: [{ type: 'command', command: HOOK_CMD, timeout: 5 }] })
    changed = true
  }
  if (changed) await writeCodexHooks(host, file)
  return true
}

export async function uninstallCodexIntegration(host: Host) {
  const file = await readCodexHooks(host)
  if (!file?.hooks) return
  let changed = false
  for (const [name, groups] of Object.entries<any[]>(file.hooks)) {
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h)) })).filter((g) => g.hooks.length)
    if (kept.length !== groups.length || kept.some((g, i) => g.hooks.length !== (groups[i]?.hooks ?? []).length)) changed = true
    if (kept.length) file.hooks[name] = kept
    else delete file.hooks[name]
  }
  if (!Object.keys(file.hooks).length) delete file.hooks
  if (changed) await writeCodexHooks(host, file)
}

const AGY_SETTINGS = '$HOME/.gemini/antigravity-cli/settings.json'
const AGY_STATUS_CMD = '~/.tether/agy-statusline.sh'
const isOurAgyStatus = (c: unknown) => typeof c === 'string' && c.includes('.tether/agy-statusline.sh')

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
    'mkdir -p "$HOME/.gemini/antigravity-cli"',
    `[ -f "${f}" ] && [ ! -f "${f}.tether-backup" ] && cp "${f}" "${f}.tether-backup"`,
    `cat > "${f}.tether-tmp" && mv "${f}.tether-tmp" "${f}"`,
  ].join('; ')
  const r = await host.exec(cmd, { input: JSON.stringify(settings, null, 2) + '\n' })
  if (r.code !== 0) throw new HttpError(500, r.stderr.trim() || 'Could not write agy settings')
}

/** Adds the status line wrapper to agy's settings. Sessions already running pick it up when restarted. */
export async function installAgyIntegration(host: Host) {
  const settings = await readAgySettings(host)
  if (!settings) return false
  await writeFile(host, '.tether/agy-statusline.sh', AGY_STATUS_SCRIPT, '700')
  const sl = settings.statusLine
  if (!isOurAgyStatus(sl?.command)) {
    const cmd = sl?.type === 'command' && typeof sl.command === 'string' ? sl.command : ''
    await writeFile(host, '.tether/agy-statusline.orig', cmd ? `${cmd}\n` : '')
    // with no status line of your own, agy keeps drawing its default one (the wrapper prints nothing)
    settings.statusLine = cmd ? { ...sl, type: 'command', command: AGY_STATUS_CMD } : { type: 'command', command: AGY_STATUS_CMD, stack_with_default: true }
    await writeAgySettings(host, settings)
  }
  return true
}

export async function uninstallAgyIntegration(host: Host) {
  const settings = await readAgySettings(host)
  if (settings && isOurAgyStatus(settings.statusLine?.command)) {
    const orig = (await host.exec('cat "$HOME/.tether/agy-statusline.orig" 2>/dev/null')).stdout.trim()
    if (orig) settings.statusLine = { ...settings.statusLine, command: orig }
    else delete settings.statusLine
    await writeAgySettings(host, settings)
  }
  await host.exec('rm -rf "$HOME/.tether/agy-statusline.sh" "$HOME/.tether/agy-statusline.orig" "$HOME/.tether/agy-status"')
}

/** Project settings files Tether added its status line to (see reconnectStatusLine). */
const PROJECT_LIST = '.tether/project-statuslines'

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
    const w = await host.exec(`mkdir -p ${shq(dir)} && cat > ${shq(file)}`, { input: JSON.stringify(settings, null, 2) + '\n' })
    if (w.code !== 0) throw new HttpError(500, w.stderr.trim() || `Could not write ${file}`)
  }
  await host.exec(
    `cd ${shq(cwd)} 2>/dev/null && x=$(git rev-parse --git-path info/exclude 2>/dev/null) && { git check-ignore -q .claude/settings.local.json || { mkdir -p "$(dirname "$x")"; echo '.claude/settings.local.json' >> "$x"; }; }; ` +
      `l="$HOME/${PROJECT_LIST}"; grep -qxF ${shq(file)} "$l" 2>/dev/null || echo ${shq(file)} >> "$l"`,
  )
}

/** Takes Tether's status line back out of the project settings it was added to. */
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
    const orig = (await host.exec('cat "$HOME/.tether/statusline.orig" 2>/dev/null')).stdout.trim()
    if (orig) settings.statusLine = { ...settings.statusLine, command: orig }
    else delete settings.statusLine
  }
  for (const [name, groups] of Object.entries<any[]>(settings.hooks ?? {})) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h)) }))
      .filter((g) => g.hooks.length)
    if (kept.length) settings.hooks[name] = kept
    else delete settings.hooks[name]
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks
  await writeSettings(host, settings)
  await host.exec('rm -f "$HOME/.tether/hook.sh" "$HOME/.tether/statusline.sh" "$HOME/.tether/statusline.orig"')
  await uninstallAgyIntegration(host)
  await uninstallCodexIntegration(host)
}
