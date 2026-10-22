// Rewrites fixtures/pages/*.json from pages-core.ts: `bun apps/hub/src/cli/pages-vectors.ts`. Both
// hubs are tested against these files (tokens, the rules, and the exact status and headers for a
// list of requests against fixtures/pages/site), so a token one hub mints opens in the other and
// both answer every /v/ request alike. Every input is fixed, so running it twice writes the same
// bytes; pages-core.test.ts fails when the files and this script disagree.
import crypto from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decideView,
  errorPage,
  mintToken,
  pagesKey,
  PAGES_LIST_MAX,
  progressSummary,
  etagOf,
  sitePathProblem,
  slugify,
  TOKEN_TTL_MS,
  uniqueSlug,
  verifyToken,
  viewOrigin,
  isSlug,
  type ViewContext,
  type ViewErrorStatus,
  type ViewFs,
} from '../features/pages-core.ts'

export const PAGES_FIXTURES = new URL('../../../../fixtures/pages/', import.meta.url)
export const serialize = (v: unknown) => JSON.stringify(v, null, 1) + '\n'

/** The session secret the vectors' key comes from, and the clock they run at. */
export const SECRET = 'fixture-session-secret: not a real one'
export const NOW = 1_792_320_000_000
const HOUR = 60 * 60 * 1000
const key = pagesKey(SECRET)
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const b64 = (s: string) => Buffer.from(s).toString('base64url')

/** The site the fixture tokens open, and the state of the hub they verify against. */
export const SITE = { h: 'local', s: 'fixture' }
export const EPOCHS: Record<string, number> = { 'local/fixture': 3 }
export const PHONES = ['ph1']
const epochOf = (h: string, s: string) => EPOCHS[`${h}/${s}`] ?? 0
const phonePaired = (id: string) => PHONES.includes(id)

/** A token signed with the fixture key over any payload text, for the vectors a hub would never make. */
const signRaw = (payload: string) => {
  const p = b64(payload)
  return `v1.${p}.${crypto.createHmac('sha256', key).update(`v1.${p}`).digest('base64url')}`
}

/** Fixed tokens, by name, that tokens.json and responses.json both use. */
export function namedTokens() {
  const at = (now: number, extra: Partial<{ v: number; p: string; s: string }> = {}) => mintToken(key, { ...SITE, v: 3, ...extra }, now).token
  const valid = at(NOW - HOUR)
  const [, payload, sig] = valid.split('.') as [string, string, string]
  const longer = JSON.parse(Buffer.from(payload, 'base64url').toString())
  longer.x += 24 * HOUR
  return {
    valid,
    phone: at(NOW - HOUR, { p: 'ph1' }),
    unpaired: at(NOW - HOUR, { p: 'ph9' }),
    expired: at(NOW - 13 * HOUR),
    expiresNow: at(NOW - TOKEN_TTL_MS),
    lastMs: at(NOW - TOKEN_TTL_MS + 1),
    revoked: at(NOW - HOUR, { v: 2 }),
    unknownSite: at(NOW - HOUR, { s: 'gone', v: 0 }),
    tamperedPayload: `v1.${b64(JSON.stringify(longer))}.${sig}`,
    tamperedSignature: `v1.${payload}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`,
    otherKey: mintToken(pagesKey('another secret'), { ...SITE, v: 3 }, NOW - HOUR).token,
  }
}

