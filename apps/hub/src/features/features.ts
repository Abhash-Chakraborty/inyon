import { OpenCodeClient } from '../agents/opencode-api.ts'
import { AGENTS, type AgentKind, type ChatItem, type SlashCommand } from '@inyon/protocol'
import { shq } from '../hosts/host.ts'
import { HttpError, registry } from '../hosts/registry.ts'
import { loadSettings } from '../config.ts'
import { newMeta, normalize } from '../claude/transcript.ts'

function hostAndHome(hostId: string) {
  const rt = registry.get(hostId)
  if (!rt) throw new HttpError(404, 'Unknown machine')
  const home = rt.probe?.home
  if (!home) throw new HttpError(503, 'Machine is not connected yet')
  return { host: rt.host, home }
}

function paneOf(hostId: string, paneId: string) {
  const f = registry.findPane(hostId, paneId)
  if (!f) throw new HttpError(404, 'Pane not found')
  return f.pane
}

const expand = (p: string, home: string, cwd?: string) =>
  p.replace(/^~(?=\/|$)/, home).replace('{cwd}', cwd ?? '')

// ---------- uploads ----------

const safeName = (n: string) => n.replace(/[^\w.@+-]+/g, '_').replace(/^\.+/, '').slice(-120) || 'file'

export interface Uploaded {
  name: string
  path: string
  size: number
  type: string
}

/**
 * Where a new upload goes: ~/.inyon/uploads/<date>/<session>/<time>-<id>-<name> on the pane's
 * machine. The short random id keeps two files of the same name sent in the same second apart.
 */
function uploadPath(home: string, hostId: string, paneId: string | undefined, name: string) {
  const pane = paneId ? registry.findPane(hostId, paneId)?.pane : undefined
  const bucket = (pane?.agent?.sessionId ?? paneId?.replace('%', 'pane-') ?? 'misc').slice(0, 12)
  const day = new Date().toISOString().slice(0, 10)
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
  return `${home}/.inyon/uploads/${day}/${bucket}/${stamp}-${crypto.randomUUID().slice(0, 6)}-${safeName(name)}`
}

/**
 * Sends a file a few megabytes at a time, so a video never sits in memory whole or crosses the
 * phone's SSH plugin (or a paired link) as one enormous message. `from` is where in the file
 * `data` starts; each later piece is added only if the file has exactly the bytes before it.
 */
const PIECE = 2 * 1024 * 1024
// (Bun's File has slice(); the File type the hub is checked against doesn't say so)
type Piece = { size: number; slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } }
async function writeUpload(host: ReturnType<typeof hostAndHome>['host'], path: string, file: File, from = 0, total = from + file.size) {
  const data = file as unknown as Piece
  const dir = path.slice(0, path.lastIndexOf('/'))
  // the file grows as <name>.part and takes its name once whole, so an upload cut off half way never
  // looks finished to an agent; the janitor deletes .part files an hour old
  const part = `${path}.part`
  for (let at = 0; at < data.size || at === 0; at += PIECE) {
    const input = new Uint8Array(await data.slice(at, at + PIECE).arrayBuffer())
    const end = from + at + input.length
    // private to your user on shared machines
    // a later piece goes on the end only where the file stops; one that's already there (the app
    // retrying after its answer got lost) is skipped, so a retry never doubles a piece
    const write = from + at === 0
      ? `umask 077; mkdir -p ${shq(dir)} && cat > ${shq(part)}`
      : `n="$(wc -c < ${shq(part)} | tr -d ' ')"; if [ "$n" = ${end} ]; then cat > /dev/null; else [ "$n" = ${from + at} ] && cat >> ${shq(part)}; fi`
    const finish = end >= total ? ` && mv -f ${shq(part)} ${shq(path)}` : ''
    // the whole file is already there: this is a retry of the last piece
    const cmd = `if [ -f ${shq(path)} ]; then cat > /dev/null; else { ${write}; }${finish}; fi`
    const r = await host.exec(cmd, { input, timeoutMs: 120000 })
    if (r.code !== 0) throw new HttpError(500, r.stderr.trim() || `Could not save ${path.slice(path.lastIndexOf('/') + 1)}`)
  }
}

