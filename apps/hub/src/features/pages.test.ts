import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { memoryStore, type Store } from '../platform/store.ts'
import { HttpError } from '../hosts/http-error.ts'
import { layOutFixtureSite, NOW, PAGES_FIXTURES, SECRET } from '../cli/pages-vectors.ts'
import { CANT_WRITE_LIST, NO_INDEX, PRIVATE_FOLDER, TOO_WIDE, pagesKey, verifyToken, type ViewFs } from './pages-core.ts'
import { BROKEN_FILE, diskFs, EPOCHS_KEY, LISTED_KEY, LOCKED, NOT_SAVED, OTHER_MACHINE, pageEpochs, pagesFeature, pagesFile, projectOf, removeJudged, withLock } from './pages.ts'

// The Bun hub's half of Pages: the list file, epochs, the API handlers, and the /v/ answer
// checked byte for byte against fixtures/pages/responses.json over a real socket.

const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(name, PAGES_FIXTURES), 'utf8'))
const TOKENS = fixture('tokens.json')
const RESPONSES = fixture('responses.json')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inyon-pages-test-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
let n = 0
/** A fresh home folder, a store and a hub feature over them, at the fixture clock. */
function hub(over: Partial<Parameters<typeof pagesFeature>[0]> = {}, store: Store = memoryStore()) {
  const home = path.join(root, `home-${++n}`)
  fs.mkdirSync(home, { recursive: true })
  const pages = pagesFeature({ ...hubOptions(home, store, NOW), ...over })
  return { home, store, pages, file: pagesFile(home) }
}
/** The options a test hub runs with; the clock is the real one unless `at` is given. */
function hubOptions(home: string, store: Store, at?: number): Parameters<typeof pagesFeature>[0] {
  return {
    home,
    store,
    secret: () => SECRET,
    phoneOf: () => undefined,
    phonePaired: (id) => TOKENS.phones.includes(id),
    knownHost: (h) => h === RESPONSES.context.host,
    secure: () => false,
    now: at === undefined ? Date.now : () => at,
  }
}
const writeList = (file: string, pages: unknown[], extra: object = {}) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ v: 1, pages, ...extra }))
}
const readList = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))
const record = (slug: string, p: string, extra: object = {}) => ({ slug, name: slug, path: p, project: p, by: 'cli', added: 1, ...extra })
/** A site folder with an index.html (and the fixture's files when `copy`). */
function site(name: string, copy = false) {
  const dir = path.join(root, 'sites', `${name}-${++n}`)
  if (copy) fs.cpSync(new URL('site/', PAGES_FIXTURES), dir, { recursive: true })
  else {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title>')
  }
  return dir
}

type H = { pages: ReturnType<typeof pagesFeature> }
const call = async (h: H, route: string, method: string, params: Record<string, string>, body?: unknown): Promise<{ status: number; json(): Promise<any> }> => {
  const r = (h.pages.routes as any)[route][method]
  const req = Object.assign(new Request('http://hub.test/x', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { params })
  return (await r(req)) as Response
}
const status = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : Promise.reject(e)))
const message = (p: Promise<unknown>) => p.then(() => '', (e) => (e as Error).message)

// ---------- the /v/ answer, against the fixture ----------

