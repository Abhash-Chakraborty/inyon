/**
 * Pages: the rules both hubs share for serving an agent's site under `/v/<token>/<path>`. Tokens,
 * slugs, the path rules and the headers on every `/v/` answer live here, with no I/O of their
 * own: the key, the clock and the file system come in as arguments. crates/inyon-hub ports this
 * file; fixtures/pages (written by `bun apps/hub/src/cli/pages-vectors.ts`) holds what it must
 * produce, byte for byte, so a token one hub mints opens in the other and both answer alike.
 *
 * The threat is the site itself: an agent wrote its HTML and JS and may have been talked into
 * something. So `/v/` never reads a cookie or an Authorization header, never sets a cookie, and
 * every answer (errors and redirects too) carries a CSP sandbox that gives the page an opaque
 * origin and lets it load only from its own token path.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import type { PageProgress } from '@inyon/protocol'

/** The hub's own machine, as a host id. */
export const LOCAL_HOST = 'local'
/** How long a token opens its site. */
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000
/** Longer than any token a hub makes; anything longer is refused before it is looked at. */
const MAX_TOKEN = 2048
/**
 * The most of ~/.inyon/pages.json any reader takes (both hubs, the CLI and Blueprint): a list
 * of a few thousand pages fits, and a bigger file (a sparse one claiming terabytes) counts as a
 * list that can't be read, at once.
 */
export const PAGES_LIST_MAX = 4 * 1024 * 1024
/** How long the `git rev-parse` calls that find a page's project may take, together, before git is stopped. */
export const GIT_TIMEOUT_MS = 3000
/** Set for those calls: no machine-wide git config, and no lock files taken just to look. */
export const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } as const

// ---------- slugs, folders, progress ----------

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
export const isSlug = (s: unknown): s is string => typeof s === 'string' && SLUG_RE.test(s)

export const BAD_SLUG = 'A slug is lowercase letters, digits and dashes, up to 63 characters, starting with a letter or digit'
export const NOT_ABSOLUTE = 'The folder must be an absolute path'
export const TOO_WIDE = "Pick the site's own folder, not / or your home folder"
export const PRIVATE_FOLDER = "Folders under ~/.ssh and ~/.inyon can't be pages"
export const NO_INDEX = 'That folder has no index.html'
/** A 500 from register and delete when ~/.inyon can't be written: a read-only folder, or a stale lock that can't be removed. */
export const CANT_WRITE_LIST = "The hub can't write in ~/.inyon, so it can't change pages.json there. Check that the folder and its pages.json.lock belong to the hub's user, then try again."

/**
 * A slug made from a name: ASCII letters lowercased, every run of anything else (other letters
 * too) one dash, no dash at either end, cut to 63 characters. "page" when nothing is left.
 */
export function slugify(text: string): string {
  const s = text
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '')
  return s || 'page'
}

/** `base`, or `base-2`, `base-3`… (cut so the whole stays 63 characters), whichever is free first. */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base)) return base
  for (let i = 2; ; i++) {
    const suffix = `-${i}`
    const s = base.slice(0, 63 - suffix.length).replace(/-+$/, '') + suffix
    if (!taken(s)) return s
  }
}

/**
 * What is wrong with a folder someone wants as a page, before the disk is asked (the caller still
 * checks that `<path>/index.html` is a file, and says NO_INDEX when it isn't). Null when it may be
 * one. `home` is the hub user's home folder. Paths are compared as written, with trailing slashes
 * dropped; a Windows path (`C:\…`) counts as absolute.
 */
