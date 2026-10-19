import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { layOutFixtureSite, nodeViewFs, NOW, PAGES_FIXTURES, pageVectors, SECRET, serialize } from '../cli/pages-vectors.ts'
import {
  contentType,
  decideView,
  etagMatches,
  etagOf,
  mintToken,
  normalizeTarget,
  pagesKey,
  progressSummary,
  signToken,
  sitePathProblem,
  slugify,
  splitViewTarget,
  TOKEN_TTL_MS,
  uniqueSlug,
  verifyToken,
  viewCsp,
  viewHeaders,
  viewOrigin,
  viewSegments,
  type ViewContext,
} from './pages-core.ts'

// The Rust hub and the CLI are tested against fixtures/pages; these keep those files true to this
// code. A failure here means a rule changed: if that was on purpose, rerun
// `bun apps/hub/src/cli/pages-vectors.ts` and commit the files with the change (the Rust hub must
// change with it, or the two hubs answer differently).
const files = await pageVectors()
for (const [name, value] of Object.entries(files)) {
  test(`fixtures/pages/${name} is what pages-core.ts produces`, () => {
    expect(readFileSync(new URL(name, PAGES_FIXTURES), 'utf8')).toBe(serialize(value))
  })
}

const key = pagesKey(SECRET)
const ctx = { key, now: NOW, epochOf: (h: string, s: string) => (h === 'local' && s === 'site' ? 2 : 0), phonePaired: (id: string) => id === 'ph1' }

describe('tokens', () => {
  test('a minted token verifies until it expires, twelve hours on', () => {
    const { token, expires } = mintToken(key, { h: 'local', s: 'site', v: 2 }, NOW)
    expect(expires).toBe(NOW + TOKEN_TTL_MS)
    expect(verifyToken(token, ctx)).toEqual({ verdict: 'ok', claims: { h: 'local', s: 'site', x: expires, v: 2 } })
    expect(verifyToken(token, { ...ctx, now: expires - 1 }).verdict).toBe('ok')
    expect(verifyToken(token, { ...ctx, now: expires }).verdict).toBe('expired')
  })

  test('revoking (a new epoch) and unpairing the phone each end a token', () => {
    const { token } = mintToken(key, { h: 'local', s: 'site', v: 2, p: 'ph1' }, NOW)
    expect(verifyToken(token, ctx).verdict).toBe('ok')
    expect(verifyToken(token, { ...ctx, epochOf: () => 3 }).verdict).toBe('revoked')
    expect(verifyToken(token, { ...ctx, phonePaired: () => false }).verdict).toBe('unpaired')
  })

  test('a new session secret (a password change) ends every token', () => {
    const { token } = mintToken(key, { h: 'local', s: 'site', v: 2 }, NOW)
    expect(verifyToken(token, { ...ctx, key: pagesKey('rotated') }).verdict).toBe('bad-signature')
  })

  test('the payload is the claims as JSON in a fixed key order', () => {
    const t = signToken(key, { p: 'ph1', v: 1, x: 5, s: 'a', h: 'b' } as never)
    expect(Buffer.from(t.split('.')[1]!, 'base64url').toString()).toBe('{"h":"b","s":"a","x":5,"v":1,"p":"ph1"}')
  })

  test('a changed payload is a bad signature, a broken shape is malformed', () => {
    const { token } = mintToken(key, { h: 'local', s: 'site', v: 2 }, NOW)
    const [, , sig] = token.split('.')
    const forged = `v1.${Buffer.from('{"h":"local","s":"site","x":99999999999999,"v":2}').toString('base64url')}.${sig}`
    expect(verifyToken(forged, ctx).verdict).toBe('bad-signature')
    for (const bad of ['', 'v1', 'v1..', `${token}.`, token.slice(0, -1), token.replace('v1.', 'v1.=')]) expect(verifyToken(bad, ctx).verdict).toBe('malformed')
  })
})

