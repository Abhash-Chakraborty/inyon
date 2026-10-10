import { Host, shq } from '../hosts/host.ts'
import { ACCOUNT_SH, MARKER } from '../claude/integration-sh.ts'
import { SIGNED_IN_SH } from '../agents/auth-sh.ts'
import { AGENTS, AGENT_KINDS, detectAgent, type AgentKind, type IntegrationState, type PaneInfo, type SessionInfo, type WindowInfo } from '@tether/protocol'

/** Sessions Tether creates for terminal views; hidden from listings. */
export const VIEW_PREFIX = 'tether-view-'
/** Sessions running an agent's sign-in; hidden too. */
export const LOGIN_PREFIX = 'tether-login-'

const SEP = '\u001f'
const PANE_FORMAT = [
  '#{session_id}', '#{session_name}', '#{session_attached}',
  '#{window_id}', '#{window_index}', '#{window_name}', '#{window_active}', '#{window_activity}',
  '#{pane_id}', '#{pane_index}', '#{pane_active}', '#{pane_pid}', '#{pane_current_command}',
  '#{pane_current_path}', '#{pane_title}', '#{pane_width}', '#{pane_height}', '#{pane_dead}',
].join(SEP)

interface Proc {
  pid: number
  ppid: number
  etimes: number
  comm: string
  args: string
}

export interface HookPaneState {
  pane: string
  ts: number
  data: { session_id?: string; transcript_path?: string; cwd?: string; hook_event_name?: string; [k: string]: any }
}

export interface AgentProc {
  kind: AgentKind
  pid: number
  startedAt: number
  cwd?: string
  resume?: string
  args: string
  /** the pane's own process; equal to pid when the agent was started as the pane command */
  panePid: number
}

export interface ProbeResult {
  hostname: string
  home: string
  os: string
  now: number
  latencyMs: number
  tmux: 'ok' | 'no-server' | 'missing'
  integration: Exclude<IntegrationState, 'unknown'>
  sessions: SessionInfo[]
  /** pane id → agent process found inside it */
  agentProcs: Map<string, AgentProc>
  hookPanes: Map<string, HookPaneState>
  /** pane id → last status line payload (Claude), with the account it was written under and the one signed in now */
  statusPanes: Map<string, { ts: number; data: any; account?: string; accountNow?: string }>
  /** Claude account this machine is signed in to now (oauthAccount.accountUuid) */
  account?: string
  /** pane id → unix seconds of the last compaction (Claude) */
  compactPanes: Map<string, number>
  installed: AgentKind[]
  /** agents with a saved sign-in on the machine */
  signedIn: AgentKind[]
  /** Antigravity CLI: process id → the conversation it has open (from the presence lock it holds) */
  agyConversations: Map<number, string>
  /** Antigravity CLI: pane id → last status line payload */
  agyStatus: Map<string, { ts: number; data: any }>
  /** Antigravity conversation id → its title */
  agyTitles: Map<string, string>
  /** whether Tether's status line is in Antigravity CLI's settings (undefined when agy isn't installed) */
  agyIntegration?: 'installed' | 'missing'
}

const BINS = [...new Set(AGENT_KINDS.flatMap((k) => AGENTS[k].comm))]