export function sitePathProblem(p: string, home: string): string | null {
  const win = /^[A-Za-z]:[\\/]/.test(p)
  if (!(p.startsWith('/') || win) || /\0/.test(p)) return NOT_ABSOLUTE
  const parts = (s: string) => s.split(win ? /[\\/]+/ : /\/+/).filter(Boolean)
  const segs = parts(p)
  if (segs.some((s) => s === '.' || s === '..')) return NOT_ABSOLUTE
  const homeSegs = parts(home)
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i])
  if (segs.length === 0 || (win && segs.length === 1) || (homeSegs.length > 0 && same(segs, homeSegs))) return TOO_WIDE
  const under = (dir: string) => {
    const d = [...homeSegs, dir]
    return segs.length >= d.length && same(segs.slice(0, d.length), d)
  }
  if (homeSegs.length > 0 && (under('.ssh') || under('.inyon'))) return PRIVATE_FOLDER
  return null
}

/**
 * A progress.json (as Blueprint writes it) counted for the list: tasks over every release, how
 * many are done, and its `now` and `updated` lines when they are strings. Undefined when it isn't
 * an object with a `releases` array. Releases and tasks that aren't objects are skipped.
 */
export function progressSummary(data: unknown): PageProgress | undefined {
  if (!isObject(data) || !Array.isArray(data.releases)) return undefined
  let done = 0
  let total = 0
  for (const r of data.releases) {
    if (!isObject(r) || !Array.isArray(r.tasks)) continue
    for (const t of r.tasks) {
      if (!isObject(t)) continue
      total++
      if (t.status === 'done') done++
    }
  }
  const out: PageProgress = { done, total }
  if (typeof data.now === 'string') out.now = data.now
  if (typeof data.updated === 'string') out.updated = data.updated
  return out
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---------- tokens ----------

/** What a token says: host, slug, expiry (unix ms), the site's epoch, and the phone that asked. */
export interface TokenClaims {
  h: string
  s: string
  x: number
  v: number
  p?: string
}

export type TokenVerdict = 'ok' | 'malformed' | 'bad-signature' | 'expired' | 'revoked' | 'unpaired'

export interface VerifyContext {
  key: Uint8Array
  /** unix ms */
  now: number
  /** the site's current epoch; 0 for a site that never had one */
  epochOf(host: string, slug: string): number
  /** whether a phone with this id is still paired */
  phonePaired(id: string): boolean
}

/** The key tokens are signed with: HMAC-SHA256 keyed with the session secret (its UTF-8 bytes) over "inyon-pages-v1". */
export function pagesKey(sessionSecret: string): Uint8Array {
  return new Uint8Array(crypto.createHmac('sha256', sessionSecret).update('inyon-pages-v1').digest())
}

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString('base64url')
const mac = (key: Uint8Array, payload: string) => b64url(crypto.createHmac('sha256', key).update(`v1.${payload}`).digest())

/**
 * `v1.<payload>.<mac>`: the payload is base64url (no padding) of the claims as JSON, keys in the
 * order h, s, x, v, p; the mac is base64url of HMAC-SHA256(key, "v1." + payload).
 */
export function signToken(key: Uint8Array, claims: TokenClaims): string {
  const { h, s, x, v, p } = claims
  const payload = b64url(JSON.stringify(p === undefined ? { h, s, x, v } : { h, s, x, v, p }))
  return `v1.${payload}.${mac(key, payload)}`
}

/** A token for one site, good for TOKEN_TTL_MS from `now`. */
export function mintToken(key: Uint8Array, site: { h: string; s: string; v: number; p?: string }, now: number) {
  const expires = now + TOKEN_TTL_MS
  return { token: signToken(key, { ...site, x: expires }), expires }
}

const TOKEN_RE = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/
const safeInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const nonEmpty = (s: unknown): s is string => typeof s === 'string' && s.length > 0

/**
 * Checks a token, in this order: its shape (malformed), the mac (bad-signature, compared in
 * constant time, before the payload is read), the claims (malformed: h a non-empty string, s a
 * slug, x and v whole numbers from 0 to 2^53-1, p a non-empty string when present; other keys are
 * ignored), the expiry (expired once now >= x), the epoch (revoked when v isn't the site's), and
 * the phone (unpaired).
 */
export function verifyToken(token: string, ctx: VerifyContext): { verdict: 'ok'; claims: TokenClaims } | { verdict: Exclude<TokenVerdict, 'ok'> } {
  const m = token.length <= MAX_TOKEN ? TOKEN_RE.exec(token) : null
  if (!m) return { verdict: 'malformed' }
  const [, payload, sig] = m as unknown as [string, string, string]
  const want = Buffer.from(mac(ctx.key, payload))
  if (!crypto.timingSafeEqual(want, Buffer.from(sig))) return { verdict: 'bad-signature' }
  let c: unknown
  try {
    c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return { verdict: 'malformed' }
  }
  if (!isObject(c) || !nonEmpty(c.h) || !isSlug(c.s) || !safeInt(c.x) || !safeInt(c.v) || ('p' in c && !nonEmpty(c.p))) return { verdict: 'malformed' }
  const claims: TokenClaims = { h: c.h, s: c.s, x: c.x, v: c.v, ...(nonEmpty(c.p) ? { p: c.p } : {}) }
  if (ctx.now >= claims.x) return { verdict: 'expired' }
  if (claims.v !== ctx.epochOf(claims.h, claims.s)) return { verdict: 'revoked' }
  if (claims.p !== undefined && !ctx.phonePaired(claims.p)) return { verdict: 'unpaired' }
  return { verdict: 'ok', claims }
}

// ---------- request targets and paths ----------

const ONE_DOT = /^(\.|%2e)$/i
const TWO_DOTS = /^(\.|%2e)(\.|%2e)$/i

/**
 * The request target with dot segments resolved the way a browser's URL parser (and so Bun's
 * `req.url`) does: `\` counts as `/`, `.` `%2e` `..` `.%2e` `%2e.` `%2e%2e` in any case are dot
 * segments, `..` stops at the root, and a dot segment at the end leaves a trailing slash. The
 * query is split off unchanged. A hub reading the raw target (the Rust one) must do this first
 * so both see the same path; `/v/<tok>/../x` is then `/v/x`, a token "x" that doesn't verify.
 */
export function normalizeTarget(target: string): { path: string; query: string | null } {
  const q = target.indexOf('?')
  const raw = (q < 0 ? target : target.slice(0, q)).replace(/\\/g, '/')
  const query = q < 0 ? null : target.slice(q + 1)
  const segs = raw.split('/').slice(1)
  const out: string[] = []
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1
    if (TWO_DOTS.test(seg)) {
      out.pop()
      if (last) out.push('')
    } else if (ONE_DOT.test(seg)) {
      if (last) out.push('')
    } else out.push(seg)
  })
  return { path: `/${out.join('/')}`, query }
}

