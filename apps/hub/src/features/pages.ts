/**
 * Pages in the Bun hub: the sites agents make (Blueprint plans, mockups) listed from
 * ~/.inyon/pages.json and served from this machine's disk under `/v/<token>/<path>`.
 *
 * pages-core.ts holds the rules both hubs share (tokens, paths, headers); this file adds what
 * only a running hub has: the list file, the epochs that revoke links, progress summaries, the
 * API the app calls, and the `/v/` answer streamed from disk. The list file is the source of
 * truth. `inyon pages add` and Blueprint's publish script write it with no hub running, and the
 * hub reads it again whenever its mtime changes.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { PageEntry, PageList, PageOpen, PageRecord, PageRegister } from '@inyon/protocol'
import { HttpError } from '../hosts/http-error.ts'
import type { Store } from '../platform/store.ts'
import {
  BAD_SLUG,
  CANT_WRITE_LIST,
  decideView,
  goneAfterOpen,
  isSlug,
  LOCAL_HOST,
  mintToken,
  NO_INDEX,
  pagesKey,
  progressSummary,
  sitePathProblem,
  slugify,
  TOKEN_TTL_MS,
  uniqueSlug,
  viewOrigin,
  within,
  type ViewContext,
  type ViewFs,
} from './pages-core.ts'

/** `~/.inyon/pages.json`: always under the home folder (not INYON_DATA_DIR), where the CLI and Blueprint write it. */
export const pagesFile = (home: string) => path.join(home, '.inyon', 'pages.json')
/** The store key (a file in the hub's data folder) that keeps each site's epoch, `{"<host>/<slug>": n}`. */
export const EPOCHS_KEY = 'page-epochs'
/** The store key that keeps what pages.json listed at the last read, `{"<host>/<slug>": added}`. */
export const LISTED_KEY = 'page-listed'
/** A lock older than this was left by a writer that died, and is taken over. */
export const LOCK_STALE_MS = 10_000
/** How long a progress summary is kept before progress.json is read again. */
export const PROGRESS_TTL_MS = 30_000
/** Bigger progress files aren't read for the list. */
const PROGRESS_MAX = 1024 * 1024

export const UNKNOWN_PAGE = 'Unknown page'
export const OTHER_MACHINE = "Pages can only be added on the hub's own machine for now"
export const BROKEN_FILE = "~/.inyon/pages.json isn't a page list Inyon can read. Fix it or delete it, then try again."
export const LOCKED = 'Another program is changing ~/.inyon/pages.json. Try again in a moment.'
export const NOT_SAVED = "The hub couldn't write to its data folder, so the old links stay closed only until it restarts. Check the hub's disk, then revoke again."

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A record as the file has it, when every field has its type and the slug is a slug. */
function asRecord(v: unknown): PageRecord | undefined {
  if (!isObject(v)) return
  const { slug, name, path: p, project, by, added } = v
  if (!isSlug(slug) || typeof name !== 'string' || typeof p !== 'string' || typeof project !== 'string' || typeof by !== 'string') return
  if (typeof added !== 'number' || !Number.isFinite(added)) return
  return { slug, name, path: p, project, by, added }
}

// ---------- the list file ----------

/**
 * ~/.inyon/pages.json, read when its size, mtime or inode changed since the last read. Only the
 * pages that may be served come out of `records()`: well-formed entries whose folder passes the
 * path rules, written and real, with the first of any repeated slug. A missing file is an empty
 * list. Writes go through `update()`, under `pages.json.lock` (created exclusively, taken over
 * after LOCK_STALE_MS), to a temp file renamed over the old one, keeping entries this hub can't
 * read as they were.
 *
 * `onList` hears the list each time it is read again (pageListed() keeps track of what went away).
 */