export const PROBE = `
export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
for d in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.local/share/pnpm; do [ -d "$d" ] && PATH="$PATH:$d"; done
echo "@@HOST $(hostname)"
echo "@@HOME $HOME"
echo "@@OS $(uname -s)"
echo "@@NOW $(date +%s)"
echo "@@BINS"
for b in ${BINS.join(' ')}; do command -v "$b" >/dev/null 2>&1 && echo "$b"; done
if command -v tmux >/dev/null 2>&1; then
  echo "@@TMUX"
  tmux list-panes -a -F ${shq(PANE_FORMAT)} 2>/dev/null || echo "@@NOSERVER"
else
  echo "@@NOTMUX"
fi
echo "@@CLIENTS"
tmux list-clients -F '#{session_id} #{client_control_mode}' 2>/dev/null
echo "@@PS"
ps -e -o pid=,ppid=,etimes=,comm=,args= 2>/dev/null
echo "@@CWD"
for p in $(pgrep -f 'claude|codex|opencode|gemini|command-?code|agy' 2>/dev/null); do echo "$p $(readlink /proc/$p/cwd 2>/dev/null)"; done
echo "@@AGY"
# each Antigravity CLI holds ~/.gemini/antigravity-cli/presence/<conversation>.lock open; the newest fd wins
agy_ids=""
for p in $(pgrep -x agy 2>/dev/null); do
  if [ -d /proc/$p/fd ]; then
    l=$(for fd in /proc/$p/fd/*; do l=$(readlink "$fd" 2>/dev/null); case "$l" in */antigravity-cli/presence/*.lock) echo "\${fd##*/} $p $l";; esac; done | sort -n | tail -n 1)
  else
    l=$(lsof -p $p 2>/dev/null | awk -v p=$p '/antigravity-cli\/presence\/.*\.lock/ {print 0, p, $NF}' | tail -n 1)
  fi
  [ -n "$l" ] && echo "$l" && agy_ids="$agy_ids $(basename "\${l##* }" .lock)"
done
echo "@@AGYTITLE"
# titles agy gives its conversations (shown in its /resume list)
if [ -n "$agy_ids" ] && command -v sqlite3 >/dev/null 2>&1; then
  for id in $agy_ids; do case "$id" in *[!0-9a-f-]*) continue;; esac
    echo "$id $(sqlite3 -readonly "$HOME/.gemini/antigravity-cli/conversation_summaries.db" "select title from conversation_summaries where conversation_id='$id'" 2>/dev/null | head -n 1)"
  done
fi
echo "@@AGYSTATUS"
# status files of panes that closed over an hour ago only pile up
live=" $(tmux list-panes -a -F '#{pane_id}' 2>/dev/null | tr -d '%' | tr '\n' ' ') "
for f in $(find "$HOME/.tether/status" "$HOME/.tether/panes" "$HOME/.tether/agy-status" -maxdepth 1 -type f -mmin +60 2>/dev/null); do
  n=$(basename "$f"); n=\${n%.*}
  case "$n" in ''|*[!0-9.]*) continue;; esac
  case "$live" in *" $n "*) ;; *) rm -f "$f";; esac
done
for f in "$HOME"/.tether/agy-status/*.json; do [ -f "$f" ] && echo "$(basename "$f" .json) $(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f") $(cat "$f")"; done 2>/dev/null
if command -v agy >/dev/null 2>&1; then
  if grep -q 'tether/agy-statusline.sh' "$HOME/.gemini/antigravity-cli/settings.json" 2>/dev/null && grep -q '${MARKER}' "$HOME/.tether/agy-statusline.sh" 2>/dev/null; then echo "@@AGYINT installed"; else echo "@@AGYINT missing"; fi
fi
echo "@@HOOK"
t="$HOME/.tether"
if [ ! -x "$t/hook.sh" ] || [ ! -x "$t/statusline.sh" ]; then echo missing
elif ! grep -q 'tether/statusline.sh' "$HOME/.claude/settings.json" 2>/dev/null || ! grep -q 'tether/hook.sh' "$HOME/.claude/settings.json" 2>/dev/null; then echo removed
elif grep -q '${MARKER}' "$t/hook.sh" && grep -q '${MARKER}' "$t/statusline.sh"; then echo installed
else echo outdated; fi
echo "@@AUTH $(${SIGNED_IN_SH})"
echo "@@ACCOUNT $(${ACCOUNT_SH} "\${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json")"
echo "@@PANES"
cat "$t"/panes/*.json 2>/dev/null
echo "@@COMPACT"
for f in "$t"/panes/*.compact; do [ -f "$f" ] && echo "$(basename "$f" .compact) $(cat "$f")"; done 2>/dev/null
echo "@@STATUS"
# pane, mtime, account when written, account now, payload
for f in "$t"/status/*.json; do
  [ -f "$f" ] || continue
  w=-; c=-
  if [ -f "\${f%.json}.acct" ]; then read -r w cfg < "\${f%.json}.acct"; c=$(${ACCOUNT_SH} "$cfg"); fi
  echo "$(basename "$f" .json) $(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f") \${w:--} \${c:--} $(cat "$f")"
done 2>/dev/null
echo "@@END"
`