/** Whether a request belongs to `/v/` (after normalizeTarget); the route serves GET and HEAD and answers everything else 405. */
export const isViewPath = (target: string) => normalizeTarget(target).path.startsWith('/v/')

/** `/v/<token><rest>?<query>` taken apart, after normalizeTarget. `rest` is "" or starts with "/". */
export function splitViewTarget(target: string): { token: string; rest: string; query: string | null } | null {
  const { path: p, query } = normalizeTarget(target)
  if (!p.startsWith('/v/')) return null
  const after = p.slice(3)
  const slash = after.indexOf('/')
  return { token: slash < 0 ? after : after.slice(0, slash), rest: slash < 0 ? '' : after.slice(slash), query }
}

/**
 * The path after the token as file names, or null (a 404) when any of them is refused: an empty
 * segment (`a//b`), a bad percent escape or invalid UTF-8, a decoded name holding `/`, `\` or NUL,
 * or one starting with `.` (dot files and folders: `.git`, `.env`, the `.inyon-page.json` marker).
 * `dir` is true when the path ends with `/`, which then means its index.html. `rest` is "/" or
 * longer; "" (no slash after the token) is a redirect, handled before this.
 */
export function viewSegments(rest: string): { segments: string[]; dir: boolean } | null {
  const body = rest.slice(1)
  const dir = body === '' || body.endsWith('/')
  const parts = body === '' ? [] : (dir ? body.slice(0, -1) : body).split('/')
  const segments: string[] = []
  for (const part of parts) {
    let name: string
    try {
      name = decodeURIComponent(part)
    } catch {
      return null
    }
    if (name === '' || name.startsWith('.') || /[/\\\0]/.test(name)) return null
    segments.push(name)
  }
  return { segments, dir }
}