describe('slugs, folders and progress', () => {
  test('slugify keeps ASCII letters and digits and makes the rest dashes', () => {
    expect(slugify('Handy Redesign 2')).toBe('handy-redesign-2')
    expect(slugify('Ünïcode')).toBe('n-code')
    expect(slugify('---')).toBe('page')
    expect(slugify('a'.repeat(80))).toHaveLength(63)
  })

  test('uniqueSlug counts up from 2 and stays a slug', () => {
    expect(uniqueSlug('plan', (s) => ['plan', 'plan-2'].includes(s))).toBe('plan-3')
    const long = 'z'.repeat(63)
    expect(uniqueSlug(long, (s) => s === long)).toBe(`${'z'.repeat(61)}-2`)
  })

  test('sitePathProblem refuses /, the home folder, ~/.ssh, ~/.inyon and relative paths', () => {
    const home = '/home/u'
    expect(sitePathProblem('/home/u/dev/site', home)).toBeNull()
    expect(sitePathProblem('/home/u/.sshkeys', home)).toBeNull()
    for (const p of ['/', '/home/u', '/home/u/', '/home/u/.ssh/x', '/home/u/.inyon', 'site', '/home/u/../u/.ssh']) expect(sitePathProblem(p, home)).not.toBeNull()
  })

  test('progressSummary counts done tasks over every release', () => {
    const data = { now: 'Wiring', updated: '2026-10-19T10:00+00:00', releases: [{ tasks: [{ status: 'done' }, { status: 'todo' }] }, { tasks: [{ status: 'done' }] }] }
    expect(progressSummary(data)).toEqual({ done: 2, total: 3, now: 'Wiring', updated: '2026-10-19T10:00+00:00' })
    expect(progressSummary({ log: [] })).toBeUndefined()
  })
})

describe('request targets', () => {
  test('dot segments resolve as a browser resolves them, encoded or not', () => {
    expect(normalizeTarget('/v/t/a/../b?x=1')).toEqual({ path: '/v/t/b', query: 'x=1' })
    expect(normalizeTarget('/v/t/%2E%2e/x').path).toBe('/v/x')
    expect(normalizeTarget('/v/t/a/.').path).toBe('/v/t/a/')
    expect(normalizeTarget('/v/t/a/..').path).toBe('/v/t/')
    expect(normalizeTarget('/../../etc').path).toBe('/etc')
    expect(normalizeTarget('/v/t\\a').path).toBe('/v/t/a')
    expect(normalizeTarget('/v/t/.git').path).toBe('/v/t/.git')
  })

  test('the token and the rest split at the first slash', () => {
    expect(splitViewTarget('/v/tok')).toEqual({ token: 'tok', rest: '', query: null })
    expect(splitViewTarget('/v/tok/a/b?q')).toEqual({ token: 'tok', rest: '/a/b', query: 'q' })
    expect(splitViewTarget('/assets/x.js')).toBeNull()
  })

  test('dot names, empty segments, encoded separators and bad escapes are refused', () => {
    expect(viewSegments('/')).toEqual({ segments: [], dir: true })
    expect(viewSegments('/a%20b/c.html')).toEqual({ segments: ['a b', 'c.html'], dir: false })
    expect(viewSegments('/sub/')).toEqual({ segments: ['sub'], dir: true })
    for (const bad of ['/.env', '/a/.git/HEAD', '/%2egit', '/a//b', '/a%2fb', '/a%5Cb', '/a%00', '/%zz', '/%c3']) expect(viewSegments(bad)).toBeNull()
  })
})