export async function probe(host: Host): Promise<ProbeResult> {
  const t0 = performance.now()
  const r = await host.exec(PROBE, { timeoutMs: 15000 })
  const latencyMs = Math.round(performance.now() - t0)
  if (!r.stdout.includes('@@END')) {
    throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').slice(-2).join(' '))
  }
  const sections = new Map<string, string[]>()
  let cur = ''
  const res: ProbeResult = {
    hostname: '', home: '', os: '', now: Date.now() / 1000, latencyMs, tmux: 'ok', integration: 'missing',
    sessions: [], agentProcs: new Map(), hookPanes: new Map(), statusPanes: new Map(), compactPanes: new Map(), installed: [], signedIn: [],
    agyConversations: new Map(), agyStatus: new Map(), agyTitles: new Map(),
  }
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('@@HOST ')) res.hostname = line.slice(7).trim()
    else if (line.startsWith('@@HOME ')) res.home = line.slice(7).trim()
    // busybox-w32 (tether-node on Windows) says Windows_NT
    else if (line.startsWith('@@OS ')) res.os = line.slice(5).trim().replace(/^Windows_NT$/, 'Windows')
    else if (line.startsWith('@@NOW ')) res.now = Number(line.slice(6))
    else if (line.startsWith('@@AUTH')) res.signedIn = AGENT_KINDS.filter((k) => line.slice(6).trim().split(/\s+/).includes(k))
    else if (line.startsWith('@@ACCOUNT ')) res.account = line.slice(10).trim() === '-' ? undefined : line.slice(10).trim()
    else if (line.startsWith('@@AGYINT ')) res.agyIntegration = line.slice(9).trim() === 'installed' ? 'installed' : 'missing'
    else if (line === '@@NOSERVER') res.tmux = 'no-server'
    else if (line === '@@NOTMUX') res.tmux = 'missing'
    else if (/^@@[A-Z]+$/.test(line)) {
      cur = line.slice(2)
      sections.set(cur, [])
    } else if (cur) sections.get(cur)!.push(line)
  }

  // processes
  const procs = new Map<number, Proc>()
  const children = new Map<number, number[]>()
  for (const line of sections.get('PS') ?? []) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const p: Proc = { pid: +m[1], ppid: +m[2], etimes: +m[3], comm: m[4], args: m[5] }
    procs.set(p.pid, p)
    if (!children.has(p.ppid)) children.set(p.ppid, [])
    children.get(p.ppid)!.push(p.pid)
  }
  const cwds = new Map<number, string>()
  for (const line of sections.get('CWD') ?? []) {
    const i = line.indexOf(' ')
    if (i > 0 && line.slice(i + 1)) cwds.set(+line.slice(0, i), line.slice(i + 1))
  }
  const findAgent = (root: number): { p: Proc; kind: AgentKind } | undefined => {
    const queue: [number, number][] = [[root, 0]]
    while (queue.length) {
      const [pid, depth] = queue.shift()!
      const p = procs.get(pid)
      const kind = p && detectAgent(p.comm, p.args)
      if (p && kind) return { p, kind }
      if (depth < 4) for (const c of children.get(pid) ?? []) queue.push([c, depth + 1])
    }
    return undefined
  }

  const bins = new Set((sections.get('BINS') ?? []).map((l) => l.trim()).filter(Boolean))
  res.installed = AGENT_KINDS.filter((k) => AGENTS[k].comm.some((c) => bins.has(c)))
  for (const line of sections.get('STATUS') ?? []) {
    const m = line.match(/^(\d+) (\d+) (\S+) (\S+) (.*)$/)
    if (!m) continue
    const acct = (v: string) => (v === '-' ? undefined : v)
    try {
      res.statusPanes.set(`%${m[1]}`, { ts: Number(m[2]), account: acct(m[3]), accountNow: acct(m[4]), data: JSON.parse(m[5]) })
    } catch {}
  }
  for (const line of sections.get('AGY') ?? []) {
    const m = line.match(/^\d+ (\d+) .*\/presence\/([0-9a-f-]{36})\.lock$/)
    if (m) res.agyConversations.set(+m[1], m[2])
  }
  for (const line of sections.get('AGYTITLE') ?? []) {
    const m = line.match(/^([0-9a-f-]{36}) (.+)$/)
    if (m) res.agyTitles.set(m[1], m[2].trim())
  }
  for (const line of sections.get('AGYSTATUS') ?? []) {
    const m = line.match(/^(\d+) (\d+) (.*)$/)
    if (!m) continue
    try {
      res.agyStatus.set(`%${m[1]}`, { ts: Number(m[2]), data: JSON.parse(m[3]) })
    } catch {}
  }
  for (const line of sections.get('COMPACT') ?? []) {
    const m = line.match(/^(\d+) (\d+)/)
    if (m) res.compactPanes.set(`%${m[1]}`, Number(m[2]))
  }

  const hook = (sections.get('HOOK') ?? [])[0]?.trim()
  res.integration = hook === 'installed' || hook === 'removed' || hook === 'outdated' ? hook : 'missing'
  for (const line of sections.get('PANES') ?? []) {
    if (!line.trim()) continue
    try {
      const s = JSON.parse(line) as HookPaneState
      if (s.pane) res.hookPanes.set(s.pane, s)
    } catch {}
  }

  // tmux tree
  const sessions = new Map<string, SessionInfo>()
  const windows = new Map<string, WindowInfo>()
  for (const line of sections.get('TMUX') ?? []) {
    const f = line.split(SEP)
    if (f.length < 18) continue
    const [sid, sname, sattached, wid, widx, wname, wactive, wact, pid, pidx, pactive, ppid, pcmd, pcwd, ptitle, pw, ph, pdead] = f
    if (sname.startsWith(VIEW_PREFIX) || sname.startsWith(LOGIN_PREFIX)) continue
    let s = sessions.get(sid)
    if (!s) sessions.set(sid, (s = { id: sid, name: sname, attached: +sattached, windows: [] }))
    const wkey = `${sid}/${wid}`
    let w = windows.get(wkey)
    if (!w) {
      w = { id: wid, index: +widx, name: wname, active: wactive === '1', activity: +wact, panes: [] }
      windows.set(wkey, w)
      s.windows.push(w)
    }
    const pane: PaneInfo = {
      id: pid, index: +pidx, active: pactive === '1', command: pcmd, cwd: pcwd, title: ptitle,
      width: +pw, height: +ph, dead: pdead === '1',
    }
    w.panes.push(pane)
    const found = findAgent(+ppid)
    if (found) {
      const { p: cp, kind } = found
      const resume = cp.args.match(/(?:--resume|-r|resume)[ =]([0-9a-f]{8}-[0-9a-f-]{27})/)?.[1]
      res.agentProcs.set(pid, { kind, pid: cp.pid, startedAt: res.now - cp.etimes, cwd: cwds.get(cp.pid) ?? pcwd, resume, args: cp.args, panePid: +ppid })
    }
  }
  // the "attached" count shouldn't include Tether's own control-mode clients
  const people = new Map<string, number>()
  for (const line of sections.get('CLIENTS') ?? []) {
    const [sid, control] = line.trim().split(' ')
    if (sid && control === '0') people.set(sid, (people.get(sid) ?? 0) + 1)
  }
  if (sections.has('CLIENTS')) for (const s of sessions.values()) s.attached = people.get(s.id) ?? 0
  res.sessions = [...sessions.values()]
  return res
}