/** A path segment written back as encodeURIComponent writes it. */
const encodeSegment = (s: string) => encodeURIComponent(s)

/**
 * The query kept on a redirect: only when every character is printable ASCII other than
 * `"` `#` `%` `'` `<` `>`. A URL parser rewrites the others as percent escapes (Bun's req.url
 * turns `'` into `%27`), so refusing `%` as well makes a hub that sees the raw target and one
 * that sees the parsed URL agree.
 */
const keptQuery = (q: string | null) => (q && /^[\x21\x24\x26\x28-\x3b\x3d\x3f-\x7e]+$/.test(q) ? `?${q}` : '')

// ---------- files ----------

/** The content type for a file, by its extension (case ignored). Markdown and text are served as plain text. */
export function contentType(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

/** The table index.ts and static_files.rs use for the app, with md and txt as plain text. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html;charset=utf-8',
  htm: 'text/html;charset=utf-8',
  js: 'text/javascript;charset=utf-8',
  mjs: 'text/javascript;charset=utf-8',
  css: 'text/css;charset=utf-8',
  json: 'application/json;charset=utf-8',
  map: 'application/json;charset=utf-8',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain;charset=utf-8',
  md: 'text/plain;charset=utf-8',
  xml: 'application/xml',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
}

/** progress.json is read every 20 seconds and must never come from a cache; everything else is checked with its ETag. */
export const noStore = (name: string) => name === 'progress.json'

/** `"<size in hex>-<mtime in whole ms, hex>"` */
export const etagOf = (size: number, mtimeMs: number) => `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`

/** If-None-Match against an ETag: `*`, or any listed tag equal to it (a `W/` prefix ignored). */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false
  if (ifNoneMatch.trim() === '*') return true
  return ifNoneMatch.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)
}

// ---------- headers ----------

/**
 * The origin to write into the CSP, from the Host the hub answered to (X-Forwarded-Host first, as
 * sameOrigin reads it) and whether the request came over https. Null for a host that isn't a
 * plain name, IPv4 or bracketed IPv6 with an optional port; lowercased otherwise.
 */
export function viewOrigin(host: string | null | undefined, https: boolean): string | null {
  if (!host || !/^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?$/.test(host)) return null
  return `${https ? 'https' : 'http'}://${host.toLowerCase()}`
}

/**
 * The sandbox flags. allow-forms lets a page's own script handle a form (a mockup's "Add" field):
 * without it the browser drops the submit before any handler runs. form-action 'none' in the CSP
 * still stops a form from sending anything anywhere.
 *
 * There is no allow-same-origin, and never may be: the opaque origin is also what keeps password
 * managers away from a page served at the hub's own address. Chrome gives a frame with an opaque
 * origin no password manager at all (Blink's CanAccessPasswordManager), and Firefox's runs no code
 * in a document with a null principal, so neither fills or saves the hub password on /v/, framed,
 * in its own tab or in a popup (a popup keeps the sandbox: no allow-popups-to-escape-sandbox).
 */
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-downloads'

/**
 * The Content-Security-Policy on every `/v/` answer. With an origin and a verified token, the page
 * may load only from `<origin>/v/<token>/`; without one (an error before the token checked out)
 * it may load nothing but inline styles.
 *
 * There is no frame-ancestors on purpose. The sandbox gives every page an opaque origin, and a
 * browser matches no frame-ancestors source (not even `*`) against an opaque parent, so a site
 * framing its own files (Blueprint's mockup viewer and its screens) would break. Framing needs the
 * token URL anyway, and the framed page is still sandboxed.
 */