function tokenVectors() {
  const t = namedTokens()
  const x = NOW + HOUR
  const signed = (name: string, payload: string) => ({ name, token: signRaw(payload) })
  const verify = [
    { name: 'valid', token: t.valid },
    { name: 'valid, minted by a phone that is still paired', token: t.phone },
    { name: 'one millisecond left', token: t.lastMs },
    { name: 'a site with no epoch yet counts as epoch 0', token: t.unknownSite },
    { name: 'expires exactly now', token: t.expiresNow },
    { name: 'expired an hour ago', token: t.expired },
    { name: 'revoked: an older epoch', token: t.revoked },
    { name: 'minted by a phone that was unpaired', token: t.unpaired },
    { name: 'payload changed, old mac', token: t.tamperedPayload },
    { name: 'mac changed', token: t.tamperedSignature },
    { name: 'signed with another key', token: t.otherKey },
    { name: 'empty', token: '' },
    { name: 'no version', token: t.valid.slice(3) },
    { name: 'version 2', token: `v2${t.valid.slice(2)}` },
    { name: 'two parts', token: t.valid.split('.').slice(0, 2).join('.') },
    { name: 'four parts', token: `${t.valid}.x` },
    { name: 'mac one character short', token: t.valid.slice(0, -1) },
    { name: 'padding in the payload', token: t.valid.replace(/^v1\.([^.]+)\./, 'v1.$1=.') },
    { name: 'plain base64 characters', token: t.valid.replace(/^v1\.(.)/, 'v1.+') },
    { name: 'longer than 2048 characters', token: signRaw(JSON.stringify({ ...SITE, x, v: 3, pad: 'a'.repeat(1600) })) },
    signed('signed, but not JSON', 'hello'),
    signed('signed, but an array', JSON.stringify([SITE.h, SITE.s, x, 3])),
    signed('signed, no epoch', JSON.stringify({ ...SITE, x })),
    signed('signed, empty host', JSON.stringify({ h: '', s: 'fixture', x, v: 3 })),
    signed('signed, slug not a slug', JSON.stringify({ h: 'local', s: 'Fixture', x, v: 3 })),
    signed('signed, expiry a fraction', JSON.stringify({ ...SITE, x: x + 0.5, v: 3 })),
    signed('signed, expiry a string', JSON.stringify({ ...SITE, x: String(x), v: 3 })),
    signed('signed, expiry past 2^53', `{"h":"local","s":"fixture","x":18014398509481984,"v":3}`),
    signed('signed, negative epoch', JSON.stringify({ ...SITE, x, v: -1 })),
    signed('signed, phone null', JSON.stringify({ ...SITE, x, v: 3, p: null })),
    signed('signed, phone empty', JSON.stringify({ ...SITE, x, v: 3, p: '' })),
    signed('signed, an unknown key is ignored', JSON.stringify({ ...SITE, x, v: 3, z: 1 })),
  ].map((c) => {
    const r = verifyToken(c.token, { key, now: NOW, epochOf, phonePaired })
    return { ...c, verdict: r.verdict, ...(r.verdict === 'ok' ? { claims: r.claims } : {}) }
  })
  const mint = [
    { h: 'local', s: 'fixture', v: 3 },
    { h: 'local', s: 'fixture', v: 3, p: 'ph1' },
    { h: 'laptop', s: 'a', v: 0 },
    { h: 'local', s: `x${'-9'.repeat(31)}`, v: 9_007_199_254_740_991 },
  ].map((site) => ({ site, now: NOW, ...mintToken(key, site, NOW) }))
  return {
    about:
      'Pages tokens. key = HMAC-SHA256(utf8(secret), "inyon-pages-v1"), hex. mint: what mintToken(key, site, now) returns. verify: verifyToken(token, {key, now, epochOf, phonePaired}) with epochs (by "host/slug", 0 when missing) and the paired phones below.',
    secret: SECRET,
    key: hex(key),
    now: NOW,
    ttl: TOKEN_TTL_MS,
    epochs: EPOCHS,
    phones: PHONES,
    mint,
    verify,
  }
}