describe('headers', () => {
  test('content types: markdown and text are plain text, unknown is octet-stream', () => {
    expect(contentType('a.HTML')).toBe('text/html;charset=utf-8')
    expect(contentType('notes.md')).toBe('text/plain;charset=utf-8')
    expect(contentType('x.woff2')).toBe('font/woff2')
    expect(contentType('Makefile')).toBe('application/octet-stream')
  })

  test('ETags are size and mtime; If-None-Match takes *, lists and W/', () => {
    const e = etagOf(425, 1792233600000.7)
    expect(e).toBe('"1a9-1a149727400"')
    expect(etagMatches('*', e)).toBe(true)
    expect(etagMatches(`"x", W/${e}`, e)).toBe(true)
    expect(etagMatches('"x"', e)).toBe(false)
    expect(etagMatches(null, e)).toBe(false)
  })

  test('the CSP sandboxes the page and scopes every fetch to its own token path', () => {
    const csp = viewCsp('http://hub:4777', 'TOK')
    expect(csp.startsWith('sandbox allow-scripts allow-forms allow-popups allow-downloads; ')).toBe(true)
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).not.toContain("'self'")
    expect(csp).toContain("connect-src http://hub:4777/v/TOK/;")
    expect(csp).toContain("script-src http://hub:4777/v/TOK/ 'unsafe-inline';")
    // a sandboxed page has an opaque origin, which no frame-ancestors source matches: a site
    // framing its own files (the mockup viewer) would break, so there is none
    expect(csp).not.toContain('frame-ancestors')
    expect(csp.endsWith("object-src 'none'; base-uri 'none'; form-action 'none'")).toBe(true)
    // before the token checked out, nothing loads
    expect(viewCsp('http://hub:4777', null)).not.toContain('/v/')
  })

  test('every header list carries the sandbox, CORS *, no-referrer and nosniff', () => {
    const names = viewHeaders({ origin: null, token: null, cache: 'no-store' }).map(([n]) => n)
    expect(names).toEqual(['content-security-policy', 'access-control-allow-origin', 'referrer-policy', 'x-content-type-options', 'cache-control'])
  })

  test('viewOrigin takes plain hosts only', () => {
    expect(viewOrigin('Hub.Local:4777', false)).toBe('http://hub.local:4777')
    expect(viewOrigin('[::1]:4777', true)).toBe('https://[::1]:4777')
    for (const bad of [null, '', 'a b', "h'; script-src *", 'h:99999999']) expect(viewOrigin(bad, false)).toBeNull()
  })
})

describe('decideView on the fixture site', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inyon-pages-core-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const site = layOutFixtureSite(dir)
  const vctx: ViewContext = { ...ctx, epochOf: () => 0, siteRoot: (h, s) => (h === 'local' && s === 'fx' ? site : undefined), fs: nodeViewFs }
  const { token } = mintToken(key, { h: 'local', s: 'fx', v: 0 }, NOW)
  const get = (target: string, extra: Partial<{ method: string; ifNoneMatch: string }> = {}) =>
    decideView({ method: 'GET', target, origin: 'http://hub:4777', ...extra }, vctx)

  test('serves index.html for the root and 301s a folder without its slash', async () => {
    const root = await get(`/v/${token}/`)
    expect(root.status).toBe(200)
    expect(root.status === 200 && root.file.endsWith('index.html')).toBe(true)
    const sub = await get(`/v/${token}/sub?x=1`)
    expect(sub.status).toBe(301)
    expect(Object.fromEntries(sub.headers).location).toBe(`/v/${token}/sub/?x=1`)
  })

  test('never leaves the site and never serves a dot name', async () => {
    for (const t of ['outside-link.html', 'outside-dir/secret.html', 'dot-link.txt', '.inyon-page.json', '.draft.md', 'empty/']) expect((await get(`/v/${token}/${t}`)).status).toBe(404)
  })

  test('every answer, errors included, carries the sandbox CSP', async () => {
    const answers = await Promise.all([
      get(`/v/${token}/`),
      get(`/v/${token}`),
      get(`/v/${token}/nope`),
      get('/v/nope/'),
      get(`/v/${token}/`, { method: 'PUT' }),
      decideView({ method: 'GET', target: `/v/${token}/`, origin: null }, vctx),
    ])
    expect(answers.map((a) => a.status)).toEqual([200, 301, 404, 403, 405, 421])
    for (const a of answers) {
      const h = Object.fromEntries(a.headers)
      expect(h['content-security-policy']).toStartWith('sandbox allow-scripts allow-forms allow-popups allow-downloads;')
      expect(h['access-control-allow-origin']).toBe('*')
      expect(Object.keys(h)).not.toContain('set-cookie')
    }
  })

  test('progress.json is never cached; other files answer If-None-Match with 304', async () => {
    const p = await get(`/v/${token}/progress.json`, { ifNoneMatch: '*' })
    expect(p.status).toBe(200)
    expect(Object.fromEntries(p.headers)['cache-control']).toBe('no-store')
    const first = await get(`/v/${token}/style.css`)
    const etag = Object.fromEntries(first.headers).etag!
    expect((await get(`/v/${token}/style.css`, { ifNoneMatch: etag })).status).toBe(304)
  })
})