describe('every /v/ request in fixtures/pages/responses.json', () => {
  let server: ReturnType<typeof Bun.serve>
  let dir = ''
  beforeAll(() => {
    dir = path.join(root, 'responses')
    fs.mkdirSync(dir)
    const sitePath = layOutFixtureSite(dir)
    const store = memoryStore()
    store.set(EPOCHS_KEY, TOKENS.epochs)
    const h = hub({}, store)
    writeList(h.file, [record(RESPONSES.context.site.s, sitePath)])
    // wired as index.ts wires it: /v/ first, everything else elsewhere
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => (new URL(req.url).pathname.startsWith('/v/') ? h.pages.view(req) : new Response('app')),
    })
  })
  afterAll(() => server.stop(true))

  for (const c of RESPONSES.cases) {
    test(c.name, async () => {
      const res = await raw(server.port!, c.request.method, c.request.target, c.request.headers)
      expect(res.status).toBe(c.response.status)
      const headers = Object.fromEntries(Object.entries(res.headers).filter(([k]) => !RESPONSES.ignoredHeaders.includes(k)))
      expect(headers).toEqual(c.response.headers)
      const want = c.response.body === null ? '' : c.response.body.file ? fs.readFileSync(new URL(c.response.body.file, PAGES_FIXTURES)).toString('latin1') : RESPONSES.errorPages[c.response.body.page]
      expect(res.body.toString('latin1')).toBe(want)
    })
  }

  test('a folder swapped for a symlink after the check is not followed out of the site', async () => {
    const dir = site('swap', true)
    const outside = path.join(root, `outside-${++n}`)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'index.html'), 'SECRET KEY')
    const watch = path.join(fs.realpathSync(dir), 'sub', 'index.html')
    let swapped = false
    // the last look decideView takes at sub/index.html swaps sub for a symlink right after, as an
    // agent renaming its own folders in a loop would
    const swapFs: ViewFs = {
      realpath: diskFs.realpath,
      async stat(p) {
        const st = await diskFs.stat(p)
        if (!swapped && p === watch) {
          swapped = true
          fs.renameSync(path.join(dir, 'sub'), path.join(dir, 'sub-real'))
          fs.symlinkSync(outside, path.join(dir, 'sub'))
        }
        return st
      },
    }
    const h = hub({ fs: swapFs, now: Date.now })
    writeList(h.file, [record('swap', dir)])
    const { url } = await (await call(h, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'swap' })).json()
    const view = (u: string) => h.pages.view(new Request(`http://${RESPONSES.context.host}${u}`, { headers: { host: RESPONSES.context.host } }))
    const res = await view(`${url}sub/index.html`)
    expect(swapped).toBe(true)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('SECRET')
    // nothing swapped: served as before
    expect((await view(`${url}style.css`)).status).toBe(200)
  })

  test('a file swapped for a FIFO after the check is a 404 at once, not an open that waits for a writer', async () => {
    const dir = site('fifo', true)
    const watch = path.join(fs.realpathSync(dir), 'style.css')
    let swapped = false
    const swapFs: ViewFs = {
      realpath: diskFs.realpath,
      async stat(p) {
        const st = await diskFs.stat(p)
        if (!swapped && p === watch) {
          swapped = true
          fs.rmSync(watch)
          expect(Bun.spawnSync(['mkfifo', watch]).exitCode).toBe(0)
        }
        return st
      },
    }
    const h = hub({ fs: swapFs, now: Date.now })
    writeList(h.file, [record('fifo', dir)])
    const { url } = await (await call(h, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'fifo' })).json()
    const view = (u: string) => h.pages.view(new Request(`http://${RESPONSES.context.host}${u}`, { headers: { host: RESPONSES.context.host } }))
    const res = await Promise.race([view(`${url}style.css`), Bun.sleep(3000).then(() => null)])
    expect(swapped).toBe(true)
    expect(res?.status).toBe(404)
    expect(await res!.text()).toBe(RESPONSES.errorPages['404'])
    // and a FIFO there from the start is a 404 too
    expect((await view(`${url}style.css`)).status).toBe(404)
  })

  test('an answer nobody reads (a client gone before the body) leaves no open file for the collector to trip on', async () => {
    const dir = site('dropped', true)
    const h = hub({ now: Date.now })
    writeList(h.file, [record('dropped', dir)])
    const { url } = await (await call(h, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'dropped' })).json()
    const view = (u: string) => h.pages.view(new Request(`http://${RESPONSES.context.host}${u}`, { headers: { host: RESPONSES.context.host } }))
    const errors: unknown[] = []
    const onError = (e: unknown) => errors.push(e)
    process.on('uncaughtException', onError)
    try {
      for (let i = 0; i < 20; i++) expect((await view(`${url}style.css`)).status).toBe(200)
      for (let i = 0; i < 3; i++) {
        Bun.gc(true)
        await Bun.sleep(5)
      }
    } finally {
      process.off('uncaughtException', onError)
    }
    expect(errors).toEqual([])
  })

  test('a Range request still gets the whole file with a 200', async () => {
    const c = RESPONSES.cases.find((x: any) => x.name === 'stylesheet')
    const res = await raw(server.port!, 'GET', c.request.target, { ...c.request.headers, range: 'bytes=0-3' })
    expect(res.status).toBe(200)
    expect(res.headers['content-range']).toBeUndefined()
    expect(res.body.toString()).toBe(fs.readFileSync(new URL('site/style.css', PAGES_FIXTURES), 'utf8'))
  })
})