export function pageRegistry(file: string, home: string, onList: (records: PageRecord[]) => void = () => {}) {
  let seen = ''
  let cached: PageRecord[] = []
  let broken = false
  const realHome = realOr(home)

  /** What is wrong with a folder as a page, by the path as written and by where it really leads. */
  const folderProblem = (p: string) => sitePathProblem(p, home) ?? sitePathProblem(realOr(p), realHome)

  function settle(next: PageRecord[]) {
    cached = next
    onList(next)
  }

  function load() {
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      seen = ''
      broken = false
      settle([])
      return
    }
    const stamp = `${st.ino}:${st.size}:${st.mtimeMs}`
    if (stamp === seen) return
    seen = stamp
    const parsed = parse(fs.readFileSync(file, 'utf8'))
    broken = parsed === undefined
    const slugs = new Set<string>()
    const next: PageRecord[] = []
    for (const raw of parsed?.pages ?? []) {
      const r = asRecord(raw)
      if (!r || slugs.has(r.slug) || folderProblem(r.path)) continue
      slugs.add(r.slug)
      next.push(r)
    }
    settle(next)
  }

  const records = (): PageRecord[] => {
    try {
      load()
    } catch {
      settle([])
    }
    return cached
  }

  return {
    file,
    folderProblem,
    records,
    find: (slug: string) => records().find((r) => r.slug === slug),
    /** Whether the file is there but isn't a list this hub can read (writes are refused then). */
    broken() {
      records()
      return broken
    },
    /**
     * Changes the file under its lock. `change` gets every entry as written (readable or not) and
     * returns the new list, or undefined to leave the file alone.
     */
    async update<T>(change: (pages: unknown[]) => { pages: unknown[]; result: T } | { pages?: undefined; result: T }): Promise<T> {
      return withLock(`${file}.lock`, () => {
        let text: string | undefined
        try {
          text = fs.readFileSync(file, 'utf8')
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
        const current = text === undefined ? { v: 1, pages: [] } : parse(text)
        if (!current) throw new HttpError(500, BROKEN_FILE)
        const out = change(current.pages)
        if (out.pages) writeAtomic(file, JSON.stringify({ ...current, v: 1, pages: out.pages }, null, 2) + '\n')
        return out.result
      })
    },
  }
}

export type PageRegistry = ReturnType<typeof pageRegistry>

/** The file's text as `{v: 1, pages: [...]}`, or undefined when it isn't one. */
function parse(text: string): { v: number; pages: unknown[] } | undefined {
  try {
    const v = JSON.parse(text)
    if (isObject(v) && v.v === 1 && Array.isArray(v.pages)) return v as { v: number; pages: unknown[] }
  } catch {}
}

const realOr = (p: string) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** Writes beside the file and renames over it, so a reader never sees half a list. */
function writeAtomic(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 })
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/**
 * Runs `fn` holding `lock`: an exclusive create, waiting up to 3 s, taking over a lock older than
 * LOCK_STALE_MS. The lock holds this process's id and a random tag, and is removed afterwards only
 * while it still holds them. A failure other than "someone else has it" (a read-only folder, or a
 * stale lock that can't be removed) is thrown at once as CANT_WRITE_LIST, never waited on.
 */
export async function withLock<T>(lock: string, fn: () => T, wait = 3000): Promise<T> {
  const cantWrite = <R>(step: () => R): R => {
    try {
      return step()
    } catch (err) {
      throw errno(err) === 'EEXIST' ? err : new HttpError(500, CANT_WRITE_LIST)
    }
  }
  cantWrite(() => fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 }))
  const until = Date.now() + wait
  const mine = `${process.pid} ${crypto.randomBytes(8).toString('hex')}\n`
  for (;;) {
    try {
      cantWrite(() => {
        const fd = fs.openSync(lock, 'wx', 0o600)
        try {
          fs.writeSync(fd, mine)
        } finally {
          fs.closeSync(fd)
        }
      })
      break
    } catch (err) {
      if (errno(err) !== 'EEXIST') throw err
    }
    if (cantWrite(() => takeOverStale(lock))) continue
    if (Date.now() >= until) throw new HttpError(503, LOCKED)
    await Bun.sleep(25)
  }
  try {
    return fn()
  } finally {
    releaseLock(lock, mine)
  }
}

