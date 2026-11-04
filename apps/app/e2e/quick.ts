// bun apps/app/e2e/quick.ts — Quick access and the ways in (from 1.1) in the built app (apps/app/dist,
// from build.sh) in Chromium behind a stand-in hub: the page under the hub's own CSP for /next, the
// /ws2 overview and organize streams, saved prompts, the sessions' file lists and sending. Checks
// the sidebar's "Search or jump to…" and New session, Ctrl K, Ctrl P, Ctrl Shift P and Ctrl O, the
// tabs and the `>` and `@` marks, opening a session, a command run on the session on screen, saving
// a prompt and sending it, finding a file, a row's menu by Ctrl K and right click, Alt N and N, the
// menu on empty space, and on a phone the tab bar's +, the Overview's search button and the box
// taking the screen. Saves a screenshot of each size and theme to $SHOTS (default: a temp folder).
// CHROME=/path/to/chrome uses a browser other than Playwright's own.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, devices, type Page } from 'playwright'
import type { ServerWebSocket } from 'bun'
import { overview } from './demo.ts'

const root = path.join(import.meta.dir, '../../..')
const dist = path.join(import.meta.dir, '../dist')
const web = path.join(root, 'apps/web/public')
const shots = process.env.SHOTS ?? path.join(tmpdir(), 'inyon-app-shots')
mkdirSync(shots, { recursive: true })

const rs = await Bun.file(path.join(root, 'crates/inyon-hub/src/static_files.rs')).text()
const NEXT_CSP = /pub const NEXT_CSP: &str =\s*"([^"]+)"/.exec(rs)![1]!

type Entry = Record<string, any>
const state = {
  hosts: overview(Date.now()).hosts as Entry[],
  org: { sessions: [] as Entry[], prompts: [] as Entry[] },
  calls: [] as { method: string; path: string; body?: any }[],
}
const FILES: Record<string, string[]> = {
  '/home/sam/code/storefront': ['package.json', 'src/checkout/cart.ts', 'src/checkout/checkout.test.ts'],
  '/home/sam/code/accounts': ['src/auth/passkeys.ts', 'README.md'],
  '/home/sam/code/docs-site': ['docs/release-notes.md'],
  '/home/sam/code/billing': ['src/types.ts'],
}
type Socket = ServerWebSocket<{ subs: Set<string> }>
const sockets = new Set<Socket>()
let seq = 1
const EPOCH = 1
function frame(stream: string) {
  const rows = stream === 'overview' ? { hosts: state.hosts } : stream === 'pages' ? { pages: [] } : { sessions: state.org.sessions, prompts: state.org.prompts, projects: [], groups: [], spaces: [] }
  return JSON.stringify({ t: 'snapshot', stream, epoch: EPOCH, seq, rows })
}
function publish(stream: string) {
  seq++
  for (const ws of sockets) if (ws.data.subs.has(stream)) ws.send(frame(stream))
}
const calls = (method: string, end: string) => state.calls.filter((c) => c.method === method && c.path.endsWith(end))