export function viewCsp(origin: string | null, token: string | null): string {
  const tail = "object-src 'none'; base-uri 'none'; form-action 'none'"
  if (!origin || !token) return `${SANDBOX}; default-src 'none'; style-src 'unsafe-inline'; ${tail}`
  const b = `${origin}/v/${token}/`
  return [
    SANDBOX,
    "default-src 'none'",
    `script-src ${b} 'unsafe-inline'`,
    `style-src ${b} 'unsafe-inline'`,
    `img-src ${b} data: blob:`,
    `font-src ${b} data:`,
    `media-src ${b}`,
    `connect-src ${b}`,
    `frame-src ${b}`,
    tail,
  ].join('; ')
}

export type HeaderList = [name: string, value: string][]

export interface ViewHeaderInput {
  origin: string | null
  /** the token, once it verified; null before that */
  token: string | null
  cache: 'no-cache' | 'no-store'
  type?: string
  etag?: string
  location?: string
  allow?: string
}

/**
 * Every header a `/v/` answer carries, lowercase, in this order; the hub adds only what its server
 * adds by itself (date, content-length). The one place these are made, for every status.
 */
export function viewHeaders(o: ViewHeaderInput): HeaderList {
  const h: HeaderList = [
    ['content-security-policy', viewCsp(o.origin, o.token)],
    ['access-control-allow-origin', '*'],
    ['referrer-policy', 'no-referrer'],
    ['x-content-type-options', 'nosniff'],
    // no DNS lookups for links the page shows: a host name can carry data out
    ['x-dns-prefetch-control', 'off'],
    ['cache-control', o.cache],
  ]
  if (o.type) h.push(['content-type', o.type])
  if (o.etag) h.push(['etag', o.etag])
  if (o.location) h.push(['location', o.location])
  if (o.allow) h.push(['allow', o.allow])
  return h
}

// ---------- error pages ----------

export type ViewErrorStatus = 403 | 404 | 405 | 413 | 421

const ERRORS: Record<ViewErrorStatus, [title: string, text: string]> = {
  403: ['Link expired', 'Open the page again from Inyon.'],
  404: ['Not found', 'This page has no file at that address.'],
  405: ['Read only', 'Pages can be read, nothing else.'],
  413: ['Too big', 'This file is too big to show here.'],
  421: ['Wrong address', "This hub doesn't answer to that address. If it's yours, add it to INYON_ALLOWED_HOSTS on the hub."],
}