/** Copies files into ~/.inyon/uploads/<date>/<session>/ on the pane's machine. */
export async function uploadFiles(hostId: string, paneId: string | undefined, files: File[]): Promise<Uploaded[]> {
  const { host, home } = hostAndHome(hostId)
  const { maxMB } = loadSettings().uploads
  const out: Uploaded[] = []
  for (const f of files) {
    if (f.size > maxMB * 1024 * 1024) throw new HttpError(413, `${f.name} is larger than ${maxMB} MB`)
    const path = uploadPath(home, hostId, paneId, f.name)
    await writeUpload(host, path, f)
    out.push({ name: f.name, path, size: f.size, type: f.type })
  }
  janitor.soon(hostId)
  return out
}

/**
 * One piece of a file the app sends in pieces (the phone app does, so it can show progress and
 * never holds a whole video). The first piece picks the path; the app sends it back with the rest.
 */
export async function uploadPiece(hostId: string, paneId: string | undefined, piece: File, o: { total: number; offset: number; path?: string }): Promise<Uploaded> {
  const { host, home } = hostAndHome(hostId)
  const { maxMB } = loadSettings().uploads
  if (!(o.total >= 0) || !(o.offset >= 0) || o.offset + piece.size > o.total) throw new HttpError(400, 'Bad upload piece')
  if (o.total > maxMB * 1024 * 1024) throw new HttpError(413, `${piece.name} is larger than ${maxMB} MB`)
  const path = o.offset ? o.path : uploadPath(home, hostId, paneId, piece.name)
  if (!path || !path.startsWith(`${home}/.inyon/uploads/`) || /\/\.\.?(\/|$)|[\n\0]/.test(path)) throw new HttpError(400, 'Bad upload path')
  await writeUpload(host, path, piece, o.offset, o.total)
  if (o.offset + piece.size >= o.total) janitor.soon(hostId)
  return { name: piece.name, path, size: o.total, type: piece.type }
}

export async function uploadUsage(hostId: string) {
  const { host, home } = hostAndHome(hostId)
  const dir = `${home}/.inyon/uploads`
  const days = loadSettings().uploads.retentionDays
  const old = days > 0 ? `$(find ${shq(dir)} -type f -mtime +${days} | wc -l)` : '0'
  const r = await host.exec(`[ -d ${shq(dir)} ] || { echo "0 0 0"; exit 0; }; echo "$(du -sk ${shq(dir)} | cut -f1) $(find ${shq(dir)} -type f | wc -l) ${old}"`)
  const [kb, files, expired] = r.stdout.trim().split(/\s+/).map(Number)
  return { bytes: (kb || 0) * 1024, files: files || 0, expired: expired || 0, dir }
}

/**
 * The shell that tidies a machine's uploads: files older than `days` (none when 0, all when -1),
 * .part files an upload left behind over an hour ago, then the oldest days first while the folder
 * is over `maxTotalMB` (0: no limit). Only find, du and rm, so it runs on macOS, Linux and busybox.
 */
export function cleanScript(dir: string, days: number, maxTotalMB = 0) {
  const d = shq(dir)
  const age = days > 0 ? `find ${d} -type f -mtime +${Math.floor(days)} -exec rm -f {} +;` : days < 0 ? `find ${d} -type f -exec rm -f {} +;` : ''
  const cap = maxTotalMB > 0
    ? `n=${days > 0 ? Math.floor(days) : 365}; while [ "$n" -ge 0 ] && [ "$(du -sk ${d} | cut -f1)" -gt ${Math.floor(maxTotalMB) * 1024} ]; do find ${d} -type f -mtime +$n -exec rm -f {} +; n=$((n-1)); done;`
    : ''
  // the machine's own inyon tidies by the same rules while no hub is connected (apps/node/tidy.ts)
  const policy = days >= 0 ? `printf '%s %s\\n' ${Math.floor(days)} ${Math.floor(maxTotalMB)} > ${shq(dir.replace(/\/uploads$/, '/upload-policy'))} 2>/dev/null;` : ''
  return `${policy} [ -d ${d} ] || exit 0; ${age} find ${d} -type f -name '*.part' -mmin +60 -exec rm -f {} +; ${cap} find ${d} -mindepth 1 -type d -empty -delete 2>/dev/null; true`
}

/** Deletes uploads older than `days` (all of them when days is 0), and anything a cut-off upload left. */
export async function cleanUploads(hostId: string, days: number) {
  const { host, home } = hostAndHome(hostId)
  const { maxTotalMB } = loadSettings().uploads
  await host.exec(cleanScript(`${home}/.inyon/uploads`, days > 0 ? days : -1, maxTotalMB))
  return uploadUsage(hostId)
}

/**
 * Keeps every machine's uploads within the settings: each connected machine is tidied when it's
 * first seen, when it comes back after being away, every six hours, and soon after an upload.
 */