/** One request written to the socket as is (fetch would resolve the dot segments itself), and its answer. */
function raw(port: number, method: string, target: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const lines = [`${method} ${target} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), 'connection: close', '', '']
      sock.write(lines.join('\r\n'))
    })
    const chunks: Buffer[] = []
    sock.on('data', (d: Buffer) => chunks.push(d))
    sock.on('error', reject)
    sock.on('close', () => {
      const all = Buffer.concat(chunks)
      const end = all.indexOf('\r\n\r\n')
      const head = all.subarray(0, end).toString('latin1').split('\r\n')
      const status = Number(head[0]!.split(' ')[1])
      const h: Record<string, string> = {}
      for (const line of head.slice(1)) {
        const i = line.indexOf(':')
        const k = line.slice(0, i).trim().toLowerCase()
        h[k] = h[k] === undefined ? line.slice(i + 1).trim() : `${h[k]}, ${line.slice(i + 1).trim()}`
      }
      let body = all.subarray(end + 4)
      if (h['transfer-encoding'] === 'chunked') body = unchunk(body)
      resolve({ status, headers: h, body })
    })
  })
}
function unchunk(b: Buffer) {
  const out: Buffer[] = []
  let i = 0
  for (;;) {
    const eol = b.indexOf('\r\n', i)
    const size = parseInt(b.subarray(i, eol).toString(), 16)
    if (!size) return Buffer.concat(out)
    out.push(b.subarray(eol + 2, eol + 2 + size))
    i = eol + 2 + size + 2
  }
}

// ---------- tokens ----------

describe('tokens', () => {
  test('the hub mints the tokens in fixtures/pages/tokens.json, phone-bound when a phone asks', async () => {
    const store = memoryStore()
    store.set(EPOCHS_KEY, TOKENS.epochs)
    const folder = site('mint')
    for (const m of TOKENS.mint.filter((x: any) => x.site.h === 'local' && x.site.s === 'fixture')) {
      const h = hub({ now: () => m.now, phoneOf: () => m.site.p }, store)
      writeList(h.file, [record('fixture', folder)])
      const opened = await (await call(h, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'fixture' })).json()
      expect(opened).toEqual({ url: `/v/${m.token}/`, expires: m.expires, ttl: 12 * 3600_000 })
    }
  })

  test('every verify vector, with the epochs read from the hub data folder', () => {
    const store = memoryStore()
    store.set(EPOCHS_KEY, { ...TOKENS.epochs, 'local/junk': -1, 'local/frac': 1.5 })
    const epochs = pageEpochs(store)
    expect(epochs.of('local', 'junk')).toBe(0)
    expect(epochs.of('local', 'frac')).toBe(0)
    for (const c of TOKENS.verify) {
      const r = verifyToken(c.token, { key: pagesKey(TOKENS.secret), now: TOKENS.now, epochOf: epochs.of, phonePaired: (id) => TOKENS.phones.includes(id) })
      expect([c.name, r.verdict]).toEqual([c.name, c.verdict])
    }
  })

  test('revoking moves the epoch on and survives a restart; links made before it stop working', async () => {
    const store = memoryStore()
    const h = hub({ now: Date.now }, store)
    writeList(h.file, [record('plan', site('plan', true))])
    const before = (await (await call(h, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'plan' })).json()).url
    const view = (url: string) => h.pages.view(new Request(`http://${RESPONSES.context.host}${url}`, { headers: { host: RESPONSES.context.host } }))
    expect((await view(before)).status).toBe(200)
    expect(await (await call(h, '/api/pages/:host/:slug/revoke', 'POST', { host: 'local', slug: 'plan' })).json()).toEqual({ ok: true })
    expect(store.get<Record<string, number>>(EPOCHS_KEY)).toEqual({ 'local/plan': 1 })
    expect(pageEpochs(store).of('local', 'plan')).toBe(1)
    expect((await view(before)).status).toBe(403)
    const after = (await (await call(h, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'plan' })).json()).url
    expect((await view(after)).status).toBe(200)
    expect(await status(call(h, '/api/pages/:host/:slug/revoke', 'POST', { host: 'local', slug: 'nope' }))).toBe(404)
    expect(await status(call(h, '/api/pages/:host/:slug/open', 'POST', { host: 'laptop', slug: 'plan' }))).toBe(404)
  })

  test('a revoke that cannot be saved says so, and still ends the links until a restart', async () => {
    const store = memoryStore()
    let full = false
    const set = store.set
    store.set = (k, v) => {
      if (full && k === EPOCHS_KEY) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      set(k, v)
    }
    const h = hub({ now: Date.now }, store)
    writeList(h.file, [record('plan', site('plan', true))])
    const { url } = await (await call(h, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'plan' })).json()
    full = true
    const err = await call(h, '/api/pages/:host/:slug/revoke', 'POST', { host: 'local', slug: 'plan' }).then(() => null, (e) => e)
    expect([err?.status, err?.message]).toEqual([500, NOT_SAVED])
    expect((await h.pages.view(new Request(`http://${RESPONSES.context.host}${url}`, { headers: { host: RESPONSES.context.host } }))).status).toBe(403)
  })

  test('a list that cannot be saved is still served, not emptied', async () => {
    const store = memoryStore()
    const set = store.set
    store.set = (k, v) => {
      if (k === LISTED_KEY || k === EPOCHS_KEY) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      set(k, v)
    }
    const h = hub({ now: Date.now }, store)
    writeList(h.file, [record('plan', site('plan', true)), record('other', site('other', true))])
    expect((await (await call(h, '/api/pages', 'GET', {})).json()).pages).toHaveLength(2)
    // one taken off by another program: its links end, the other stays listed and served
    writeList(h.file, [record('plan', site('plan', true))])
    expect((await (await call(h, '/api/pages', 'GET', {})).json()).pages.map((p: any) => p.slug)).toEqual(['plan'])
    const { url } = await (await call(h, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'plan' })).json()
    expect((await h.pages.view(new Request(`http://${RESPONSES.context.host}${url}`, { headers: { host: RESPONSES.context.host } }))).status).toBe(200)
  })

  test('a new session secret (a password change) ends every link', async () => {
    let secret = 'one'
    const h = hub({ secret: () => secret, now: Date.now })
    writeList(h.file, [record('plan', site('plan', true))])
    const { url } = await (await call(h, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'plan' })).json()
    const view = () => h.pages.view(new Request(`http://${RESPONSES.context.host}${url}`, { headers: { host: RESPONSES.context.host } }))
    expect((await view()).status).toBe(200)
    secret = 'two'
    expect((await view()).status).toBe(403)
  })
})

