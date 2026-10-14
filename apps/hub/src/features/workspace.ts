/**
 * The folder a session works in, as the Files and Changes tabs see it: its files, read only, and
 * its git working tree (what changed since the last commit, whoever changed it), with commit and
 * push. Everything runs as one short shell command on the pane's machine, in the agent's folder.
 */
import { shq } from '../hosts/host.ts'
import { HttpError, registry } from '../hosts/registry.ts'

/** The agent's folder (where it was started), or the pane's shell folder when there's no agent. */
function folder(hostId: string, paneId: string) {
  const rt = registry.get(hostId)
  if (!rt) throw new HttpError(404, 'Unknown machine')
  const f = registry.findPane(hostId, paneId)
  if (!f) throw new HttpError(404, 'Pane not found')
  const cwd = registry.agentProc(hostId, paneId)?.cwd ?? f.pane.cwd
  if (!cwd) throw new HttpError(409, 'Unknown working folder')
  return { host: rt.host, cwd }
}

/** A path inside the folder, relative to it: no "..", no absolute paths, nothing a shell line would split. */
export function inside(rel: unknown) {
  const p = String(rel ?? '').replace(/^\.?\/+/, '').replace(/\/+$/, '')
  if (/[\0\n\r]/.test(p) || p.split('/').some((s) => s === '..') || p.startsWith('/')) throw new HttpError(400, 'Bad path')
  return p
}

// ---------- files ----------

export interface DirEntry {
  name: string
  dir: boolean
  size: number
  /** seconds since 1970 */
  mtime: number
}

const HIDE = new Set(['.git', 'node_modules', '.DS_Store'])

/** One folder's entries, folders first, up to 2000. */
export async function listDir(hostId: string, paneId: string, rel: unknown) {
  const { host, cwd } = folder(hostId, paneId)
  const path = inside(rel)
  const dir = path ? `${cwd}/${path}` : cwd
  // "d|f size mtime name" per entry; GNU stat or BSD stat, whichever is there
  const r = await host.exec(
    `cd ${shq(dir)} 2>/dev/null || { echo 'No such folder' >&2; exit 3; }; for f in .[!.]* ..?* *; do [ -e "$f" ] || [ -L "$f" ] || continue; if [ -d "$f" ]; then t=d; else t=f; fi; s=$(stat -c '%s %Y' -- "$f" 2>/dev/null || stat -f '%z %m' -- "$f" 2>/dev/null || echo '0 0'); printf '%s %s %s\\n' "$t" "$s" "$f"; done | head -2000`,
    { timeoutMs: 15000 },
  )
  if (r.code === 3) throw new HttpError(404, 'No such folder')
  const entries: DirEntry[] = []
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^([df]) (\d+) (\d+) (.+)$/)
    if (!m || HIDE.has(m[4])) continue
    entries.push({ name: m[4], dir: m[1] === 'd', size: Number(m[2]), mtime: Number(m[3]) })
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  return { cwd, path, entries }
}

const TEXT_MAX = 512 * 1024
const IMAGE_MAX = 8 * 1024 * 1024
const IMAGES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' }

export type FileView =
  | { kind: 'text'; path: string; text: string; size: number; truncated: boolean }
  | { kind: 'image'; path: string; type: string; data: string; size: number }
  | { kind: 'binary' | 'large'; path: string; size: number }

/** A file to look at: text (the first 512 KB), an image (up to 8 MB), or just its size. */
export async function readFile(hostId: string, paneId: string, rel: unknown): Promise<FileView> {
  const { host, cwd } = folder(hostId, paneId)
  const path = inside(rel)
  if (!path) throw new HttpError(400, 'Bad path')
  const file = shq(`${cwd}/${path}`)
  const st = await host.exec(`[ -f ${file} ] || exit 3; wc -c < ${file}`, { timeoutMs: 10000 })
  if (st.code === 3) throw new HttpError(404, 'No such file')
  const size = Number(st.stdout.trim()) || 0
  const type = IMAGES[path.split('.').pop()?.toLowerCase() ?? '']
  if (type) {
    if (size > IMAGE_MAX) return { kind: 'large', path, size }
    const r = await host.exec(`base64 < ${file} | tr -d '\\n'`, { timeoutMs: 30000 })
    return { kind: 'image', path, type, data: r.stdout.trim(), size }
  }
  // a NUL byte in the first 8 KB: not text
  const bin = await host.exec(`head -c 8192 ${file} | tr -d '\\000' | wc -c`, { timeoutMs: 10000 })
  if (Number(bin.stdout.trim()) < Math.min(size, 8192)) return { kind: 'binary', path, size }
  const r = await host.exec(`head -c ${TEXT_MAX} ${file}`, { timeoutMs: 30000 })
  return { kind: 'text', path, text: r.stdout, size, truncated: size > TEXT_MAX }
}

// ---------- git ----------

export interface GitFile {
  path: string
  /** where it was before a rename */
  from?: string
  /** M modified, A added, D deleted, R renamed, ? not tracked yet */
  status: 'M' | 'A' | 'D' | 'R' | '?'
  add: number
  del: number
}

export interface GitState {
  repo: boolean
  /** the repository's top folder */
  root?: string
  branch?: string
  /** it has somewhere to push to */
  remote?: boolean
  upstream?: string
  ahead?: number
  behind?: number
  files: GitFile[]
}

const GIT = 'GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git -c core.quotepath=off -c color.ui=false'