export const janitor = (() => {
  const last = new Map<string, number>()
  const tidy = async (id: string) => {
    last.set(id, Date.now())
    const rt = registry.get(id)
    const home = rt?.probe?.home
    if (!rt || !home) return last.delete(id)
    const { retentionDays, maxTotalMB } = loadSettings().uploads
    await rt.host.exec(cleanScript(`${home}/.inyon/uploads`, retentionDays, maxTotalMB)).catch(() => last.delete(id))
  }
  const sweep = () => {
    const online = new Set<string>()
    for (const h of registry.overview()) {
      if (h.status !== 'online') continue
      online.add(h.config.id)
      if (Date.now() - (last.get(h.config.id) ?? 0) > 6 * 3600_000) void tidy(h.config.id)
    }
    // a machine that went away is tidied again as soon as it's back
    for (const id of last.keys()) if (!online.has(id)) last.delete(id)
  }
  return {
    start() {
      setTimeout(sweep, 60_000)
      setInterval(sweep, 10 * 60_000)
    },
    /** after an upload: at most once an hour per machine */
    soon(id: string) {
      if (Date.now() - (last.get(id) ?? 0) > 3600_000) setTimeout(() => void tidy(id), 5_000)
    },
    sweep,
  }
})()

/** Applies the retention setting on every connected machine. */
export const startUploadJanitor = () => janitor.start()

/** A small cache: entries go after `ttl` ms, and past `max` entries the least recently used go first. */
export function lruCache<T>(ttl: number, max: number) {
  const entries = new Map<string, { at: number; value: T }>()
  return {
    get(key: string): T | undefined {
      const hit = entries.get(key)
      if (!hit) return
      entries.delete(key)
      if (Date.now() - hit.at >= ttl) return
      entries.set(key, hit)
      return hit.value
    },
    set(key: string, value: T) {
      entries.delete(key)
      entries.set(key, { at: Date.now(), value })
      for (const [k, e] of entries) {
        if (entries.size <= max && Date.now() - e.at < ttl) break
        entries.delete(k)
      }
    },
    get size() {
      return entries.size
    },
  }
}

// ---------- slash commands ----------

// short, so a skill installed a moment ago shows up the next time the list opens
const cmdCache = lruCache<SlashCommand[]>(5_000, 50)