const errno = (err: unknown) => (err as NodeJS.ErrnoException).code

/**
 * Removes a lock left by a writer that died (older than LOCK_STALE_MS); true when the caller should
 * try to take it again at once. The lock is first renamed aside, and removed only if what was
 * renamed is the file that was judged stale: two writers that both saw it stale can't remove the
 * fresh lock one of them made in between (that one is put back).
 */
export function takeOverStale(lock: string): boolean {
  let old: fs.Stats
  try {
    old = fs.statSync(lock)
  } catch (err) {
    if (errno(err) === 'ENOENT') return true
    throw err
  }
  if (Date.now() - old.mtimeMs <= LOCK_STALE_MS) return false
  removeJudged(lock, old)
  return true
}

/**
 * Removes the lock that was judged stale as `old`, and only that one: renamed aside, then put back
 * if it turns out to be a new lock another writer made since.
 */
export function removeJudged(lock: string, old: fs.Stats) {
  const aside = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`
  try {
    fs.renameSync(lock, aside)
  } catch (err) {
    if (errno(err) === 'ENOENT') return
    throw err
  }
  const got = fs.statSync(aside)
  if (got.ino !== old.ino || got.mtimeMs !== old.mtimeMs) {
    // another writer's new lock: back where it was, unless a third has made one since
    try {
      fs.linkSync(aside, lock)
    } catch {}
  }
  fs.rmSync(aside, { force: true })
}

/** Removes the lock if it is still this writer's. */
export function releaseLock(lock: string, mine: string) {
  try {
    if (fs.readFileSync(lock, 'utf8') === mine) fs.rmSync(lock, { force: true })
  } catch {}
}

// ---------- epochs ----------

/**
 * Each site's epoch, kept in the hub's data folder. A token carries the epoch it was made at, so
 * moving it on (Revoke, or removing the page) ends every link made before.
 */
export function pageEpochs(store: Store) {
  let epochs: Record<string, number> = {}
  const raw = store.get<unknown>(EPOCHS_KEY)
  if (isObject(raw)) for (const [k, v] of Object.entries(raw)) if (Number.isSafeInteger(v) && (v as number) >= 0) epochs[k] = v as number
  return {
    of: (host: string, slug: string) => epochs[`${host}/${slug}`] ?? 0,
    /**
     * Moves a site's epoch on. The running hub refuses the old links at once; when the new epoch
     * can't be saved (a full disk) it throws NOT_SAVED, since a restart would open them again.
     */
    bump(host: string, slug: string) {
      const k = `${host}/${slug}`
      epochs = { ...epochs, [k]: (epochs[k] ?? 0) + 1 }
      try {
        store.set(EPOCHS_KEY, epochs)
      } catch (err) {
        console.error(`couldn't save the page epochs: ${(err as Error).message}`)
        throw new HttpError(500, NOT_SAVED)
      }
      return epochs[k]!
    },
  }
}

/**
 * What the list held when the hub last read it, `{"<host>/<slug>": added}`, kept in the hub's data
 * folder. The CLI and Blueprint take pages off the list without the hub, even while it is stopped;
 * when a slug has gone, or now names a page added at another time, `gone` hears of it so its old
 * links end before a page added again under the same slug could open them.
 */