// ---------- the list ----------

describe('~/.inyon/pages.json', () => {
  test('is listed with a progress summary, and read again when it changes', async () => {
    const h = hub()
    const a = site('a', true)
    writeList(h.file, [record('a', a, { name: 'Plan A', project: '/p', by: 'claude', added: 5 })])
    const list = async () => (await (await call(h, '/api/pages', 'GET', {})).json()).pages
    expect(await list()).toEqual([
      { host: 'local', slug: 'a', name: 'Plan A', project: '/p', by: 'claude', added: 5, folder: a, progress: { done: 1, total: 3, now: 'Writing the sub page', updated: '2026-10-19T12:00+00:00' } },
    ])
    const b = site('b')
    writeList(h.file, [record('a', a), record('b', b)])
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(h.file, later, later)
    expect((await list()).map((p: any) => [p.slug, p.progress ?? null])).toEqual([
      ['a', { done: 1, total: 3, now: 'Writing the sub page', updated: '2026-10-19T12:00+00:00' }],
      ['b', null],
    ])
  })

  test('progress is read at most every 30 seconds', async () => {
    let now = NOW
    const h = hub({ now: () => now })
    const a = site('a', true)
    writeList(h.file, [record('a', a)])
    const done = async () => (await (await call(h, '/api/pages', 'GET', {})).json()).pages[0].progress?.done
    expect(await done()).toBe(1)
    fs.writeFileSync(path.join(a, 'progress.json'), JSON.stringify({ releases: [{ tasks: [{ status: 'done' }, { status: 'done' }] }] }))
    now += 29_000
    expect(await done()).toBe(1)
    now += 1_000
    expect(await done()).toBe(2)
  })

  test('only entries that may be served come out: well formed, a real folder, the first of a slug', async () => {
    const h = hub()
    const good = site('good')
    fs.mkdirSync(path.join(h.home, '.ssh', 'site'), { recursive: true })
    const link = path.join(root, `home-link-${n}`)
    fs.symlinkSync(h.home, link)
    writeList(h.file, [
      record('good', good),
      record('good', site('second')),
      record('Bad', good),
      record('home', h.home),
      record('ssh', path.join(h.home, '.ssh', 'site')),
      record('root', '/'),
      record('relative', 'some/where'),
      record('via-link', link),
      { slug: 'partial', path: good },
      'junk',
    ])
    expect((await (await call(h, '/api/pages', 'GET', {})).json()).pages.map((p: any) => [p.slug, p.folder])).toEqual([['good', good]])
    // and the ones left out can't be opened or served either
    expect(await status(call(h, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'home' }))).toBe(404)
  })

  test('a missing file is an empty list; one that is not a list is refused for writes and left alone', async () => {
    const h = hub()
    expect(await (await call(h, '/api/pages', 'GET', {})).json()).toEqual({ pages: [] })
    fs.mkdirSync(path.dirname(h.file), { recursive: true })
    fs.writeFileSync(h.file, '{"v":1,"pages":[')
    expect(await (await call(h, '/api/pages', 'GET', {})).json()).toEqual({ pages: [] })
    expect(await message(call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: site('x') }))).toBe(BROKEN_FILE)
    expect(await message(call(h, '/api/pages/:host/:slug', 'DELETE', { host: 'local', slug: 'x' }))).toBe(BROKEN_FILE)
    expect(fs.readFileSync(h.file, 'utf8')).toBe('{"v":1,"pages":[')
  })
})