/** The small HTML page sent with an error. Light or dark with the system, no scripts. */
export function errorPage(status: ViewErrorStatus): string {
  const [title, text] = ERRORS[status]
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${title}</title>` +
    '<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}main{max-width:32rem;padding:24px}h1{font-size:18px;margin:0 0 4px}p{margin:0;opacity:.7}</style>' +
    `<main><h1>${title}</h1><p>${text}</p></main></html>\n`
  )
}

// ---------- one request ----------

export interface ViewRequest {
  method: string
  /** the raw request target: path and query as received (Bun's req.url without its origin is fine) */
  target: string
  /** viewOrigin() of the request, or null when the hub doesn't answer to its Host (421) */
  origin: string | null
  ifNoneMatch?: string | null
}

/** What decideView needs from the disk; null when the path doesn't exist. Both follow symlinks. */
export interface ViewFs {
  stat(p: string): Promise<{ file: boolean; dir: boolean; size: number; mtimeMs: number } | null>
  realpath(p: string): Promise<string | null>
}

export interface ViewContext extends VerifyContext {
  /** the folder of a site this hub serves from its own disk, or undefined */
  siteRoot(host: string, slug: string): string | undefined
  fs: ViewFs
}

/**
 * What to answer. 200 names the file to stream (its real path) and the site's real folder it was
 * checked against; the others carry their whole body ("" for 301 and 304). On HEAD the hub sends
 * the same status and headers with no body.
 */
export type ViewDecision =
  | { status: 200; headers: HeaderList; file: string; size: number; site: string }
  | { status: 301 | 304; headers: HeaderList; body: '' }
  | { status: ViewErrorStatus; headers: HeaderList; body: string }

/** The real path is the site's root or inside it, with no dot-named folder or file on the way. */
export function within(root: string, real: string) {
  const rel = path.relative(root, real)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  return rel.split(/[\\/]/).every((s) => s !== '..' && !s.startsWith('.'))
}

/**
 * One `/v/` request, start to end: the Host (421), the method (405), the token (403), the site
 * (404 when this hub doesn't serve it), the trailing slash after the token (301), the path rules
 * (404), the disk (a folder without its slash: 301; a folder without index.html, anything missing,
 * anything whose real path leaves the site or passes a dot name: 404), then the cache (304) or the
 * file (200).
 */
export async function decideView(req: ViewRequest, ctx: ViewContext): Promise<ViewDecision> {
  const fail = (status: ViewErrorStatus, token: string | null = null, extra: Partial<ViewHeaderInput> = {}) => failure(req.origin, status, token, extra)
  if (req.origin === null) return fail(421)
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, null, { allow: 'GET, HEAD' })
  const t = splitViewTarget(req.target)
  if (!t) return fail(404)
  const v = verifyToken(t.token, ctx)
  if (v.verdict !== 'ok') return fail(403)
  const { token } = t
  const root = ctx.siteRoot(v.claims.h, v.claims.s)
  if (root === undefined) return fail(404, token)
  const redirect = (segments: string[]): ViewDecision => ({
    status: 301,
    headers: viewHeaders({
      origin: req.origin,
      token,
      cache: 'no-store',
      location: `/v/${token}/${segments.map((s) => `${encodeSegment(s)}/`).join('')}${keptQuery(t.query)}`,
    }),
    body: '',
  })
  if (t.rest === '') return redirect([])
  const plan = viewSegments(t.rest)
  if (!plan) return fail(404, token)

  const siteReal = await ctx.fs.realpath(root)
  if (siteReal === null) return fail(404, token)
  let real = await ctx.fs.realpath(path.join(root, ...plan.segments))
  if (real === null || !within(siteReal, real)) return fail(404, token)
  let st = await ctx.fs.stat(real)
  let name = plan.segments.at(-1) ?? 'index.html'
  if (st?.dir) {
    if (!plan.dir) return redirect(plan.segments)
    real = await ctx.fs.realpath(path.join(real, 'index.html'))
    if (real === null || !within(siteReal, real)) return fail(404, token)
    st = await ctx.fs.stat(real)
    name = 'index.html'
  } else if (plan.dir) return fail(404, token)
  if (!st?.file) return fail(404, token)

  const type = contentType(name)
  if (noStore(name)) return { status: 200, headers: viewHeaders({ origin: req.origin, token, cache: 'no-store', type }), file: real, size: st.size, site: siteReal }
  const etag = etagOf(st.size, st.mtimeMs)
  if (etagMatches(req.ifNoneMatch, etag)) return { status: 304, headers: viewHeaders({ origin: req.origin, token, cache: 'no-cache', etag }), body: '' }
  return { status: 200, headers: viewHeaders({ origin: req.origin, token, cache: 'no-cache', type, etag }), file: real, size: st.size, site: siteReal }
}

function failure(origin: string | null, status: ViewErrorStatus, token: string | null, extra: Partial<ViewHeaderInput> = {}): ViewDecision {
  return { status, headers: viewHeaders({ origin, token, cache: 'no-store', type: 'text/html;charset=utf-8', ...extra }), body: errorPage(status) }
}

/**
 * The 404 for a 200 whose file, once opened, turned out not to be the one decideView checked: a
 * folder on the way was swapped for a symlink in between. The hub opens the file and then asks the
 * system where the open file really is, so a swap can't lead it out of the site.
 */
export function goneAfterOpen(req: ViewRequest): Extract<ViewDecision, { status: ViewErrorStatus }> {
  return failure(req.origin, 404, splitViewTarget(req.target)?.token ?? null) as Extract<ViewDecision, { status: ViewErrorStatus }>
}