const server = Bun.serve({
  port: 0,
  async fetch(req, srv) {
    const url = new URL(req.url)
    const p = url.pathname
    const json = (body: unknown, status = 200) => Response.json(body, { status })
    if (p === '/ws2') return srv.upgrade(req, { data: { subs: new Set<string>() } }) ? undefined : new Response('no upgrade', { status: 400 })
    if (p === '/api/session') return json({ authed: true, setup: false, setupCode: false })
    let body: any
    if (p.startsWith('/api/')) {
      body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await req.json().catch(() => undefined)
      state.calls.push({ method: req.method, path: p, body })
    }
    if (p === '/api/settings') return json({})
    if (p === '/api/organize/prompts' && req.method === 'POST') {
      const q = { id: `q-${String(state.org.prompts.length + 1).padStart(12, '0')}`, name: body.name, text: body.text }
      state.org.prompts.push(q)
      setTimeout(() => publish('organize'), 30)
      return json(q)
    }
    const prompt = /^\/api\/organize\/prompts\/([^/]+)$/.exec(p)
    if (prompt) {
      const i = state.org.prompts.findIndex((q) => q.id === decodeURIComponent(prompt[1]!))
      if (i < 0) return json({ error: 'No such prompt' }, 404)
      if (req.method === 'DELETE') state.org.prompts.splice(i, 1)
      else Object.assign(state.org.prompts[i]!, body)
      setTimeout(() => publish('organize'), 30)
      return json(req.method === 'DELETE' ? { ok: true } : state.org.prompts[i])
    }
    const pane = /^\/api\/hosts\/([^/]+)\/panes\/([^/]+)\/(organize|files|send)$/.exec(p)
    if (pane) {
      const [host, id] = [decodeURIComponent(pane[1]!), `%${pane[2]}`]
      const found = state.hosts.find((h) => h.config.id === host)?.sessions.flatMap((s: Entry) => s.windows.flatMap((w: Entry) => w.panes)).find((x: Entry) => x.id === id)
      if (pane[3] === 'files') {
        // the second machine answers late, so "Still searching" shows
        if (host === 'build-box') await Bun.sleep(400)
        return json({ cwd: found?.cwd, files: FILES[found?.cwd] ?? [] })
      }
      if (pane[3] === 'send') return json({ ok: true })
      if (pane[3] === 'organize') {
        let m = state.org.sessions.find((x) => x.host === host && x.pane === id)
        if (!m) state.org.sessions.push((m = { id: `s-${state.org.sessions.length + 1}`, host, pane: id, live: true, seen: Date.now() }))
        if (body.pinned) m.pinned = 0
        setTimeout(() => publish('organize'), 30)
        return json({ session: m })
      }
    }
    if (p === '/theme.js' || p.startsWith('/agents/') || p === '/icon.svg') return new Response(Bun.file(path.join(web, p)))
    if (p === '/next' || p.startsWith('/next/')) {
      const rel = p.replace(/^\/next\/?/, '')
      const f = Bun.file(path.join(dist, rel))
      if (rel && (await f.exists())) return new Response(f, { headers: { 'content-security-policy': NEXT_CSP } })
      return new Response(Bun.file(path.join(dist, 'index.html')), { headers: { 'content-type': 'text/html;charset=utf-8', 'content-security-policy': NEXT_CSP } })
    }
    return new Response('Not found', { status: 404 })
  },
  websocket: {
    open(ws) {
      sockets.add(ws)
    },
    close(ws) {
      sockets.delete(ws)
    },
    message(ws, raw) {
      const msg = JSON.parse(String(raw))
      if (msg.t === 'hello') ws.send(JSON.stringify({ t: 'hello', v: 2 }))
      if (msg.t === 'sub' && ['overview', 'pages', 'organize'].includes(msg.stream)) {
        ws.data.subs.add(msg.stream)
        ws.send(frame(msg.stream))
      } else if (msg.t === 'sub') {
        ws.send(JSON.stringify({ t: 'snapshot', stream: msg.stream, epoch: EPOCH, seq: 1, rows: { items: [] }, state: { loaded: true, hasMore: false } }))
      }
      if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }))
    },
  },
})
const base = `http://127.0.0.1:${server.port}`

const problems: string[] = []
let last = ''
const check = (ok: unknown, what: string) => {
  last = what
  if (!ok) problems.push(what)
}

/** Text smaller than 12px, or a page wider than its window. */
async function layout(page: Page, label: string) {
  const small: string[] = await page.evaluate(() => {
    const out: string[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      if (!el || !n.textContent?.trim() || !el.getClientRects().length) continue
      const size = parseFloat(getComputedStyle(el).fontSize)
      if (size < 12) out.push(`${n.textContent.trim().slice(0, 30)} (${size}px)`)
    }
    return out
  })
  check(!small.length, `${label}: text under 12px: ${small.join(', ')}`)
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check(wide <= 0, `${label}: scrolls sideways by ${wide}px`)
}

async function until(ok: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms
  while (!(await ok()) && Date.now() < end) await Bun.sleep(50)
  return ok()
}