/** Reads `git status --porcelain=v1 -z --branch` and `git diff --numstat -z` into a list. */
export function parseStatus(status: string, numstat: string): Omit<GitState, 'repo' | 'root'> {
  const parts = status.split('\0')
  const out: Omit<GitState, 'repo' | 'root'> = { files: [] }
  const head = parts[0]?.startsWith('## ') ? parts.shift()!.slice(3) : ''
  const hm = head.match(/^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/)
  if (hm) {
    out.branch = hm[1] === 'HEAD (no branch)' ? 'detached' : hm[1]
    out.upstream = hm[2]
    out.ahead = Number(hm[3]?.match(/ahead (\d+)/)?.[1] ?? 0)
    out.behind = Number(hm[3]?.match(/behind (\d+)/)?.[1] ?? 0)
  }
  const counts = new Map<string, [number, number]>()
  const ns = numstat.split('\0')
  for (let i = 0; i < ns.length; i++) {
    const m = ns[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/s)
    if (!m) continue
    // a rename is "add\tdel\t" then the old and new paths as their own fields
    const path = m[3] === '' ? ns[(i += 2)] : m[3]
    counts.set(path, [Number(m[1]) || 0, Number(m[2]) || 0])
  }
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]
    if (e.length < 4) continue
    const xy = e.slice(0, 2)
    const path = e.slice(3)
    const from = xy.includes('R') || xy.includes('C') ? parts[++i] : undefined
    const status: GitFile['status'] = xy === '??' ? '?' : xy.includes('R') ? 'R' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : 'M'
    const [add, del] = counts.get(path) ?? [0, 0]
    out.files.push({ path, ...(from ? { from } : {}), status, add, del })
  }
  return out
}

/** The working tree against the last commit: branch, how far from its upstream, and every changed file. */
export async function gitStatus(hostId: string, paneId: string): Promise<GitState> {
  const { host, cwd } = folder(hostId, paneId)
  const sep = '\u0001INYON\u0001'
  const r = await host.exec(
    `cd ${shq(cwd)} 2>/dev/null && command -v git >/dev/null && ${GIT} rev-parse --show-toplevel 2>/dev/null || exit 3; printf '${sep}'; ${GIT} status --porcelain=v1 -z --branch --untracked-files=all 2>/dev/null | head -c 1000000; printf '${sep}'; { ${GIT} diff HEAD --numstat -z 2>/dev/null || ${GIT} diff --cached --numstat -z 2>/dev/null; } | head -c 1000000; printf '${sep}'; ${GIT} remote 2>/dev/null | head -1`,
    { timeoutMs: 20000 },
  )
  if (r.code === 3 || !r.stdout.includes(sep)) return { repo: false, files: [] }
  const [root, status, numstat, remote] = r.stdout.split(sep)
  const s = parseStatus(status ?? '', numstat ?? '')
  return { repo: true, root: root.trim(), remote: !!remote?.trim(), ...s }
}

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

/** A unified diff's hunks, in the shape the app's diff view draws. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  let cur: Hunk | undefined
  for (const line of diff.split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (m) {
      cur = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), lines: [] }
      hunks.push(cur)
    } else if (cur && /^[ +\-\\]/.test(line)) cur.lines.push(line)
  }
  return hunks
}

/** One file's changes since the last commit; a file git doesn't track yet shows as all new. */
export async function gitDiff(hostId: string, paneId: string, rel: unknown) {
  const { host, cwd } = folder(hostId, paneId)
  const path = inside(rel)
  if (!path) throw new HttpError(400, 'Bad path')
  const p = shq(path)
  const r = await host.exec(
    `cd "$(${GIT} -C ${shq(cwd)} rev-parse --show-toplevel)" || exit 3; if ${GIT} ls-files --error-unmatch -- ${p} >/dev/null 2>&1; then ${GIT} diff HEAD --no-ext-diff -U3 -- ${p} 2>/dev/null || ${GIT} diff --cached --no-ext-diff -U3 -- ${p}; else ${GIT} diff --no-index --no-ext-diff -U3 -- /dev/null ${p}; fi | head -c 2000000`,
    { timeoutMs: 20000 },
  )
  if (r.code === 3) throw new HttpError(409, 'Not a git repository')
  return { path, binary: /^Binary files /m.test(r.stdout), hunks: parseHunks(r.stdout) }
}

/**
 * Commits everything in the working tree with your message, as `git add -A && git commit` would.
 * Git's own hooks and signing run as usual; one that needs a password typed fails instead of waiting.
 */
export async function gitCommit(hostId: string, paneId: string, message: unknown) {
  const { host, cwd } = folder(hostId, paneId)
  const msg = String(message ?? '').trim()
  if (!msg) throw new HttpError(400, 'Write a commit message')
  if (msg.length > 10000 || msg.includes('\0')) throw new HttpError(400, 'That message is too long')
  const r = await host.exec(`cd ${shq(cwd)} && ${GIT} add -A && ${GIT} commit -q -F - && ${GIT} log -1 --format=%h`, { input: msg, timeoutMs: 60000 })
  if (r.code !== 0) throw new HttpError(409, (r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n') || 'Could not commit')
  return { commit: r.stdout.trim().split('\n').pop() ?? '' }
}

/** Pushes the branch to its upstream, or to origin under the same name when it has none yet. */
export async function gitPush(hostId: string, paneId: string) {
  const { host, cwd } = folder(hostId, paneId)
  const r = await host.exec(
    `cd ${shq(cwd)} && if ${GIT} rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then ${GIT} push -q; else ${GIT} push -q -u origin HEAD; fi < /dev/null`,
    { timeoutMs: 90000 },
  )
  if (r.code !== 0) throw new HttpError(409, r.stderr.trim().split('\n').slice(-6).join('\n') || 'Could not push')
  return {}
}