// ---------- adding and removing ----------

describe('adding a page', () => {
  test('takes the name and slug from the marker, the project from git, and writes the file', async () => {
    const h = hub()
    const folder = site('marked', true)
    const r = await call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: `${folder}/` })
    const entry = await r.json()
    expect(entry).toEqual({ host: 'local', slug: 'fixture', name: 'Fixture site', project: folder, by: 'app', added: NOW, folder, progress: { done: 1, total: 3, now: 'Writing the sub page', updated: '2026-10-19T12:00+00:00' } })
    expect(readList(h.file)).toEqual({ v: 1, pages: [{ slug: 'fixture', name: 'Fixture site', path: folder, project: folder, by: 'app', added: NOW }] })
    expect(fs.statSync(h.file).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(`${h.file}.lock`)).toBe(false)

    // the project is the git top level when the folder is in a repository
    const repo = path.join(root, `repo-${++n}`)
    fs.mkdirSync(path.join(repo, 'private', 'plans'), { recursive: true })
    Bun.spawnSync(['git', 'init', '-q', repo])
    fs.cpSync(new URL('site/', PAGES_FIXTURES), path.join(repo, 'private', 'plans', 'ghostex'), { recursive: true })
    const inRepo = await (await call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: path.join(repo, 'private', 'plans', 'ghostex'), name: 'Inyon plan' })).json()
    expect([inRepo.slug, inRepo.name, inRepo.project]).toEqual(['fixture-2', 'Inyon plan', fs.realpathSync(repo)])
  })

  test('a folder in a linked git worktree belongs to the main checkout, as the CLI and the skill say', async () => {
    const h = hub()
    const repo = path.join(root, `repo-${++n}`)
    fs.mkdirSync(repo, { recursive: true })
    const git = (...args: string[]) => expect(Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0)
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'first')
    const tree = path.join(repo, '.claude', 'worktrees', 'pages')
    git('worktree', 'add', '-q', '--detach', tree)
    fs.cpSync(new URL('site/', PAGES_FIXTURES), path.join(tree, 'private', 'plans', 'ghostex'), { recursive: true })
    const entry = await (await call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: path.join(tree, 'private', 'plans', 'ghostex') })).json()
    expect(entry.project).toBe(fs.realpathSync(repo))
  })

  test('the project is found the same with any git, old ones that print unknown options back too', () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(root, 'git-')))
    const run = (...args: string[]) => expect(Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0)
    run('init', '-q')
    run('commit', '-q', '--allow-empty', '-m', 'first')
    const tree = path.join(repo, '.claude', 'worktrees', 'x')
    run('worktree', 'add', '-q', '--detach', tree)
    fs.mkdirSync(path.join(repo, 'sub'))
    fs.mkdirSync(path.join(tree, 'deep'))
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inyon-no-git-')))
    // fixtures/old-git/git is git before 2.31 (prints --path-format=absolute back, exit 0); git-2.4 knows no --git-common-dir
    const oldGit = new URL('../../../../fixtures/old-git/', import.meta.url).pathname
    for (const g of ['git', path.join(oldGit, 'git')]) {
      expect([g, projectOf(repo, g)]).toEqual([g, repo])
      expect([g, projectOf(path.join(repo, 'sub'), g)]).toEqual([g, repo])
      expect([g, projectOf(tree, g)]).toEqual([g, repo])
      expect([g, projectOf(path.join(tree, 'deep'), g)]).toEqual([g, repo])
      expect([g, projectOf(outside, g)]).toEqual([g, outside])
    }
    const g24 = path.join(oldGit, 'git-2.4')
    expect(projectOf(path.join(repo, 'sub'), g24)).toBe(repo)
    expect(projectOf(path.join(tree, 'deep'), g24)).toBe(tree)
    fs.rmSync(outside, { recursive: true })
  })

  test('without a marker, the slug comes from the folder (whatever the name), and is unique', async () => {
    const h = hub()
    const add = async (body: object) => (await (await call(h, '/api/pages/:host', 'POST', { host: 'local' }, body)).json()).slug
    const twin = (parent: string) => {
      const dir = path.join(root, `twins-${++n}`, parent, 'Handy')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title>')
      return dir
    }
    expect(await add({ path: twin('a'), name: 'Handy redesign' })).toBe('handy')
    expect(await add({ path: twin('b'), name: 'Handy redesign' })).toBe('handy-2')
    const folder = site('Folder-Name')
    expect(await add({ path: folder })).toBe(path.basename(folder).toLowerCase())
    expect(await add({ path: site('x'), slug: 'chosen' })).toBe('chosen')
  })

  test('the same folder again is the same page; a new name renames it', async () => {
    const h = hub()
    const folder = site('again')
    const first = await (await call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: folder, name: 'One' })).json()
    const same = await (await call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: folder })).json()
    expect(same).toEqual(first)
    const renamed = await (await call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: folder, name: 'Two' })).json()
    expect([renamed.slug, renamed.name, renamed.added]).toEqual([first.slug, 'Two', first.added])
    expect(readList(h.file).pages).toHaveLength(1)
    expect(await status(call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: folder, slug: 'other' }))).toBe(409)
  })

  test('refuses bad folders, slugs and names, and other machines', async () => {
    const h = hub()
    const add = (body: object, host = 'local') => message(call(h, '/api/pages/:host', 'POST', { host }, body))
    fs.mkdirSync(path.join(h.home, '.inyon', 'site'), { recursive: true })
    fs.writeFileSync(path.join(h.home, '.inyon', 'site', 'index.html'), 'x')
    const empty = path.join(root, `empty-${++n}`)
    fs.mkdirSync(empty)
    expect(await add({ path: h.home })).toBe(TOO_WIDE)
    expect(await add({ path: '/' })).toBe(TOO_WIDE)
    expect(await add({ path: path.join(h.home, '.inyon', 'site') })).toBe(PRIVATE_FOLDER)
    expect(await add({ path: empty })).toBe(NO_INDEX)
    expect(await add({ path: 'relative' })).toBe('The folder must be an absolute path')
    expect(await add({})).toBe('The folder must be an absolute path')
    expect(await add({ path: site('s'), slug: 'Not A Slug' })).toMatch(/^A slug is/)
    expect(await add({ path: site('s'), name: 5 })).toBe('The name must be text')
    expect(await add({ path: site('s') }, 'laptop')).toBe(OTHER_MACHINE)
    fs.symlinkSync(h.home, path.join(root, `to-home-${n}`))
    fs.writeFileSync(path.join(h.home, 'index.html'), 'x')
    expect(await add({ path: path.join(root, `to-home-${n}`) })).toBe(TOO_WIDE)
    const taken = site('taken')
    await call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: taken, slug: 'taken' })
    expect(await status(call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: site('t2'), slug: 'taken' }))).toBe(409)
    expect(await status(call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: site('t3') }))).toBe(200)
  })

  test('keeps entries it cannot read, and other fields of the file, as they were', async () => {
    const h = hub()
    const unknown = { slug: 'future', path: '/x', kind: 'remote', extra: [1] }
    writeList(h.file, [unknown], { note: 'kept' })
    await call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: site('k'), slug: 'future' }).catch(() => {})
    await call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: site('k'), slug: 'k' })
    const after = readList(h.file)
    expect(after.note).toBe('kept')
    expect(after.pages[0]).toEqual(unknown)
    expect(after.pages.map((p: any) => p.slug)).toEqual(['future', 'k'])
  })
})