export function pageListed(store: Store, gone: (slug: string) => void) {
  let last: Record<string, number> = {}
  const raw = store.get<unknown>(LISTED_KEY)
  if (isObject(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') last[k] = v
  return (records: PageRecord[]) => {
    const next: Record<string, number> = {}
    for (const r of records) next[`${LOCAL_HOST}/${r.slug}`] = r.added
    let changed = Object.keys(next).length !== Object.keys(last).length
    for (const [k, added] of Object.entries(last)) {
      if (next[k] === added) continue
      changed = true
      if (k.startsWith(`${LOCAL_HOST}/`)) gone(k.slice(LOCAL_HOST.length + 1))
    }
    if (!changed) return
    last = next
    // a list that can't be saved is still the list: the hub serves it, and checks it again next time
    try {
      store.set(LISTED_KEY, next)
    } catch (err) {
      console.error(`couldn't save the pages listed: ${(err as Error).message}`)
    }
  }
}

// ---------- progress ----------

/** progress.json summaries by folder, each read at most once every PROGRESS_TTL_MS. */
export function progressCache(now: () => number) {
  const cache = new Map<string, { at: number; value: ReturnType<typeof progressSummary> }>()
  return {
    of(folder: string) {
      const hit = cache.get(folder)
      if (hit && now() - hit.at < PROGRESS_TTL_MS) return hit.value
      let value: ReturnType<typeof progressSummary>
      try {
        const file = path.join(folder, 'progress.json')
        if (fs.statSync(file).size <= PROGRESS_MAX) value = progressSummary(JSON.parse(fs.readFileSync(file, 'utf8')))
      } catch {}
      cache.set(folder, { at: now(), value })
      return value
    },
    drop: (folder: string) => void cache.delete(folder),
  }
}

// ---------- disk ----------

/** decideView's disk, through node:fs; both calls follow symlinks. */
export const diskFs: ViewFs = {
  async stat(p) {
    try {
      const s = await fs.promises.stat(p)
      return { file: s.isFile(), dir: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return null
    }
  },
  async realpath(p) {
    try {
      return await fs.promises.realpath(p)
    } catch {
      return null
    }
  },
}

/**
 * Opens a file decideView checked, then makes sure the open file is still inside the site: a
 * folder on the way could have been swapped for a symlink since the check (an agent can rename
 * its own folders). On Linux the system says where the open file really is (/proc/self/fd);
 * elsewhere the path must still have no symlink in it and lead to the same file. Undefined when
 * it can't be opened, isn't a plain file or isn't the site's.
 *
 * O_NONBLOCK keeps a file swapped for a FIFO since the check from holding the open until something
 * writes to it; anything but a plain file is then refused. A plain file reads the same with it set.
 */
export async function openWithin(file: string, site: string): Promise<{ fd: number; size: number } | undefined> {
  let fd: number
  try {
    fd = await fdOpen(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
  } catch {
    return undefined
  }
  try {
    const st = await fdStat(fd)
    if (st.isFile() && (await openedInside(fd, st, file, site))) return { fd, size: st.size }
  } catch {}
  closeFd(fd)
  return undefined
}

// A plain file descriptor, not a FileHandle: Bun throws when the collector finds an open
// FileHandle, which an answer whose client went away before its body was read would leave.
const fdOpen = (file: string, flags: number) => new Promise<number>((ok, no) => fs.open(file, flags, (e, fd) => (e ? no(e) : ok(fd))))
const fdStat = (fd: number) => new Promise<fs.Stats>((ok, no) => fs.fstat(fd, (e, st) => (e ? no(e) : ok(st))))
const fdRead = (fd: number, buf: Uint8Array) => new Promise<number>((ok, no) => fs.read(fd, buf, 0, buf.length, null, (e, n) => (e ? no(e) : ok(n))))
const closeFd = (fd: number) => fs.close(fd, () => {})

async function openedInside(fd: number, st: fs.Stats, file: string, site: string): Promise<boolean> {
  if (process.platform === 'linux') {
    try {
      return within(site, await fs.promises.readlink(`/proc/self/fd/${fd}`))
    } catch {}
  }
  const [real, now] = await Promise.all([fs.promises.realpath(file).catch(() => null), fs.promises.stat(file).catch(() => null)])
  return real === file && now !== null && now.dev === st.dev && now.ino === st.ino && within(site, real)
}

/** Closes the file of a stream that was dropped without being read to its end or cancelled. */
const dropped = new FinalizationRegistry<{ fd: number; closed: boolean }>((held) => {
  if (!held.closed) closeFd(held.fd)
})

/**
 * An open file's bytes to its end, in 64 KB pieces. The file is closed when they're read, when
 * the answer is cancelled, or, for an answer nobody read, when the stream is collected.
 */
function streamOf(fd: number): ReadableStream<Uint8Array> {
  const held = { fd, closed: false }
  const close = () => {
    if (held.closed) return
    held.closed = true
    closeFd(fd)
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const buf = new Uint8Array(64 * 1024)
        const bytesRead = await fdRead(fd, buf)
        if (bytesRead === 0) {
          close()
          c.close()
        } else c.enqueue(buf.subarray(0, bytesRead))
      } catch (err) {
        close()
        c.error(err)
      }
    },
    cancel: close,
  })
  dropped.register(stream, held)
  return stream
}

/**
 * The line git prints for `git -C <folder> rev-parse <option>`, or null. A line starting with '-'
 * is refused: a git too old to know the option prints it back and still exits 0 (git before 2.31
 * does that with --path-format, before 2.5 with --git-common-dir).
 */
function revParse(folder: string, option: string, git: string) {
  try {
    const r = Bun.spawnSync([git, '-C', folder, 'rev-parse', option], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const line = r.exitCode === 0 ? (r.stdout.toString().split(/\r?\n/)[0] ?? '').trim() : ''
    return line && !line.startsWith('-') ? line : null
  } catch {
    return null
  }
}

/**
 * The project a folder belongs to: its git repo's main working tree, or the folder itself. In a
 * linked worktree (an agent's `.claude/worktrees/<name>`, removed once its branch merges) git's
 * common dir is the main tree's `.git`, so the page is grouped under the repo, as the CLI and the
 * Blueprint skill group it. A submodule's common dir (`.git/modules/<name>`) or a bare repo's
 * (`<name>.git`) keeps the top folder. Two plain calls work on any git; the top folder git prints is
 * kept when the common dir's parent is the same folder.
 */
export function projectOf(folder: string, git = 'git') {
  const top = revParse(folder, '--show-toplevel', git)
  if (!top) return folder
  const c = revParse(folder, '--git-common-dir', git)
  const common = c ? path.resolve(folder, c) : null
  if (!common || path.basename(common) !== '.git' || !isDir(common)) return top
  const parent = path.dirname(common)
  try {
    return fs.realpathSync(parent) === fs.realpathSync(top) ? top : parent
  } catch {
    return top
  }
}

function isDir(p: string) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The name and slug in a site's `.inyon-page.json`, when it has a usable one. */
function markerOf(folder: string): { name?: string; slug?: string } {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(folder, '.inyon-page.json'), 'utf8'))
    if (!isObject(m)) return {}
    return {
      ...(typeof m.name === 'string' && m.name.trim() ? { name: m.name.trim().slice(0, 200) } : {}),
      ...(isSlug(m.slug) ? { slug: m.slug } : {}),
    }
  } catch {
    return {}
  }
}