const styled = (page: Page) => page.waitForFunction(() => getComputedStyle(document.querySelector('.shell') ?? document.body).display === 'flex')
/** A sheet takes the keys a moment after it opens. */
const focusedIn = (page: Page) => page.waitForFunction(() => document.activeElement?.closest('[role=dialog]'))
const menuItems = (page: Page) => page.locator('.menu').last().locator('.menu-item').allTextContents()
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME, args: ['--disable-gpu'] } : {})
// the cold-start intro has its own check (settings.ts); here it would cover the first screen
const newContext = browser.newContext.bind(browser)
browser.newContext = async (o) => {
  const ctx = await newContext(o)
  await ctx.addInitScript(() => {
    try {
      sessionStorage.setItem('inyon.intro.seen', '1')
    } catch {}
  })
  return ctx
}
const errors: string[] = []
const watch = (page: Page) => {
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
}
const phone = { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' as const }
const desktop = { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const }
const reset = () => {
  state.hosts = overview(Date.now()).hosts as Entry[]
  state.org.sessions = []
  state.org.prompts = []
  state.calls = []
  publish('overview')
  publish('organize')
}
// the app reads the keys the way the browser reports the computer: Ctrl here, ⌘ on a Mac
const mac = process.platform === 'darwin'
const mod = mac ? 'Meta' : 'Control'
const searchKey = mac ? '⌘ K' : 'Ctrl K'
const newKey = mac ? '⌥ N' : 'Alt N'

try {
  for (const scheme of ['light', 'dark'] as const) {
    reset()
    const ctx = await browser.newContext({ ...desktop, colorScheme: scheme, permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await ctx.newPage()
    watch(page)
    await page.goto(`${base}/next/`)
    await styled(page)
    const label = `desktop ${scheme}`
    await page.locator('.card').nth(3).waitFor()
    const quick = page.getByRole('dialog', { name: 'Quick access' })
    const input = quick.getByRole('combobox')
    const rows = quick.getByRole('option')
    const titles = () => quick.locator('.quick-title').allTextContents()

    // the sidebar's two ways in, with their keys
    const search = page.locator('.sidebar').getByRole('button', { name: /Search or jump to/ })
    check((await search.textContent())?.includes(searchKey), `${label}: the search pill shows ${searchKey} (${await search.textContent()})`)
    const start = page.locator('.sidebar').getByRole('button', { name: /^New session/ })
    check((await start.textContent())?.includes(newKey), `${label}: New session shows ${newKey}`)

    // Ctrl K from anywhere: Sessions, every session, the box focused
    await page.locator('.content').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press(`${mod}+k`)
    await quick.waitFor()
    check(await quick.getByRole('tab', { name: 'Sessions' }).getAttribute('aria-selected') === 'true', `${label}: Ctrl K opens on Sessions`)
    check(await until(async () => (await rows.count()) === 4), `${label}: all four sessions listed (${await titles()})`)
    check(await input.evaluate((el) => el === document.activeElement), `${label}: the box takes the keys`)
    if (scheme === 'light') {
      await page.screenshot({ path: path.join(shots, 'quick-1440-sessions-light.png') })
      // a mark picks a tab: > for commands, @ for files
      await input.fill('>')
      check(await quick.getByRole('tab', { name: 'Commands' }).getAttribute('aria-selected') === 'true', `${label}: > switches to Commands`)
      await input.fill('')
      // Tab goes along the lists and wraps
      await input.press('Tab')
      check(await quick.getByRole('tab', { name: 'Saved prompts' }).getAttribute('aria-selected') === 'true', `${label}: Tab goes to the next list`)
      await input.press('Shift+Tab')
      await input.press('Shift+Tab')
      check(await quick.getByRole('tab', { name: 'Commands' }).getAttribute('aria-selected') === 'true', `${label}: Shift Tab goes back`)
      await input.press('Tab')
    }
    // fuzzy: a few letters find the session, Enter opens it
    await input.fill('passk')
    check(await until(async () => (await titles())[0] === 'Migrate auth to passkeys'), `${label}: "passk" finds the passkeys session first (${await titles()})`)
    check((await quick.locator('.quick-foot').textContent())?.includes('Terminal'), `${label}: the footer names Ctrl Enter's terminal`)
    await input.press('Enter')
    await quick.waitFor({ state: 'detached' })
    check(await until(() => page.url().endsWith('/next/m/local/p/12')), `${label}: Enter opens the session (${page.url()})`)

    // Ctrl Shift P: commands, this session's own first
    await page.keyboard.press(`${mod}+Shift+p`)
    await quick.waitFor()
    check(await quick.getByRole('tab', { name: 'Commands' }).getAttribute('aria-selected') === 'true', `${label}: Ctrl Shift P opens Commands`)
    await input.fill('pin')
    check(await until(async () => (await titles())[0] === 'Pin'), `${label}: "pin" finds Pin (${await titles()})`)
    check((await quick.locator('.quick-row-on .quick-sub').textContent()) === 'Migrate auth to passkeys', `${label}: for the session on screen`)
    await input.press('Enter')
    check(await until(() => calls('PATCH', '/organize').some((c) => c.path.includes('/local/') && c.body?.pinned === true)), `${label}: running it pins the session (${JSON.stringify(state.calls)})`)

    // saved prompts: save what's typed, then send it to the session on screen
    await page.keyboard.press(`${mod}+p`)
    await quick.getByRole('tab', { name: 'Saved prompts' }).click()
    check(await until(async () => (await quick.locator('.quick-note').textContent()) === 'No saved prompts yet'), `${label}: an empty list says so`)
    await input.fill('Run the tests and fix what fails')
    check((await titles()).at(-1) === 'Save “Run the tests and fix what fails” as a prompt…', `${label}: what's typed can be saved (${await titles()})`)
    await input.press('Enter')
    const sheet = page.getByRole('dialog', { name: 'New saved prompt' })
    await sheet.waitFor()
    check((await sheet.locator('textarea').inputValue()) === 'Run the tests and fix what fails', `${label}: the sheet starts with it`)
    await sheet.getByRole('textbox', { name: 'Name' }).fill('Fix the tests')
    await sheet.getByRole('button', { name: 'Save' }).click()
    check(await until(() => calls('POST', '/api/organize/prompts').length === 1), `${label}: saved through the hub`)
    await sheet.waitFor({ state: 'detached' })
    await page.keyboard.press(`${mod}+p`)
    await quick.getByRole('tab', { name: 'Saved prompts' }).click()
    check(await until(async () => (await titles())[0] === 'Fix the tests'), `${label}: the prompt is listed (${await titles()})`)
    check((await quick.locator('.quick-foot').textContent())?.includes('Send'), `${label}: Enter sends it to the session on screen`)
    if (scheme === 'dark') await page.screenshot({ path: path.join(shots, 'quick-1440-prompts-dark.png') })
    await input.press('Enter')
    check(await until(() => calls('POST', '/send').length === 1), `${label}: sent`)
    const sent = calls('POST', '/send')[0]
    check(sent?.path.includes('/local/') && sent.body?.text === 'Run the tests and fix what fails', `${label}: to that session, with the prompt's text (${JSON.stringify(sent)})`)
    check(await until(async () => (await page.locator('.toast', { hasText: 'Sent “Fix the tests” to Migrate auth to passkeys' }).count()) === 1), `${label}: a notice says where it went`)

    // Ctrl O: the files in the sessions' folders, the slow machine still searching for a moment
    await page.keyboard.press(`${mod}+o`)
    await quick.waitFor()
    check(await quick.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected') === 'true', `${label}: Ctrl O opens Files`)
    check(await until(async () => (await quick.locator('.quick-note', { hasText: 'Still searching' }).count()) === 1, 1500), `${label}: says it's still searching the slow machine`)
    check(await until(async () => (await rows.count()) === 7), `${label}: every session's files (${await titles()})`)
    await input.fill('chktest')
    check(await until(async () => (await titles())[0] === 'checkout.test.ts'), `${label}: "chktest" finds the test file (${await titles()})`)
    check((await quick.locator('.quick-row-on .quick-sub').textContent()) === 'storefront/src/checkout · studio', `${label}: with its folder and machine`)
    // Ctrl K inside the box: the row's menu
    await input.press(`${mod}+k`)
    await page.locator('.menu').waitFor()
    check((await menuItems(page)).join('|') === 'Copy path|Copy path in the folder|Open its session', `${label}: Ctrl K opens the row's menu (${await menuItems(page)})`)
    await page.locator('.menu .menu-item', { hasText: 'Copy path in the folder' }).click()
    check(await until(async () => (await page.evaluate(() => navigator.clipboard.readText()).catch(() => '')) === 'src/checkout/checkout.test.ts'), `${label}: the path in its folder is copied`)

    // right click on a row opens the same menu
    await page.keyboard.press(`${mod}+o`)
    await quick.waitFor()
    await rows.first().click({ button: 'right' })
    await page.locator('.menu').waitFor()
    check((await menuItems(page)).length === 3, `${label}: right click opens the row's menu`)
    await page.keyboard.press('Escape')
    await page.locator('.menu').waitFor({ state: 'detached' })
    await input.focus()
    await page.keyboard.press('Escape')
    await quick.waitFor({ state: 'detached' })

    // typing N in the box is just a letter
    await page.keyboard.press(`${mod}+p`)
    await input.type('n')
    check((await page.getByRole('dialog', { name: 'New session' }).count()) === 0, `${label}: N in the box doesn't start a session`)
    await page.keyboard.press('Escape')
    await quick.waitFor({ state: 'detached' })

    // Alt N and N start a session
    const newSheet = page.getByRole('dialog', { name: 'New session' })
    await page.keyboard.press('Alt+KeyN')
    await newSheet.waitFor()
    await focusedIn(page)
    await page.keyboard.press('Escape')
    await newSheet.waitFor({ state: 'detached' })
    await page.locator('.sidebar-foot').click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('n')
    check(await until(async () => (await newSheet.count()) === 1), `${label}: N with nothing focused starts a session`)
    await focusedIn(page)
    await page.keyboard.press('Escape')
    await newSheet.waitFor({ state: 'detached' })
    await start.click()
    await newSheet.waitFor()
    await focusedIn(page)
    await page.keyboard.press('Escape')
    await newSheet.waitFor({ state: 'detached' })

    // a right click on nothing in particular: Search… and New session…, with their keys
    await page.goto(`${base}/next/`)
    await page.locator('.card').nth(3).waitFor()
    await page.locator('.topbar').click({ button: 'right', position: { x: 700, y: 30 } })
    await page.locator('.menu').waitFor()
    const pageMenu = await page.locator('.menu .menu-item').evaluateAll((els) => els.map((e) => [...e.childNodes].filter((n) => n.nodeType !== Node.COMMENT_NODE).map((n) => n.textContent?.trim()).filter(Boolean).join(' ')))
    check(pageMenu.join('|') === `Search… ${searchKey}|New session… ${newKey}`, `${label}: the menu on empty space (${pageMenu})`)
    await page.locator('.menu .menu-item', { hasText: 'Search…' }).click()
    await quick.waitFor()
    await layout(page, label)
    // Esc closes it even with the focus somewhere else, as when the menu hands it back late
    await page.waitForTimeout(50)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Escape')
    await quick.waitFor({ state: 'detached', timeout: 3000 })

    // nothing online: New session adds a machine instead
    for (const h of state.hosts) h.status = 'error'
    publish('overview')
    await page.waitForTimeout(200)
    await start.click()
    check(await until(() => page.url().endsWith('/next/machines?add=1')), `${label}: with nothing online it adds a machine (${page.url()})`)
    await ctx.close()
  }

  // ---- phone: the tab bar's +, the Overview's search button, the box on the whole screen ----
  for (const scheme of ['light', 'dark'] as const) {
    reset()
    const ctx = await browser.newContext({ ...phone, colorScheme: scheme })
    const page = await ctx.newPage()
    watch(page)
    await page.goto(`${base}/next/`)
    await styled(page)
    const label = `phone ${scheme}`
    await page.locator('.card').nth(3).waitFor()
    const tabs = await page.locator('.tabbar > *').count()
    check(tabs === 5, `${label}: five places in the tab bar (${tabs})`)
    await page.screenshot({ path: path.join(shots, `quick-390-overview-${scheme}.png`) })
    await page.locator('.tabbar').getByRole('button', { name: 'New session' }).tap()
    const newSheet = page.getByRole('dialog', { name: 'New session' })
    await newSheet.waitFor()
    await newSheet.getByRole('button', { name: 'Close' }).tap()
    await newSheet.waitFor({ state: 'detached' })
    await page.locator('.topbar').getByRole('button', { name: 'Search' }).tap()
    const quick = page.getByRole('dialog', { name: 'Quick access' })
    await quick.waitFor()
    const box = (await quick.boundingBox())!
    check(box.x === 0 && box.y === 0 && box.width === 390 && box.height === 844, `${label}: the box takes the screen (${JSON.stringify(box)})`)
    check(await until(async () => (await quick.getByRole('option').count()) === 4), `${label}: the sessions are listed`)
    check(await quick.locator('.quick-foot').isHidden(), `${label}: no key hints on a touch screen`)
    await page.screenshot({ path: path.join(shots, `quick-390-${scheme}.png`) })
    await layout(page, label)
    // each row has a ⋯ for its menu
    await quick.getByRole('button', { name: 'More for Write release notes' }).tap()
    await page.locator('.menu').waitFor()
    check((await menuItems(page)).includes('Open terminal'), `${label}: the ⋯ opens the session's menu (${await menuItems(page)})`)
    await page.keyboard.press('Escape')
    await page.locator('.menu').waitFor({ state: 'detached' })
    await quick.getByRole('option').filter({ hasText: 'Tidy the billing API types' }).tap()
    check(await until(() => page.url().endsWith('/next/m/build-box/p/14')), `${label}: a tap opens the session (${page.url()})`)
    await ctx.close()
  }
} catch (e) {
  console.error(`stopped after "${last}"`)
  if (problems.length) console.error(problems.join('\n'))
  throw e
} finally {
  await browser.close()
  server.stop(true)
}

const unexpected = errors.filter((e) => !/WebSocket|status of 404/.test(e))
check(!unexpected.length, `errors in the page: ${unexpected.join(' | ')}`)
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`ok: Quick access at 1440x900 and 390x844 in light and dark: the sidebar's search and New session, Ctrl K, P, Shift P and O, tabs and marks, opening a session, a command on it, saving and sending a prompt, files, row menus by Ctrl K, right click and ⋯, Alt N and N, the menu on empty space, adding a machine with nothing online, the tab bar's + and the search button; screenshots in ${shots}`)