/** Built-in commands plus skills and custom commands found on the machine. */
export async function listCommands(hostId: string, paneId: string): Promise<SlashCommand[]> {
  const pane = paneOf(hostId, paneId)
  const kind: AgentKind = pane.agent?.kind ?? 'claude'
  const key = `${hostId}:${kind}:${pane.cwd}`
  const hit = cmdCache.get(key)
  if (hit) return hit
  const { host } = hostAndHome(hostId)
  if (kind === 'opencode' && pane.agent?.transcriptPath?.startsWith('opencode://')) {
    const rows = await new OpenCodeClient(host, pane.agent.transcriptPath, pane.cwd).request('/command')
    const dynamic: SlashCommand[] = (Array.isArray(rows) ? rows : []).map((c: any) => ({ name: `/${c.name}`, description: c.description ?? '', source: c.source === 'mcp' ? 'plugin' : 'project' }))
    const names = new Set(dynamic.map((c) => c.name))
    const list = [...AGENTS.opencode.commands.filter((c) => !names.has(c.name)), ...dynamic].sort((a, b) => a.name.localeCompare(b.name))
    cmdCache.set(key, list)
    return list
  }
  const cwd = shq(pane.cwd)
  // prints "source<TAB>name<TAB>description" per entry
  const desc = `awk 'NR==1&&$0!="---"{exit} NR>1&&$0=="---"{exit} /^description:/{sub(/^description:[ ]*/,""); print; exit}' "$f" 2>/dev/null | cut -c1-180`
  // the agents read project skills and commands from the folder and each one above it up to the repo root
  const up = `d=${cwd}; top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null || echo "$d"); dirs="$d"; while [ "$d" != "$top" ] && [ "$d" != / ] && [ -n "$d" ]; do d=$(dirname "$d"); dirs="$dirs
$d"; done`
  const scans: Record<AgentKind, string> = {
    claude: `${up}
for f in "$HOME"/.claude/skills/*/SKILL.md; do [ -f "$f" ] && printf 'skill\\t%s\\t%s\\n' "$(basename "$(dirname "$f")")" "$(${desc})"; done
echo "$dirs" | while read -r p; do for f in "$p"/.claude/skills/*/SKILL.md; do [ -f "$f" ] && printf 'project\\t%s\\t%s\\n' "$(basename "$(dirname "$f")")" "$(${desc})"; done; done
for f in "$HOME"/.claude/commands/*.md; do [ -f "$f" ] && printf 'user\\t%s\\t%s\\n' "$(basename "$f" .md)" "$(${desc})"; done
echo "$dirs" | while read -r p; do for f in "$p"/.claude/commands/*.md; do [ -f "$f" ] && printf 'project\\t%s\\t%s\\n' "$(basename "$f" .md)" "$(${desc})"; done; done
find "$HOME/.claude/plugins" -maxdepth 9 -path '*/skills/*/SKILL.md' 2>/dev/null | head -200 | while read -r f; do printf 'plugin\\t%s\\t%s\\n' "$(basename "$(dirname "$f")")" "$(${desc})"; done`,
    // Codex picks skills with "$name" (its "/" menu is built-in commands only); a plugin's skills are
    // "$plugin:skill", read from the newest cached version of each plugin
    codex: `${up}
for f in "$HOME"/.codex/prompts/*.md; do [ -f "$f" ] && printf 'user\\t/prompts:%s\\t%s\\n' "$(basename "$f" .md)" "$(${desc})"; done
echo "$dirs" | while read -r p; do for f in "$p"/.agents/skills/*/SKILL.md; do [ -f "$f" ] && printf 'project\\t$%s\\t%s\\n' "$(basename "$(dirname "$f")")" "$(${desc})"; done; done
for f in "$HOME"/.agents/skills/*/SKILL.md "$HOME"/.codex/skills/*/SKILL.md "$HOME"/.codex/skills/.system/*/SKILL.md; do [ -f "$f" ] && printf 'skill\\t$%s\\t%s\\n' "$(basename "$(dirname "$f")")" "$(${desc})"; done
find "$HOME/.codex/plugins/cache" -mindepth 6 -maxdepth 6 -path '*/skills/*/SKILL.md' 2>/dev/null | sort -rV | head -300 | while read -r f; do p=\${f%/*/*/*/SKILL.md}; printf 'plugin\\t$%s:%s\\t%s\\n' "\${p##*/}" "$(basename "$(dirname "$f")")" "$(${desc})"; done`,
    opencode: `for f in "$HOME"/.config/opencode/command/*.md "$HOME"/.config/opencode/commands/*.md ${cwd}/.opencode/command/*.md ${cwd}/.opencode/commands/*.md; do [ -f "$f" ] && printf 'user\\t%s\\t%s\\n' "$(basename "$f" .md)" "$(${desc})"; done`,
    gemini: `for f in "$HOME"/.gemini/commands/*.toml ${cwd}/.gemini/commands/*.toml; do [ -f "$f" ] && printf 'user\\t%s\\t%s\\n' "$(basename "$f" .toml)" "$(grep -m1 '^description' "$f" | sed 's/^description *= *//; s/^"//; s/"$//')"; done`,
    copilot: `true`,
    // skills become slash commands: workspace .agents/skills, global ~/.gemini/config/skills, and plugins
    antigravity: `
for f in ${cwd}/.agents/skills/*/SKILL.md ${cwd}/.agent/skills/*/SKILL.md; do [ -f "$f" ] && printf 'project\\t%s\\t%s\\n' "$(basename "$(dirname "$f")")" "$(${desc})"; done
for f in "$HOME"/.gemini/config/skills/*/SKILL.md; do [ -f "$f" ] && printf 'skill\\t%s\\t%s\\n' "$(basename "$(dirname "$f")")" "$(${desc})"; done
find "$HOME/.gemini/antigravity-cli/plugins" -maxdepth 4 -path '*/skills/*/SKILL.md' 2>/dev/null | head -200 | while read -r f; do printf 'plugin\\t%s\\t%s\\n' "$(basename "$(dirname "$f")")" "$(${desc})"; done`,
  }
  const r = await host.exec(scans[kind])
  const seen = new Set<string>()
  const found: SlashCommand[] = []
  for (const line of r.stdout.split('\n')) {
    const [source, name, description] = line.split('\t')
    if (!name) continue
    // Codex skills ("$name") and prompts ("/prompts:name") come with their own prefix
    const full = /^[$/]/.test(name) ? name : `/${name}`
    if (seen.has(full)) continue
    seen.add(full)
    found.push({ name: full, description: (description || '').replace(/^["'>|-]+\s*|["']$/g, ''), source: source as SlashCommand['source'] })
  }
  const builtins = AGENTS[kind].commands.filter((c) => !seen.has(c.name))
  const list = [...builtins, ...found].sort((a, b) => a.name.localeCompare(b.name))
  cmdCache.set(key, list)
  return list
}

// ---------- @ file mentions ----------

const fileCache = lruCache<string[]>(30_000, 20)

export async function listFiles(hostId: string, paneId: string): Promise<{ cwd: string; files: string[] }> {
  const pane = paneOf(hostId, paneId)
  const key = `${hostId}:${pane.cwd}`
  const hit = fileCache.get(key)
  if (hit) return { cwd: pane.cwd, files: hit }
  const { host } = hostAndHome(hostId)
  const r = await host.exec(
    `cd ${shq(pane.cwd)} 2>/dev/null || exit 0; if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files -co --exclude-standard 2>/dev/null | head -20000; else find . -maxdepth 6 \\( -name node_modules -o -name .git -o -name dist -o -name .venv -o -name __pycache__ \\) -prune -o -type f -print 2>/dev/null | sed 's|^\\./||' | head -20000; fi`,
    { timeoutMs: 15000 },
  )
  const files = r.stdout.split('\n').filter(Boolean)
  fileCache.set(key, files)
  return { cwd: pane.cwd, files }
}

// ---------- agent config files ----------

export interface ConfigFile {
  agent: AgentKind
  label: string
  path: string
  format: 'json' | 'toml' | 'md'
  exists: boolean
  size: number
  mtime?: number
}

function configCandidates(hostId: string, home: string) {
  const rt = registry.get(hostId)!
  const kinds = new Set<AgentKind>(rt.state.agents)
  const cwds = new Map<AgentKind, Set<string>>()
  for (const s of rt.state.sessions)
    for (const w of s.windows)
      for (const p of w.panes)
        if (p.agent) {
          kinds.add(p.agent.kind)
          if (!cwds.has(p.agent.kind)) cwds.set(p.agent.kind, new Set())
          cwds.get(p.agent.kind)!.add(p.cwd)
        }
  const out: Omit<ConfigFile, 'exists' | 'size'>[] = []
  for (const k of kinds) {
    for (const c of AGENTS[k].configFiles) {
      if (c.path.includes('{cwd}')) {
        for (const cwd of cwds.get(k) ?? []) out.push({ agent: k, label: `${c.label} · ${cwd.replace(home, '~')}`, path: expand(c.path, home, cwd), format: c.format })
      } else out.push({ agent: k, label: c.label, path: expand(c.path, home), format: c.format })
    }
  }
  return out
}

export async function listConfigs(hostId: string): Promise<ConfigFile[]> {
  const { host, home } = hostAndHome(hostId)
  const cands = configCandidates(hostId, home)
  if (!cands.length) return []
  const r = await host.exec(cands.map((c) => `if [ -f ${shq(c.path)} ]; then echo "1 $(wc -c < ${shq(c.path)}) $(stat -c %Y ${shq(c.path)} 2>/dev/null || stat -f %m ${shq(c.path)})"; else echo "0 0 0"; fi`).join('; '))
  const rows = r.stdout.trim().split('\n')
  return cands.map((c, i) => {
    const [e, size, mtime] = (rows[i] ?? '0 0 0').split(' ').map(Number)
    return { ...c, exists: e === 1, size: size || 0, mtime: mtime || undefined }
  })
}

function assertConfigPath(hostId: string, path: string) {
  const { home } = hostAndHome(hostId)
  const c = configCandidates(hostId, home).find((x) => x.path === path)
  if (!c) throw new HttpError(403, 'That file is not an agent config file Inyon manages')
  return c
}

export async function readConfig(hostId: string, path: string) {
  assertConfigPath(hostId, path)
  const { host } = hostAndHome(hostId)
  const r = await host.exec(`cat ${shq(path)} 2>/dev/null`)
  return { path, content: r.stdout }
}

/** Validates (JSON), backs the old file up next to it, then replaces it atomically. */
export async function writeConfig(hostId: string, path: string, content: string) {
  const c = assertConfigPath(hostId, path)
  if (c.format === 'json' && content.trim()) {
    try {
      JSON.parse(content)
    } catch (e) {
      throw new HttpError(400, `Not valid JSON: ${(e as Error).message}`)
    }
  }
  const { host } = hostAndHome(hostId)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const p = shq(path)
  const r = await host.exec(
    `umask 077; trap ${shq(`rm -f ${shq(`${path}.inyon-tmp`)}`)} EXIT HUP INT TERM; mkdir -p "$(dirname ${p})" && { [ ! -f ${p} ] || cp ${p} ${shq(`${path}.inyon-bak-${stamp}`)}; } && cat > ${shq(`${path}.inyon-tmp`)} && mv ${shq(`${path}.inyon-tmp`)} ${p} || exit $?; ls -t ${p}.inyon-bak-* 2>/dev/null | tail -n +6 | while IFS= read -r f; do rm -f -- "$f"; done; true`,
    { input: content },
  )
  if (r.code !== 0) throw new HttpError(500, r.stderr.trim() || 'Could not save')
  return { ok: true }
}

// ---------- subagents and background task output ----------

/** An absolute path already in its plain form: no "..", "." or doubled slashes to resolve. */
const isPlainPath = (p: string) =>
  (p.startsWith('/') || /^[A-Za-z]:\//.test(p)) &&
  !/[\0\n]/.test(p) &&
  !p.split('/').slice(1).some((s, i, all) => s === '.' || s === '..' || (s === '' && i < all.length - 1))

/**
 * Transcripts are read from Claude's projects folder only: ~/.claude/projects, or the one a
 * session on that machine uses (CLAUDE_CONFIG_DIR moves it).
 */
function assertTranscriptPath(hostId: string, home: string, p: string) {
  const roots = [`${home}/.claude/projects/`]
  for (const s of registry.get(hostId)?.state.sessions ?? [])
    for (const w of s.windows)
      for (const pane of w.panes) {
        const t = pane.agent?.transcriptPath
        const at = t?.indexOf('/projects/') ?? -1
        if (t && at > 0 && isPlainPath(t)) roots.push(t.slice(0, at + '/projects/'.length))
      }
  if (!/\.jsonl$/.test(p) || !isPlainPath(p) || !roots.some((r) => p.startsWith(r))) throw new HttpError(400, 'Bad transcript path')
}

export async function listSubagents(hostId: string, transcriptPath: string) {
  const { host, home } = hostAndHome(hostId)
  assertTranscriptPath(hostId, home, transcriptPath)
  const dir = `${transcriptPath.replace(/\.jsonl$/, '')}/subagents`
  const r = await host.exec(`for m in ${shq(dir)}/*.meta.json; do [ -f "$m" ] && echo "$(basename "$m" .meta.json)\t$(tr -d '\\n' < "$m")"; done`)
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [id, json] = l.split('\t')
    let meta: any = {}
    try {
      meta = JSON.parse(json)
    } catch {}
    return { agentId: id, toolUseId: meta.toolUseId as string | undefined, type: meta.agentType as string | undefined, description: meta.description as string | undefined, path: `${dir}/${id}.jsonl` }
  })
}

/** A whole (sub)agent transcript as chat items, read once. */
export async function readTranscript(hostId: string, path: string): Promise<ChatItem[]> {
  const { host, home } = hostAndHome(hostId)
  assertTranscriptPath(hostId, home, path)
  const r = await host.exec(`tail -c 3000000 ${shq(path)} 2>/dev/null`, { timeoutMs: 20000 })
  const meta = newMeta()
  const items: ChatItem[] = []
  let seq = 0
  for (const line of r.stdout.split('\n')) {
    if (!line) continue
    try {
      for (const d of normalize(JSON.parse(line), meta, { sidechain: true })) items.push({ ...d, seq: seq++ } as ChatItem)
    } catch {}
  }
  return items.slice(-600)
}

/**
 * Claude's /tmp/…/tasks/<id>.output (macOS: under /var/folders, or /private/tmp), or agy's
 * ~/.gemini/antigravity-cli/brain/<id>/.system_generated/tasks/<task>.log; nowhere else.
 */
export const isTaskFile = (p: string, home?: string) =>
  isPlainPath(p) &&
  ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/', ...(home ? [`${home}/`] : [])].some((root) => p.startsWith(root)) &&
  (/\/tasks\/[\w-]+\.output$/.test(p) || /\/\.gemini\/antigravity-cli\/brain\/[\w-]+\/\.system_generated\/tasks\/[\w-]+\.log$/.test(p))

export async function taskOutput(hostId: string, path: string) {
  const { host, home } = hostAndHome(hostId)
  if (!isTaskFile(path, home)) throw new HttpError(400, 'Not a task output file')
  const r = await host.exec(`tail -c 80000 ${shq(path)} 2>/dev/null; true`)
  return { path, output: r.stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') }
}