function ruleVectors() {
  const home = '/home/abhash'
  return {
    about: 'Pure rules both hubs and the CLI share: slugify, isSlug, uniqueSlug (taken = the listed slugs), sitePathProblem (null when the folder may be a page), progressSummary (null when it gives undefined), listMax (the most bytes of pages.json any reader takes).',
    listMax: PAGES_LIST_MAX,
    slugify: ['Inyon plan', 'Handy redesign', '  --Café: v2.0!--  ', '', '!!!', 'ABC def_ghi', 'a'.repeat(70), `${'b'.repeat(62)} c`, 'ąęł 日本'].map((text) => ({ text, slug: slugify(text) })),
    isSlug: ['ghostex', 'a', '0', 'a-b-c', 'x'.repeat(63), 'x'.repeat(64), '-a', 'A', 'a_b', 'a.b', '', 'a b', 'ünï'].map((s) => ({ s, ok: isSlug(s) })),
    uniqueSlug: [
      { base: 'plan', taken: [] },
      { base: 'plan', taken: ['plan'] },
      { base: 'plan', taken: ['plan', 'plan-2', 'plan-3'] },
      { base: 'x'.repeat(63), taken: ['x'.repeat(63)] },
      { base: `${'y'.repeat(61)}-z`, taken: [`${'y'.repeat(61)}-z`] },
    ].map((c) => ({ ...c, slug: uniqueSlug(c.base, (s) => c.taken.includes(s)) })),
    sitePath: [
      `${home}/development/custom-tmux/private/plans/ghostex`,
      `${home}/development/handy-redesign/`,
      'relative/site',
      '/',
      '//',
      home,
      `${home}/`,
      `${home}/.ssh`,
      `${home}/.ssh/site`,
      `${home}/.inyon/pages`,
      `${home}/.inyonx/site`,
      `${home}/a/../b`,
      `${home}/./b`,
      '/srv/site',
      'C:\\Users\\abhash\\site',
      'C:\\',
    ].map((p) => ({ path: p, home, problem: sitePathProblem(p, home) })),
    progress: [
      JSON.parse(readSite('progress.json')),
      { releases: [] },
      { now: 'x', updated: 5, releases: [{ tasks: [{ status: 'done' }, { status: 'doing' }, 'junk', null] }, 'junk', { tasks: 'none' }] },
      { now: 'no releases' },
      [],
      null,
      'text',
    ].map((data) => ({ data, summary: progressSummary(data) ?? null })),
  }
}

const readSite = (rel: string) => readFileSync(new URL(`site/${rel}`, PAGES_FIXTURES), 'utf8')

// ---------- the fixture site on disk ----------

/** Every file's mtime in the copy, so ETags are the same on every machine. */
export const MTIME_MS = NOW - 24 * HOUR
/** Files beside the copy, outside the site, that symlinks inside it point at. */
export const OUTSIDE: Record<string, string> = { 'secret.html': '<!doctype html><title>Outside</title><p>Outside the site: never served.</p>\n' }
/** Symlinks made in the copy: name inside the site → target, as written. */
export const SYMLINKS: Record<string, string> = {
  'inside-link.html': 'index.html',
  'outside-link.html': '../outside/secret.html',
  'outside-dir': '../outside',
  'dot-link.txt': '.draft.md',
}

/**
 * Lays the fixture site out under `dir` as responses.json expects it: `dir/site` (a copy of
 * fixtures/pages/site plus SYMLINKS) and `dir/outside` (OUTSIDE), every file's mtime MTIME_MS.
 * Returns the site's folder.
 */
export function layOutFixtureSite(dir: string): string {
  const site = join(dir, 'site')
  cpSync(new URL('site/', PAGES_FIXTURES), site, { recursive: true })
  mkdirSync(join(dir, 'outside'), { recursive: true })
  for (const [name, text] of Object.entries(OUTSIDE)) writeFileSync(join(dir, 'outside', name), text)
  for (const [name, target] of Object.entries(SYMLINKS)) symlinkSync(target, join(site, name))
  const t = MTIME_MS / 1000
  const touch = (p: string) => {
    for (const f of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, f.name)
      if (f.isSymbolicLink()) continue
      if (f.isDirectory()) touch(full)
      else utimesSync(full, t, t)
    }
  }
  touch(dir)
  return site
}