// ---------- the feature ----------

type Handler = (req: Request & { params: Record<string, string> }) => Promise<Response> | Response

export interface PagesOptions {
  /** the hub user's home folder; pages.json is under it */
  home: string
  /** the hub's records, for the epochs */
  store: Store
  /** the secret that signs sessions; a new password makes a new one, which ends every link */
  secret: () => string
  /** the paired phone a request comes from (by its bearer), for phone-bound links */
  phoneOf: (req: Request) => string | undefined
  phonePaired: (id: string) => boolean
  /** a Host the hub answers to (hostnames.ts) */
  knownHost: (host: string) => boolean
  /** whether the request came over https, directly or through a local https proxy */
  secure: (req: Request) => boolean
  now?: () => number
  fs?: ViewFs
}

/** The API routes (to put behind sign-in) and the `/v/` answer, for one hub. */
export function pagesFeature(o: PagesOptions) {
  const now = o.now ?? Date.now
  const epochs = pageEpochs(o.store)
  // a page taken off the list by anyone (the CLI, Blueprint, a hand edit) ends its links
  const registry = pageRegistry(
    pagesFile(o.home),
    o.home,
    pageListed(o.store, (slug) => {
      try {
        epochs.bump(LOCAL_HOST, slug)
      } catch {
        // logged by bump; the running hub refuses the links all the same
      }
    }),
  )
  const progress = progressCache(now)

  const entry = (r: PageRecord): PageEntry => {
    const p = progress.of(r.path)
    return { host: LOCAL_HOST, slug: r.slug, name: r.name, project: r.project, by: r.by, added: r.added, folder: r.path, ...(p ? { progress: p } : {}) }
  }
  const page = (host: string, slug: string) => {
    const r = host === LOCAL_HOST && isSlug(slug) ? registry.find(slug) : undefined
    if (!r) throw new HttpError(404, UNKNOWN_PAGE)
    return r
  }
  const json = (data: unknown, init?: ResponseInit) => Response.json(data, init)
  const readBody = async (req: Request): Promise<Partial<PageRegister>> => {
    if (Number(req.headers.get('content-length') ?? 0) > 16 * 1024) throw new HttpError(413, 'Request too large')
    const text = await req.text()
    if (text.length > 16 * 1024) throw new HttpError(413, 'Request too large')
    try {
      const b = JSON.parse(text || '{}')
      if (isObject(b)) return b as Partial<PageRegister>
    } catch {}
    throw new HttpError(400, 'Invalid JSON')
  }

  const list: Handler = () => json({ pages: registry.records().map(entry) } satisfies PageList)

  const open: Handler = (req) => {
    const r = page(req.params.host!, req.params.slug!)
    const phone = o.phoneOf(req)
    const { token, expires } = mintToken(pagesKey(o.secret()), { h: LOCAL_HOST, s: r.slug, v: epochs.of(LOCAL_HOST, r.slug), ...(phone ? { p: phone } : {}) }, now())
    return json({ url: `/v/${token}/`, expires, ttl: TOKEN_TTL_MS } satisfies PageOpen)
  }

  const revoke: Handler = (req) => {
    const r = page(req.params.host!, req.params.slug!)
    epochs.bump(LOCAL_HOST, r.slug)
    return json({ ok: true })
  }

  const register: Handler = async (req) => {
    const b = await readBody(req)
    if (req.params.host !== LOCAL_HOST) throw new HttpError(404, OTHER_MACHINE)
    const given = typeof b.path === 'string' ? b.path.trim() : ''
    const folder = given.length > 1 ? given.replace(/[\\/]+$/, '') : given
    const problem = registry.folderProblem(folder)
    if (problem) throw new HttpError(400, problem)
    if (b.slug !== undefined && !isSlug(b.slug)) throw new HttpError(400, BAD_SLUG)
    if (b.name !== undefined && typeof b.name !== 'string') throw new HttpError(400, 'The name must be text')
    let index: fs.Stats | undefined
    try {
      index = fs.statSync(path.join(folder, 'index.html'))
    } catch {}
    if (!index?.isFile()) throw new HttpError(400, NO_INDEX)
    const marker = markerOf(folder)
    const asked = b.name?.trim().slice(0, 200)
    const name = asked || marker.name || path.basename(folder)
    const project = projectOf(folder)
    const record = await registry.update<PageRecord>((pages) => {
      const records = pages.map(asRecord)
      const same = records.find((r) => r?.path === folder)
      if (same) {
        if (b.slug !== undefined && b.slug !== same.slug) throw new HttpError(409, `That folder is already a page, as "${same.slug}"`)
        if (!asked || asked === same.name) return { result: same }
        const changed = { ...same, name: asked }
        return { pages: pages.map((p, i) => (records[i] === same ? { ...(p as object), name: asked } : p)), result: changed }
      }
      const taken = (s: string) => records.some((r) => r?.slug === s) || pages.some((p) => isObject(p) && p.slug === s)
      let slug: string
      if (b.slug !== undefined) {
        if (taken(b.slug)) throw new HttpError(409, `There is already a page called "${b.slug}" on this machine`)
        slug = b.slug
      } else slug = uniqueSlug(marker.slug ?? slugify(path.basename(folder)), taken)
      const added: PageRecord = { slug, name, path: folder, project, by: 'app', added: now() }
      return { pages: [...pages, added], result: added }
    })
    progress.drop(record.path)
    return json(entry(record))
  }

  const remove: Handler = async (req) => {
    const { host, slug } = req.params as { host: string; slug: string }
    if (host !== LOCAL_HOST || !isSlug(slug)) throw new HttpError(404, UNKNOWN_PAGE)
    const gone = await registry.update<PageRecord[]>((pages) => {
      const keep = pages.filter((p) => !(isObject(p) && p.slug === slug))
      if (keep.length === pages.length) throw new HttpError(404, UNKNOWN_PAGE)
      return { pages: keep, result: pages.map(asRecord).filter((r): r is PageRecord => r?.slug === slug) }
    })
    // links made before stay dead if the slug is used again (reading the list now reports the slug
    // gone, which moves the epoch on)
    registry.records()
    for (const r of gone) progress.drop(r.path)
    return json({ ok: true })
  }

  const routes = {
    '/api/pages': { GET: list },
    '/api/pages/:host': { POST: register },
    '/api/pages/:host/:slug': { DELETE: remove },
    '/api/pages/:host/:slug/open': { POST: open },
    '/api/pages/:host/:slug/revoke': { POST: revoke },
  }

  const context = (): ViewContext => {
    // read the list first, so a page removed since the last request has its epoch moved on before
    // its token is checked
    registry.records()
    return {
      key: pagesKey(o.secret()),
      now: now(),
      epochOf: epochs.of,
      phonePaired: o.phonePaired,
      siteRoot: (h, s) => (h === LOCAL_HOST ? registry.find(s)?.path : undefined),
      fs: o.fs ?? diskFs,
    }
  }

  /**
   * The answer to a `/v/` request. It never reads the Cookie or Authorization header and never
   * sets a cookie: the token in the path is the only credential. The Host is checked against the
   * names the hub answers to directly, since rightHost() would let a signed-in cookie through.
   */
  async function view(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const host = req.headers.get('host')
    const forwarded = req.headers.get('x-forwarded-host')
    const names = [host, ...(forwarded?.split(',').map((h) => h.trim()) ?? [])].filter((h): h is string => h !== null)
    const answered = names.length > 0 && names.every(o.knownHost)
    const origin = answered ? viewOrigin(forwarded ?? host, o.secure(req)) : null
    const vr = { method: req.method, target: req.url.slice(url.origin.length), origin, ifNoneMatch: req.headers.get('if-none-match') }
    let d = await decideView(vr, context())
    if (d.status === 200) {
      const opened = await openWithin(d.file, d.site)
      if (opened) {
        const headers = new Headers(d.headers)
        // HEAD: Bun leaves the body out; a plain stream (not the file itself) keeps Bun from
        // answering Range requests on its own, which the Rust hub doesn't do either
        if (req.method === 'HEAD') {
          closeFd(opened.fd)
          headers.set('content-length', String(opened.size))
          return new Response(null, { status: 200, headers })
        }
        return new Response(streamOf(opened.fd), { status: 200, headers })
      }
      d = goneAfterOpen(vr)
    }
    return new Response(req.method === 'HEAD' || d.body === '' ? null : d.body, { status: d.status, headers: new Headers(d.headers) })
  }

  return { routes, view, registry, epochs }
}