describe('removing a page', () => {
  test('drops it from the file and ends its links, even if the slug comes back', async () => {
    const store = memoryStore()
    const h = hub({ now: Date.now }, store)
    const folder = site('gone', true)
    writeList(h.file, [record('gone', folder), record('kept', site('kept'))])
    const { url } = await (await call(h, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'gone' })).json()
    expect(await (await call(h, '/api/pages/:host/:slug', 'DELETE', { host: 'local', slug: 'gone' })).json()).toEqual({ ok: true })
    expect(readList(h.file).pages.map((p: any) => p.slug)).toEqual(['kept'])
    expect(await status(call(h, '/api/pages/:host/:slug', 'DELETE', { host: 'local', slug: 'gone' }))).toBe(404)
    await call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: folder, slug: 'gone' })
    const res = await h.pages.view(new Request(`http://${RESPONSES.context.host}${url}`, { headers: { host: RESPONSES.context.host } }))
    expect(res.status).toBe(403)
  })

  test('taken off the file by another program (the CLI) ends its links too; other changes keep them', async () => {
    const store = memoryStore()
    const h = hub({ now: Date.now }, store)
    const folder = site('cli', true)
    writeList(h.file, [record('cli', folder)])
    const { url } = await (await call(h, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'cli' })).json()
    const view = () => h.pages.view(new Request(`http://${RESPONSES.context.host}${url}`, { headers: { host: RESPONSES.context.host } }))
    expect((await view()).status).toBe(200)
    // another page added, this one renamed: same page, links still open
    writeList(h.file, [record('cli', folder, { name: 'Renamed' }), record('other', site('other'))])
    expect((await view()).status).toBe(200)
    // removed and added again under the same slug before the hub looked: a new page, old links end
    writeList(h.file, [record('cli', folder, { added: 2 })])
    expect((await view()).status).toBe(403)
    expect(pageEpochs(store).of('local', 'cli')).toBe(1)
    const fresh = (await (await call(h, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'cli' })).json()).url
    expect((await h.pages.view(new Request(`http://${RESPONSES.context.host}${fresh}`, { headers: { host: RESPONSES.context.host } }))).status).toBe(200)
    // the file deleted: every page it listed is gone
    fs.rmSync(h.file)
    expect(h.pages.registry.records()).toEqual([])
    expect(pageEpochs(store).of('local', 'cli')).toBe(2)
  })

  test('removed and added again while the hub was stopped: its old links still end', async () => {
    const store = memoryStore()
    const first = hub({ now: Date.now }, store)
    const folder = site('restart', true)
    writeList(first.file, [record('plan', folder)])
    const { url } = await (await call(first, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'plan' })).json()
    // the hub stops; the CLI removes the page and adds it again
    writeList(first.file, [record('plan', folder, { added: 7 })])
    const second = pagesFeature({ ...hubOptions(first.home, store) })
    const res = await second.view(new Request(`http://${RESPONSES.context.host}${url}`, { headers: { host: RESPONSES.context.host } }))
    expect(res.status).toBe(403)
    // and a restart with nothing changed keeps links working
    const { url: fresh } = await (await call({ pages: second }, '/api/pages/:host/:slug/open', 'POST', { host: 'local', slug: 'plan' })).json()
    const third = pagesFeature({ ...hubOptions(first.home, store) })
    expect((await third.view(new Request(`http://${RESPONSES.context.host}${fresh}`, { headers: { host: RESPONSES.context.host } }))).status).toBe(200)
  })
})