/** decideView's disk, read through node:fs (both calls follow symlinks). */
export const nodeViewFs: ViewFs = {
  async stat(p) {
    try {
      const s = await stat(p)
      return { file: s.isFile(), dir: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return null
    }
  },
  async realpath(p) {
    try {
      return await realpath(p)
    } catch {
      return null
    }
  },
}

// ---------- requests against it ----------

export const HOST = 'hub.test:4777'
export const WRONG_HOST = 'evil.test'
/** What the hub adds by itself, so the comparison leaves it out. */
export const IGNORED_HEADERS = ['date', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']

interface Case {
  name: string
  method?: string
  target: string
  headers?: Record<string, string>
}

function cases(t: ReturnType<typeof namedTokens>, etagOfIndex: string): Case[] {
  const v = t.valid
  return [
    { name: 'no slash after the token', target: `/v/${v}` },
    { name: 'no slash after the token, with a query', target: `/v/${v}?theme=dark` },
    { name: 'a query a URL parser would rewrite is dropped', target: `/v/${v}?q='x'` },
    { name: 'a query with a percent escape is dropped too (a parser makes them)', target: `/v/${v}?q=%27x%27` },
    { name: 'root', target: `/v/${v}/` },
    { name: 'root, HEAD', method: 'HEAD', target: `/v/${v}/` },
    { name: 'root with a query', target: `/v/${v}/?theme=light` },
    { name: 'index.html by name', target: `/v/${v}/index.html` },
    { name: 'stylesheet', target: `/v/${v}/style.css` },
    { name: 'folder without its slash', target: `/v/${v}/sub` },
    { name: 'folder', target: `/v/${v}/sub/` },
    { name: 'image', target: `/v/${v}/img/dot.png` },
    { name: 'markdown is plain text', target: `/v/${v}/notes.md` },
    { name: 'progress.json is never cached', target: `/v/${v}/progress.json` },
    { name: 'progress.json ignores If-None-Match', target: `/v/${v}/progress.json`, headers: { 'if-none-match': '*' } },
    { name: 'If-None-Match matches', target: `/v/${v}/index.html`, headers: { 'if-none-match': etagOfIndex } },
    { name: 'If-None-Match matches weakly, in a list', target: `/v/${v}/index.html`, headers: { 'if-none-match': `"nope", W/${etagOfIndex}` } },
    { name: 'If-None-Match on the root', target: `/v/${v}/`, headers: { 'if-none-match': etagOfIndex } },
    { name: 'If-None-Match differs', target: `/v/${v}/index.html`, headers: { 'if-none-match': '"0-0"' } },
    { name: 'HEAD with a matching If-None-Match', method: 'HEAD', target: `/v/${v}/index.html`, headers: { 'if-none-match': etagOfIndex } },
    { name: 'the marker', target: `/v/${v}/.inyon-page.json` },
    { name: 'a dot file', target: `/v/${v}/.draft.md` },
    { name: 'a dot file, encoded', target: `/v/${v}/%2edraft.md` },
    { name: 'a dot folder', target: `/v/${v}/.hidden/note.html` },
    { name: 'dot segments inside the site resolve', target: `/v/${v}/sub/../index.html` },
    { name: 'encoded dot segments inside the site resolve', target: `/v/${v}/sub/%2e%2e/notes.md` },
    { name: 'a single dot segment', target: `/v/${v}/./sub/./` },
    { name: 'dot segments climbing out of the token', target: `/v/${v}/../index.html` },
    { name: 'encoded dot segments climbing out of the token', target: `/v/${v}/%2e%2E/index.html` },
    { name: 'an encoded slash', target: `/v/${v}/sub%2findex.html` },
    { name: 'an encoded backslash', target: `/v/${v}/sub%5cindex.html` },
    { name: 'an encoded NUL', target: `/v/${v}/index.html%00` },
    { name: 'a bad escape', target: `/v/${v}/%zz` },
    { name: 'invalid UTF-8', target: `/v/${v}/%ff.html` },
    { name: 'an empty segment', target: `/v/${v}//index.html` },
    { name: 'a file with a slash after it', target: `/v/${v}/index.html/` },
    { name: 'a missing file', target: `/v/${v}/nope.html` },
    { name: 'a folder with no index.html', target: `/v/${v}/empty/` },
    { name: 'a folder with no index.html, no slash', target: `/v/${v}/empty` },
    { name: 'a file in that folder', target: `/v/${v}/empty/data.json` },
    { name: 'a symlink to a file inside the site', target: `/v/${v}/inside-link.html` },
    { name: 'a symlink to a file outside the site', target: `/v/${v}/outside-link.html` },
    { name: 'a symlink to a folder outside the site', target: `/v/${v}/outside-dir/secret.html` },
    { name: 'a symlink to a folder outside the site, no slash', target: `/v/${v}/outside-dir` },
    { name: 'a symlink to a dot file inside the site', target: `/v/${v}/dot-link.txt` },
    { name: 'a cookie and a bearer change nothing', target: `/v/${v}/`, headers: { cookie: 'inyon_session=x.y', authorization: 'Bearer abc' } },
    { name: 'a cookie does not open a bad token', target: `/v/${t.expired}/`, headers: { cookie: 'inyon_session=x.y' } },
    { name: 'a phone token, phone still paired', target: `/v/${t.phone}/` },
    { name: 'a phone token, phone unpaired', target: `/v/${t.unpaired}/` },
    { name: 'expired token', target: `/v/${t.expired}/` },
    { name: 'expired token, HEAD', method: 'HEAD', target: `/v/${t.expired}/` },
    { name: 'revoked token', target: `/v/${t.revoked}/index.html` },
    { name: 'payload changed', target: `/v/${t.tamperedPayload}/` },
    { name: 'mac changed', target: `/v/${t.tamperedSignature}/` },
    { name: 'not a token', target: '/v/garbage/' },
    { name: 'no token', target: '/v/' },
    { name: 'a site this hub does not serve', target: `/v/${t.unknownSite}/` },
    { name: 'POST', method: 'POST', target: `/v/${v}/` },
    { name: 'OPTIONS', method: 'OPTIONS', target: `/v/${v}/index.html` },
    { name: 'a Host the hub does not answer to', target: `/v/${v}/`, headers: { host: WRONG_HOST } },
  ]
}

async function responseVectors() {
  const t = namedTokens()
  const dir = mkdtempSync(join(tmpdir(), 'inyon-pages-vectors-'))
  try {
    const site = layOutFixtureSite(dir)
    const siteReal = realpathSync(site)
    const index = statSync(join(site, 'index.html'))
    const etagOfIndex = etagOf(index.size, index.mtimeMs)
    const ctx: ViewContext = {
      key,
      now: NOW,
      epochOf,
      phonePaired,
      siteRoot: (h, s) => (h === SITE.h && s === SITE.s ? site : undefined),
      fs: nodeViewFs,
    }
    const out = []
    for (const c of cases(t, etagOfIndex)) {
      const method = c.method ?? 'GET'
      const host = c.headers?.host ?? HOST
      const known = host === HOST
      const d = await decideView({ method, target: c.target, origin: known ? viewOrigin(host, false) : null, ifNoneMatch: c.headers?.['if-none-match'] }, ctx)
      const body = method === 'HEAD' ? null : d.status === 200 ? { file: `site/${d.file.slice(siteReal.length + 1).split('\\').join('/')}` } : d.body === '' ? null : { page: d.status as ViewErrorStatus }
      out.push({
        name: c.name,
        request: { method, target: c.target, headers: { host, ...c.headers } },
        response: { status: d.status, headers: Object.fromEntries(d.headers), body },
      })
    }
    return {
      about:
        'What a hub answers to each request against fixtures/pages/site. Lay the site out as `setup` says (bun: layOutFixtureSite in apps/hub/src/cli/pages-vectors.ts), serve it as the page context.site with the context below (key, now, epochs, phones from tokens.json), accept the Host context.host over plain http and refuse context.wrongHost, and send each request as raw bytes (a client would resolve the dot segments itself). The response must have exactly this status and these headers, apart from ignoredHeaders. body: null is empty, {file} is that file under fixtures/pages, {page} is errorPages[status].',
      setup: { copy: 'site', to: '<dir>/site', outside: OUTSIDE, outsideDir: '<dir>/outside', symlinks: SYMLINKS, mtimeMs: MTIME_MS },
      context: { host: HOST, wrongHost: WRONG_HOST, origin: viewOrigin(HOST, false), site: SITE, now: NOW },
      ignoredHeaders: IGNORED_HEADERS,
      errorPages: Object.fromEntries(([403, 404, 405, 413, 421] as ViewErrorStatus[]).map((s) => [s, errorPage(s)])),
      cases: out,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Every file under fixtures/pages this script writes, by name. */
export async function pageVectors(): Promise<Record<string, unknown>> {
  return { 'tokens.json': tokenVectors(), 'rules.json': ruleVectors(), 'responses.json': await responseVectors() }
}

if (import.meta.main) {
  const files = await pageVectors()
  for (const [name, v] of Object.entries(files)) writeFileSync(new URL(name, PAGES_FIXTURES), serialize(v))
  console.log(`wrote ${Object.keys(files).join(', ')} to fixtures/pages`)
}