/** Captures the visible screen of several panes in one round trip, with styling (see unstyle). */
export async function capturePanes(host: Host, paneIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!paneIds.length) return out
  const cmd = paneIds
    .map((p) => `echo ${shq('@@CAP ' + p)}; tmux capture-pane -p -e -t ${shq(p)} 2>/dev/null`)
    .join('; ')
  const r = await host.exec(cmd, { timeoutMs: 10000 })
  let cur: string[] | null = null
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('@@CAP ')) {
      cur = []
      out.set(line.slice(6), cur)
    } else cur?.push(line)
  }
  return out
}

/**
 * Types text into a pane exactly as a person would; newlines become Ctrl+J (newline without
 * submitting). With `submit`, Enter follows after a short pause, all in one round trip.
 */
export async function typeText(host: Host, pane: string, text: string, submit = false) {
  if (text.length > 800 || /[\r\n]/.test(text)) {
    // Deliver one bracketed paste instead of a burst of individual key events. The CLI can
    // preserve long/multiline text atomically and display its own collapsed paste preview.
    const buffer = `tether-${crypto.randomUUID()}`
    const result = await host.exec(`tmux load-buffer -b ${shq(buffer)} - && tmux paste-buffer -d -p -b ${shq(buffer)} -t ${shq(pane)}`, { input: text.replace(/\r\n?/g, '\n') })
    if (result.code !== 0) {
      await host.exec(`tmux delete-buffer -b ${shq(buffer)} 2>/dev/null`).catch(() => {})
      throw new Error(result.stderr.trim() || 'Could not paste text into the terminal')
    }
    if (submit) {
      await Bun.sleep(150)
      await sendKeys(host, pane, ['Enter'])
    }
    return
  }
  const parts: string[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  lines.forEach((line, i) => {
    if (i > 0) parts.push(`tmux send-keys -t ${shq(pane)} C-j`)
    for (let o = 0; o < line.length; o += 800) {
      parts.push(`tmux send-keys -t ${shq(pane)} -l -- ${shq(line.slice(o, o + 800))}`)
    }
  })
  if (submit) parts.push('sleep 0.12', `tmux send-keys -t ${shq(pane)} Enter`)
  if (!parts.length) return
  const r = await host.exec(parts.join(' && '))
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'send-keys failed')
}