describe('the lock', () => {
  test('waits for a live writer, and takes over a lock left for more than 10 seconds', async () => {
    const lock = path.join(root, `lock-${++n}`, 'pages.json.lock')
    fs.mkdirSync(path.dirname(lock))
    fs.writeFileSync(lock, '1\n')
    expect(await message(withLock(lock, () => 1, 100))).toBe(LOCKED)
    expect(fs.existsSync(lock)).toBe(true)
    const old = new Date(Date.now() - 11_000)
    fs.utimesSync(lock, old, old)
    expect(await withLock(lock, () => fs.readFileSync(lock, 'utf8'), 100)).toMatch(new RegExp(`^${process.pid} [0-9a-f]{16}\\n$`))
    expect(fs.existsSync(lock)).toBe(false)
    // nothing is left beside it from the takeover
    expect(fs.readdirSync(path.dirname(lock))).toEqual([])
    // released when the change fails, too
    expect(await message(withLock(lock, () => { throw new Error('boom') }))).toBe('boom')
    expect(fs.existsSync(lock)).toBe(false)
  })

  test('is removed only while it is still this writer\'s', async () => {
    const lock = path.join(root, `lock-${++n}`, 'pages.json.lock')
    // another writer took it over (it thought this one had died) and holds it now
    await withLock(lock, () => fs.writeFileSync(lock, '999 0123456789abcdef\n'))
    expect(fs.readFileSync(lock, 'utf8')).toBe('999 0123456789abcdef\n')
  })

  test('a stale lock two writers judged leaves the fresh one made in between in its place', () => {
    const lock = path.join(root, `lock-${++n}`, 'pages.json.lock')
    fs.mkdirSync(path.dirname(lock))
    fs.writeFileSync(lock, '1 stale\n')
    const old = new Date(Date.now() - 11_000)
    fs.utimesSync(lock, old, old)
    const judged = fs.statSync(lock)
    fs.rmSync(lock)
    fs.writeFileSync(lock, '2 fresh\n')
    removeJudged(lock, judged)
    expect(fs.readFileSync(lock, 'utf8')).toBe('2 fresh\n')
    expect(fs.readdirSync(path.dirname(lock))).toEqual(['pages.json.lock'])
  })

  test('a stale lock that cannot be removed is an error at once, not a wait', async () => {
    if (process.getuid?.() === 0) return // root ignores the folder's mode
    const dir = path.join(root, `lock-${++n}`)
    fs.mkdirSync(dir)
    const lock = path.join(dir, 'pages.json.lock')
    fs.writeFileSync(lock, '1\n')
    const old = new Date(Date.now() - 11_000)
    fs.utimesSync(lock, old, old)
    fs.chmodSync(dir, 0o500)
    try {
      const started = Date.now()
      expect(await status(withLock(lock, () => 1, 60_000))).toBe(500)
      expect(await message(withLock(lock, () => 1, 60_000))).toBe(CANT_WRITE_LIST)
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      fs.chmodSync(dir, 0o700)
    }
  })

  test('register and delete answer the same 500 as the Rust hub when a stale lock cannot be removed', async () => {
    if (process.getuid?.() === 0) return // root ignores the folder's mode
    const h = hub()
    const listed = site('listed')
    writeList(h.file, [record('listed', listed)])
    const lock = `${h.file}.lock`
    fs.writeFileSync(lock, '1\n')
    const old = new Date(Date.now() - 11_000)
    fs.utimesSync(lock, old, old)
    const inyon = path.dirname(h.file)
    fs.chmodSync(inyon, 0o500)
    try {
      const add = () => call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: site('new') })
      const del = () => call(h, '/api/pages/:host/:slug', 'DELETE', { host: 'local', slug: 'listed' })
      for (const req of [add, del]) {
        expect(await status(req())).toBe(500)
        expect(await message(req())).toBe(CANT_WRITE_LIST)
      }
    } finally {
      fs.chmodSync(inyon, 0o700)
    }
  })

  test('two writers at once both land', async () => {
    const h = hub()
    await Promise.all([site('w1'), site('w2'), site('w3')].map((p) => call(h, '/api/pages/:host', 'POST', { host: 'local' }, { path: p })))
    expect(readList(h.file).pages).toHaveLength(3)
  })
})