const KEY_RE = /^([A-Za-z0-9]|Enter|Escape|Tab|BTab|Up|Down|Left|Right|Space|BSpace|Home|End|PageUp|PageDown|C-[a-z])$/

export async function sendKeys(host: Host, pane: string, keys: string[]) {
  for (const k of keys) if (!KEY_RE.test(k)) throw new Error(`key not allowed: ${k}`)
  const r = await host.exec(keys.map((k) => `tmux send-keys -t ${shq(pane)} ${k}`).join(' && '))
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'send-keys failed')
}

/**
 * Best guess at a Claude process's transcript without hooks: the session it was resumed with, or
 * the newest transcript in its project folder written since the process started. A brand-new
 * session has no transcript until its first message, so older files are never picked.
 */
export async function guessTranscript(
  host: Host,
  home: string,
  proc: { cwd?: string; startedAt: number; resume?: string },
): Promise<string | undefined> {
  if (!proc.cwd) return undefined
  const dir = `${home}/.claude/projects/${proc.cwd.replace(/[^a-zA-Z0-9]/g, '-')}`
  const cmd = `cd ${shq(dir)} 2>/dev/null && for f in $(ls -t *.jsonl 2>/dev/null | head -5); do echo "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f") $f"; done`
  const r = await host.exec(cmd)
  const files = r.stdout.trim().split('\n').filter(Boolean).map((l) => {
    const [mtime, name] = [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]
    return { mtime: Number(mtime), name }
  })
  if (proc.resume) {
    const hit = files.find((f) => f.name === `${proc.resume}.jsonl`)
    if (hit || !files.length) return `${dir}/${proc.resume}.jsonl`
  }
  const fresh = files.find((f) => f.mtime >= proc.startedAt - 2)
  return fresh ? `${dir}/${fresh.name}` : proc.resume ? `${dir}/${proc.resume}.jsonl` : undefined
}
