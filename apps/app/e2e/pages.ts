// bun apps/app/e2e/pages.ts — Blueprints in the built app (apps/app/dist, from build.sh) in Chromium behind
// a stand-in hub: the page under the hub's own CSP for /next, the /ws2 overview and pages streams, the
// page endpoints and made-up sites under /v/<token>/. Checks the list and the viewer at phone and
// desktop sizes in light and dark, the sandboxed frame and its theme, live progress, the changed
// marks and badges, the right-click, long-press and ⋯ menus, parts, notes and device sizes, revoking,
// removing with Undo, adding a folder, the Folder sheet, grouping by tmux session, a machine's pages,
// a session's pages (beside the chat, or in a sheet on a phone) and the pages a reply links to, and
// saves a screenshot of each size and theme to $SHOTS (default: a temp folder). CHROME=/path/to/chrome
// uses a browser other than Playwright's own.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, devices, type Page } from 'playwright'
import type { ServerWebSocket } from 'bun'
import { info, overview } from './demo.ts'
import { resetShares, shareRoute, shares } from './share-hub.ts'
import { capture } from './failure.ts'

const root = path.join(import.meta.dir, '../../..')
const dist = path.join(import.meta.dir, '../dist')
const web = path.join(root, 'apps/web/public')
const shots = process.env.SHOTS ?? path.join(tmpdir(), 'inyon-app-shots')
mkdirSync(shots, { recursive: true })

// the policy the hub sends with the page, read from the hub's source so the two can't drift
const rs = await Bun.file(path.join(root, 'crates/inyon-hub/src/static_files.rs')).text()
const NEXT_CSP = /pub const NEXT_CSP: &str =\s*"([^"]+)"/.exec(rs)![1]!

type Entry = Record<string, any>
const HOUR = 3600_000
function pages(now: number): Entry[] {
  return [
    {
      host: 'local', slug: 'checkout-redesign', name: 'Checkout redesign', project: '/home/sam/code/storefront', by: 'claude', added: now - 26 * HOUR,
      folder: '/home/sam/code/storefront/private/plans/checkout-redesign', notes: ['Field notes.md', 'Competitors.md'],
      progress: { done: 3, total: 8, now: 'Wiring the payment step to the new cart', updated: new Date(now - 4 * 60_000).toISOString() },
      // made by the conversation running in the storefront tmux session now
      session: 'chat-store-2', tmux: 'storefront', tmuxId: '$11',
    },
    // an earlier conversation in the same tmux session, in another folder
    {
      host: 'local', slug: 'cart-mockups', name: 'Cart mockups', project: '/home/sam/code/cart-lab', by: 'claude', added: now - 30 * HOUR, folder: '/home/sam/code/cart-lab/private/plans/cart-mockups',
      session: 'chat-store-1', tmux: 'storefront', tmuxId: '$11',
    },
    {
      host: 'local', slug: 'passkeys', name: 'Passkeys rollout', project: '/home/sam/code/accounts', by: 'codex', added: now - 3 * HOUR, folder: '/home/sam/code/accounts/private/plans/passkeys',
      session: 'chat-acc', tmux: 'accounts', tmuxId: '$12',
    },
    {
      host: 'build-box', slug: 'release-notes', name: 'Release notes site', project: '/home/sam/code/docs-site', by: 'cli', added: now - 50 * HOUR, folder: '/home/sam/code/docs-site/private/plans/release-notes',
      progress: { done: 6, total: 6, updated: new Date(now - 2 * HOUR).toISOString() },
    },
  ]
}

/** The demo machines, with the conversations the pages above were made in running. */
function hosts(): Entry[] {
  const h = overview(Date.now()).hosts as Entry[]
  h[0]!.sessions[0].windows[0].panes[0].agent.sessionId = 'chat-store-2'
  h[0]!.sessions[1].windows[0].panes[0].agent.sessionId = 'chat-acc'
  return h
}

const state = {
  hosts: hosts(),
  pages: pages(Date.now()),
  calls: [] as { method: string; path: string; body?: unknown }[],
  minted: 0,
  /** what the hub's last clean-up took off, until dismissed */
  cleaned: { pages: [] } as { at?: number; days?: number; pages: unknown[] },
  /** the socket is refused, as behind a proxy that drops WebSockets; then GET /api/pages fails too */
  noSocket: false,
  listFails: false,
}
type Socket = ServerWebSocket<{ subs: Set<string> }>
const sockets = new Set<Socket>()
let seq = 1
const EPOCH = 1
const frame = (stream: string) =>
  JSON.stringify({ t: 'snapshot', stream, epoch: EPOCH, seq, rows: stream === 'overview' ? { hosts: state.hosts } : { pages: state.pages } })
/** The pages changed: every socket following them hears it. */
function publishPages() {
  seq++
  for (const ws of sockets) if (ws.data.subs.has('pages')) ws.send(frame('pages'))
}
/** The machines changed (a session renamed): every socket following the overview hears it. */
function publishOverview() {
  seq++
  for (const ws of sockets) if (ws.data.subs.has('overview')) ws.send(frame('overview'))
}
const called = (method: string, p: string) => state.calls.filter((c) => c.method === method && c.path === p)

/** A reply that links to a page, as `inyon blueprints add` prints it. */
function chat(now: number) {
  const ts = (ago: number) => new Date(now - ago * 1000).toISOString()
  return [
    { kind: 'user', seq: 1, uuid: 'u1', ts: ts(300), text: 'Make a plan page for the checkout redesign.', images: 0 },
    { kind: 'assistant', seq: 2, uuid: 'u2', ts: ts(200), msgId: 'm2', block: { type: 'text', text: 'The plan is up. Open it in the app at /blueprints/local/checkout-redesign' } },
    { kind: 'turn_end', seq: 3, uuid: 'u3', ts: ts(199), durationMs: 41000 },
  ]
}

/** A made-up site: it starts in the theme its address asks for, asks the app for it, and keeps the answer. */
const site = (title: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:32px;background:#fff;color:#111}[data-theme=dark] body{background:#111;color:#eee}</style></head>
<body><h1>${title}</h1><p id="theme"></p><script>
const show = (t) => { document.documentElement.dataset.theme = t; document.getElementById('theme').textContent = 'theme ' + t }
show(new URLSearchParams(location.search).get('theme') || 'light')
addEventListener('message', (e) => { if (e.data && e.data.type === 'theme') { show(e.data.value); document.body.dataset.answered = '1' } })
parent.postMessage({ type: 'theme?' }, '*')
</script></body></html>`

const server = Bun.serve({
  port: 0,
  async fetch(req, srv) {
    const url = new URL(req.url)
    const p = url.pathname
    const json = (body: unknown, status = 200) => Response.json(body, { status })
    if (p === '/ws2' && state.noSocket) return new Response('no upgrade', { status: 502 })
    if (p === '/ws2') return srv.upgrade(req, { data: { subs: new Set<string>() } }) ? undefined : new Response('no upgrade', { status: 400 })
    if (p === '/api/session') return json({ authed: true, setup: false, setupCode: false })
    if (p.startsWith('/api/')) {
      const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await req.json().catch(() => undefined)
      state.calls.push({ method: req.method, path: p + url.search, body })
    }
    if (p === '/api/settings') return json({})
    const shared = shareRoute(req.method, p, state.calls.at(-1)?.body)
    if (shared) return shared
    // the list over REST, for when the socket doesn't come
    if (p === '/api/pages' && req.method === 'GET') return state.listFails ? json({ error: 'The hub is busy' }, 503) : json({ pages: state.pages })
    if (p === '/api/pages-cleaned') {
      if (req.method === 'DELETE') state.cleaned = { pages: [] }
      return req.method === 'DELETE' ? json({ ok: true }) : json(state.cleaned)
    }
    const m = /^\/api\/pages\/([^/]+)(?:\/([^/]+))?(\/open|\/revoke)?$/.exec(p)
    if (m) {
      const host = decodeURIComponent(m[1]!)
      const slug = m[2] && decodeURIComponent(m[2])
      if (!slug && req.method === 'POST') {
        const b = state.calls.at(-1)!.body as { path: string; name?: string; slug?: string }
        if (!b.path.endsWith('/plan') && !b.slug) return json({ error: 'No index.html in that folder' }, 400)
        const added = { host, slug: b.slug ?? 'new-plan', name: b.name ?? 'plan', project: '/home/sam/code/new', by: 'app', added: Date.now(), folder: b.path }
        state.pages.push(added)
        setTimeout(publishPages, 100)
        return json(added)
      }
      const page = state.pages.find((x) => x.host === host && x.slug === slug)
      if (!page) return json({ error: 'No such page' }, 404)
      if (m[3] === '/open') {
        state.minted++
        return json({ url: `/v/tok-${slug}-${state.minted}/`, expires: Date.now() + 12 * HOUR, ttl: 12 * HOUR })
      }
      if (m[3] === '/revoke') return json({ ok: true })
      if (req.method === 'DELETE') {
        state.pages = state.pages.filter((x) => x !== page)
        setTimeout(publishPages, 100)
        return json({ ok: true })
      }
    }
    const v = /^\/v\/tok-([a-z0-9-]+?)-\d+\/(.*)$/.exec(p)
    if (v) {
      const [slug, rest] = [v[1]!, v[2]!]
      const page = state.pages.find((x) => x.slug === slug)
      const html = (body: string) => new Response(req.method === 'HEAD' ? null : body, { headers: { 'content-type': 'text/html;charset=utf-8' } })
      if (!page) return new Response('gone', { status: 404 })
      if (rest === '') return html(site(page.name))
      if (rest === 'mockups/') return html(site(`${page.name}: mockups`))
      if (rest.startsWith('research/') && url.searchParams.get('as') === 'note') return html(site(`Note: ${decodeURIComponent(rest.slice(9))}`))
      return new Response('Not found', { status: 404 })
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
      if (msg.t === 'sub' && (msg.stream === 'overview' || msg.stream === 'pages')) {
        ws.data.subs.add(msg.stream)
        ws.send(frame(msg.stream))
      } else if (msg.t === 'sub') {
        const now = Date.now()
        ws.send(JSON.stringify({ t: 'snapshot', stream: msg.stream, epoch: EPOCH, seq: 1, rows: { items: chat(now) }, state: { info: info('local', '%11', 'claude', { title: 'Fix flaky checkout test' }), loaded: true, hasMore: false } }))
      }
      if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }))
    },
  },
})
const base = `http://127.0.0.1:${server.port}`

const problems: string[] = []
const check = (ok: unknown, what: string) => {
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

/** The app's stylesheet is in: Dioxus adds it as the app starts, so the first screen can come before it. */
const styled = (page: Page) => page.waitForFunction(() => getComputedStyle(document.querySelector('.shell') ?? document.body).display === 'flex')

const wide = (size: string) => size === '1440'
const menuItems = (page: Page) => page.getByRole('menu').locator('.menu-item').allTextContents()
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
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
  state.cleaned = { at: Date.now(), days: 14, pages: [{ host: 'local', slug: 'old-plan', name: 'Old plan', folder: '/home/sam/code/storefront/private/plans/old-plan' }, { host: 'local', slug: 'spike', name: 'Search spike', folder: '/home/sam/code/storefront/private/plans/spike' }] }
  state.pages = pages(Date.now())
  state.hosts = hosts()
  state.noSocket = false
  state.listFails = false
  resetShares()
  publishPages()
  publishOverview()
}

try {
  // ---- phone: the list and the viewer, in both themes ----
  for (const scheme of ['light', 'dark'] as const) {
    reset()
    const ctx = await browser.newContext({ ...phone, colorScheme: scheme })
    const page = await ctx.newPage()
    watch(page)
    await page.goto(`${base}/next/blueprints`)
    await page.getByRole('heading', { name: 'Blueprints' }).waitFor()
    await page.locator('.page-card').nth(3).waitFor()
    await styled(page)
    const label = `phone ${scheme}`
    // by tmux session first, whichever conversation made the page, then by project; the machine a label
    const headings = await page.locator('.pages-group-head .group-heading-name').allTextContents()
    check(headings.join(',') === 'accounts,storefront,docs-site', `${label}: grouped by tmux session, then project (${headings.join(',')})`)
    check((await page.locator('.pages-group-head .group-machine').allTextContents()).join(',') === 'studio,studio,build-box', `${label}: each heading's machine`)
    const store = page.locator('.pages-group', { hasText: 'storefront' })
    check((await store.locator('.page-card-name').allTextContents()).join(',') === 'Checkout redesign,Cart mockups', `${label}: both of the session's sites under it`)
    const card = page.locator('.page-card', { hasText: 'Checkout redesign' })
    check((await card.textContent())?.includes('3/8'), `${label}: the card's progress`)
    check(await card.getByText('Wiring the payment step to the new cart').isVisible(), `${label}: what it's working on`)
    check((await card.getAttribute('aria-label'))?.startsWith('Checkout redesign, changed, 3 of 8 done'), `${label}: the card's label`)
    check((await page.locator('.changed-dot').count()) === 4, `${label}: every page new here is marked`)
    check((await page.locator('.tab-badge-pages').textContent()) === '4', `${label}: the tab bar counts changed pages`)
    // what the hub cleaned up, in one line over the list
    const cleaned = page.locator('.cleaned-line')
    check((await cleaned.textContent()) === "Cleaned up 2 blueprints: their sessions ended and they hadn't changed in 14 days. Folders stay where they were.", `${label}: the clean-up line (${await cleaned.textContent()})`)
    check((await cleaned.getAttribute('title')) === 'Old plan, Search spike', `${label}: the clean-up line names them`)
    await page.screenshot({ path: path.join(shots, `pages-390-${scheme}.png`) })
    await layout(page, label)
    const dismissed = called('DELETE', '/api/pages-cleaned').length
    await cleaned.getByRole('button', { name: 'Dismiss' }).click()
    check(await until(() => called('DELETE', '/api/pages-cleaned').length === dismissed + 1), `${label}: dismissed on the hub`)
    check((await cleaned.count()) === 0, `${label}: the clean-up line goes`)

    // live progress, from the stream
    state.pages[0]!.progress = { ...state.pages[0]!.progress, done: 4, updated: new Date().toISOString() }
    publishPages()
    check(await until(async () => (await card.textContent())?.includes('4/8') ?? false), `${label}: progress moves without a reload`)

    if (scheme === 'light') {
      // the ⋯ menu and a long press give the same items
      await card.getByRole('button', { name: 'More for Checkout redesign' }).click()
      check((await menuItems(page)).join('|').startsWith('Open|Open in browser'), `${label}: the ⋯ menu (${await menuItems(page)})`)
      check((await menuItems(page)).join('|').includes('Revoke links|Show folder|Remove'), `${label}: the ⋯ menu's other items`)
      await page.keyboard.press('Escape')
      await page.getByRole('menu').waitFor({ state: 'detached' })
      // Enter on ⋯ opens its menu and leaves the card where it is
      await card.getByRole('button', { name: 'More for Checkout redesign' }).focus()
      await page.keyboard.press('Enter')
      await page.getByRole('menu').waitFor()
      check(page.url().endsWith('/blueprints'), `${label}: Enter on ⋯ didn't open the page`)
      await page.keyboard.press('Escape')
      await page.getByRole('menu').waitFor({ state: 'detached' })
      const other = page.locator('.page-card', { hasText: 'Passkeys rollout' })
      const box = (await other.boundingBox())!
      const cdp = await ctx.newCDPSession(page)
      const pt = { x: box.x + 60, y: box.y + box.height - 12 }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] })
      await page.waitForTimeout(700)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.getByRole('menu').waitFor()
      check((await menuItems(page))[0] === 'Open', `${label}: long press opens the menu`)
      check(page.url().endsWith('/blueprints'), `${label}: the long press didn't open the page`)
      await page.mouse.click(200, 120)
      await page.getByRole('menu').waitFor({ state: 'detached' })
    }

    // the viewer
    await card.click()
    await page.waitForURL(/\/next\/blueprints\/local\/checkout-redesign$/)
    const iframe = page.locator('iframe.page-frame')
    await iframe.waitFor()
    check(await page.getByText('Sandboxed page: never sign in here').isVisible(), `${label}: the sandbox line`)
    check((await iframe.getAttribute('sandbox')) === 'allow-scripts allow-forms allow-popups allow-downloads', `${label}: the frame's sandbox`)
    check((await iframe.getAttribute('referrerpolicy')) === 'no-referrer', `${label}: no referrer`)
    check(/^\/v\/tok-checkout-redesign-\d+\/\?theme=/.test((await iframe.getAttribute('src')) ?? ''), `${label}: the frame's address (${await iframe.getAttribute('src')})`)
    check(!(await page.locator('.tabbar').isVisible()), `${label}: the viewer has the screen to itself`)
    const inside = page.frameLocator('iframe.page-frame')
    await inside.getByRole('heading', { name: 'Checkout redesign' }).waitFor()
    check(await until(async () => (await inside.locator('body').getAttribute('data-answered')) === '1'), `${label}: the app answers the page's theme question`)
    check((await inside.locator('#theme').textContent()) === `theme ${scheme}`, `${label}: the page in the app's theme`)
    await page.screenshot({ path: path.join(shots, `pages-viewer-390-${scheme}.png`) })
    await layout(page, `${label} viewer`)
    // the bar: the way back, the name with its session, machine and part under it, and ⋯
    const bar = page.locator('.viewer-head-row')
    check((await bar.getByRole('button').count()) === 2, `${label}: only Back and More in the bar (${await bar.getByRole('button').count()})`)
    check((await page.locator('.viewer-titles .viewer-where').textContent()) === 'storefront · studio', `${label}: the session and machine under the name (${await page.locator('.viewer-titles .viewer-where').textContent()})`)
    check((await page.locator('.viewer-part').textContent()) === ' · Plan', `${label}: and the part on screen`)
    // at 360px the name still has room
    await page.setViewportSize({ width: 360, height: 800 })
    const title = await page.locator('.viewer-title').evaluate((el) => el.getBoundingClientRect().width)
    check(title >= 200, `${label}: the name has room at 360px (${title}px)`)
    await page.screenshot({ path: path.join(shots, `pages-viewer-360-${scheme}.png`) })
    // parts, notes, the machine's other pages and the machine itself, from ⋯
    await page.getByRole('button', { name: 'More', exact: true }).click()
    const more = await menuItems(page)
    check(more.slice(0, 4).join('|') === 'Reload|Open in browserA 12 h link. Never sign in there|Plan|Mockups', `${label}: the More menu starts with Reload, the browser and the parts (${more.join('|')})`)
    check(more.includes('Field notes') && more.includes('Cart mockups') && more.at(-1) === 'Open studio', `${label}: then the notes, the machine's pages and the machine (${more.join('|')})`)
    await page.screenshot({ path: path.join(shots, `pages-viewer-menu-360-${scheme}.png`) })
    await page.getByRole('menuitemradio', { name: 'Field notes' }).click()
    await inside.getByRole('heading', { name: 'Note: Field notes.md' }).waitFor()
    check(await page.locator('.note-line').getByText('Field notes').isVisible(), `${label}: the open note's line`)
    check(!(await page.locator('.viewer-part').count()), `${label}: no part named while a note is open`)
    await page.getByRole('button', { name: 'Back to Plan' }).click()
    await inside.getByRole('heading', { name: 'Checkout redesign' }).waitFor()
    await page.setViewportSize(phone.viewport)
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Mockups', exact: true }).click()
    await inside.getByRole('heading', { name: 'Checkout redesign: mockups' }).waitFor()
    check((await page.locator('.viewer-part').textContent()) === ' · Mockups', `${label}: the part follows`)
    // back to the list: the page is no longer marked, here or in the badge, and that's kept
    await page.getByRole('button', { name: 'Back to Blueprints' }).click()
    await page.waitForURL(/\/next\/blueprints$/)
    await page.locator('.page-card').first().waitFor()
    check((await page.locator('.page-card', { hasText: 'Checkout redesign' }).locator('.changed-dot').count()) === 0, `${label}: an opened page loses its mark`)
    check((await page.locator('.tab-badge-pages').textContent()) === '3', `${label}: the badge counts one fewer`)
    const seen = await page.evaluate(() => JSON.parse(localStorage.getItem('inyon.pages.seen.v1') ?? '{}'))
    check(typeof seen['local/checkout-redesign'] === 'number', `${label}: the mark is kept with the web app's key`)
    await ctx.close()
  }

  // ---- desktop: the tree and the viewer, in both themes ----
  for (const scheme of ['light', 'dark'] as const) {
    reset()
    const ctx = await browser.newContext({ ...desktop, colorScheme: scheme })
    const page = await ctx.newPage()
    watch(page)
    await page.goto(`${base}/next/blueprints`)
    await styled(page)
    const label = `desktop ${scheme}`
    // nothing picked: the first changed page in the tree opens (the hub's machine, its projects by name)
    await page.waitForURL(/\/next\/blueprints\/local\/passkeys$/)
    check(await page.locator('.pages-tree-list .cleaned-line').isVisible(), `${label}: the clean-up line in the tree`)
    await page.locator('.tree-row', { hasText: 'Checkout redesign' }).click()
    await page.waitForURL(/\/next\/blueprints\/local\/checkout-redesign$/)
    const inside = page.frameLocator('iframe.page-frame')
    await inside.getByRole('heading', { name: 'Checkout redesign' }).waitFor()
    check((await page.locator('.tree-row').count()) === 4, `${label}: four rows in the tree`)
    check((await page.locator('.tree-row-on').textContent())?.includes('Checkout redesign'), `${label}: the open page is lit`)
    check((await page.locator('.crumbs').textContent())?.replace(/\s+/g, '') === 'studio/storefront/Checkoutredesign', `${label}: where it is (${await page.locator('.crumbs').textContent()})`)
    {
      // with the room a wide screen gives, the bar is one row
      await page.locator('.viewer-bar .notes-button').waitFor()
      const bar = await page.evaluate((() => { const r = (s: string) => document.querySelector(s)!.getBoundingClientRect(); return { crumbs: Math.round(r('.crumbs').width), bar: Math.round(r('.viewer-bar').height), below: Math.round(r('.viewer-bar [aria-label="Frame size"]').top - r('.crumbs').top) } }))
      check(bar.bar === 52 && bar.below < 20 && bar.crumbs >= 200, `${label}: the viewer's bar is one row (${JSON.stringify(bar)})`)
    }
    // the site's parts: a plan and mockups, no matrix
    const parts = page.getByRole('radiogroup', { name: 'Part of the blueprint' })
    await parts.waitFor()
    check((await parts.getByRole('radio').allTextContents()).join(',') === 'Plan,Mockups', `${label}: the parts it has`)
    check((await page.locator('.viewer-foot').textContent())?.includes('link lasts 11 h 59 m') || (await page.locator('.viewer-foot').textContent())?.includes('link lasts 12 h 0 m'), `${label}: how long the link lasts (${await page.locator('.viewer-foot').textContent()})`)
    await page.screenshot({ path: path.join(shots, `pages-1440-${scheme}.png`) })
    await layout(page, label)
    if (scheme === 'light') {
      await parts.getByRole('radio', { name: 'Mockups' }).click()
      await inside.getByRole('heading', { name: 'Checkout redesign: mockups' }).waitFor()
      // a device size shrinks the frame to fit
      await page.getByRole('radio', { name: 'Desktop 1440 × 900' }).click()
      check(await until(async () => /Desktop · 1440 × 900 · \d+%/.test((await page.locator('.viewer-size').textContent()) ?? '')), `${label}: the device size (${await page.locator('.viewer-size').textContent()})`)
      await page.getByRole('radio', { name: 'Phone 390 × 844' }).click()
      check(await until(async () => (await page.locator('.viewer-size').textContent())?.startsWith('Phone · 390 × 844') ?? false), `${label}: the phone size`)
      await page.screenshot({ path: path.join(shots, `pages-device-1440-${scheme}.png`) })
      await page.getByRole('radio', { name: 'Fit the pane' }).click()
      // notes
      await page.getByRole('button', { name: 'Notes', exact: true }).click()
      await page.getByRole('menuitemradio', { name: 'Competitors' }).click()
      await inside.getByRole('heading', { name: 'Note: Competitors.md' }).waitFor()
      check((await page.locator('iframe.page-frame').getAttribute('src'))?.includes('research/Competitors.md?as=note&theme=light'), `${label}: a note's address`)
      // Reload and clicking the open page again both mint a new link
      const before = state.minted
      await page.getByRole('button', { name: 'Reload' }).click()
      check(await until(() => state.minted === before + 1), `${label}: Reload mints a new link`)
      await page.locator('.tree-row-on').click()
      check(await until(() => state.minted === before + 2), `${label}: the open page clicked again mints a new link`)
      // "/" goes to the filter
      await page.locator('.crumbs').click()
      await page.keyboard.press('/')
      check(await page.evaluate(() => document.activeElement?.id === 'pages-filter'), `${label}: "/" focuses the filter`)
      await page.keyboard.type('release')
      check(await until(async () => (await page.locator('.tree-row').count()) === 1), `${label}: the filter narrows the tree`)
      await page.keyboard.press('Escape')
      check(await until(async () => (await page.locator('.tree-row').count()) === 4), `${label}: Esc clears the filter`)

      // revoke from the ⋯ menu, after asking
      await page.getByRole('button', { name: 'More for Checkout redesign' }).click()
      await page.getByRole('menuitem', { name: 'Revoke links' }).click()
      const ask = page.getByRole('dialog', { name: 'Revoke links to “Checkout redesign”?' })
      await ask.waitFor()
      const minted = state.minted
      await ask.getByRole('button', { name: 'Revoke links' }).click()
      check(await until(() => called('POST', '/api/pages/local/checkout-redesign/revoke').length === 1), `${label}: revoked`)
      check(await until(() => state.minted === minted + 1), `${label}: the open viewer gets a new link at once`)
      await page.getByText('Links revoked').waitFor()

      // the Folder sheet
      await page.locator('.tree-row', { hasText: 'Passkeys rollout' }).click({ button: 'right' })
      check((await menuItems(page)).join('|').startsWith('Open|Open in browser'), `${label}: a row's right-click menu`)
      await page.getByRole('menuitem', { name: 'Show folder' }).click()
      const folder = page.getByRole('dialog', { name: 'Folder' })
      await folder.waitFor()
      check(await folder.getByText('/home/sam/code/accounts/private/plans/passkeys').isVisible(), `${label}: the folder's path`)
      check(await folder.getByText('codex ·').isVisible(), `${label}: who added it`)
      await folder.getByRole('button', { name: 'Close' }).click()
      await folder.waitFor({ state: 'detached' })

      // remove, then Undo
      await page.locator('.tree-row', { hasText: 'Passkeys rollout' }).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Remove' }).click()
      check(await until(async () => (await page.locator('.tree-row').count()) === 3), `${label}: removed from the tree`)
      check(called('DELETE', '/api/pages/local/passkeys').length === 1, `${label}: the hub was asked to remove it`)
      const toast = page.locator('.toast', { hasText: 'Removed “Passkeys rollout”' })
      await toast.waitFor()
      check(await toast.getByText('The folder stays on studio.').isVisible(), `${label}: the remove toast says the folder stays`)
      await toast.getByRole('button', { name: 'Undo' }).click()
      check(await until(() => called('POST', '/api/pages/local').length === 1), `${label}: Undo adds it back`)
      check(
        JSON.stringify(called('POST', '/api/pages/local')[0]?.body) === JSON.stringify({ path: '/home/sam/code/accounts/private/plans/passkeys', name: 'Passkeys rollout', slug: 'passkeys' }),
        `${label}: with its name and slug (${JSON.stringify(called('POST', '/api/pages/local')[0]?.body)})`,
      )
      check(await until(async () => (await page.locator('.tree-row').count()) === 4), `${label}: back in the tree`)

      // add a folder
      await page.getByRole('button', { name: 'Add a folder' }).first().click()
      const add = page.getByRole('dialog', { name: 'Add a folder' })
      await add.waitFor()
      await add.getByLabel('Folder').fill('./private/plans/plan')
      await add.getByRole('button', { name: 'Add', exact: true }).click()
      await add.getByText('Give the full path, starting with /.').waitFor()
      await add.getByLabel('Folder').fill('/home/sam/code/new/private/plans/plan')
      await add.getByLabel('Name').fill('New plan')
      await add.getByRole('button', { name: 'Add', exact: true }).click()
      await page.getByText('Added “New plan”').waitFor()
      check(await until(async () => (await page.locator('.tree-row').count()) === 5), `${label}: the new page is listed`)
      await layout(page, `${label} after the menus`)
    }
    await ctx.close()
  }

  // ---- the pages other screens list ----
  {
    reset()
    const ctx = await browser.newContext({ ...desktop, colorScheme: 'light' })
    const page = await ctx.newPage()
    watch(page)
    await page.goto(`${base}/next/machines/local`)
    await styled(page)
    const section = page.locator('.machine-pages')
    await section.waitFor()
    check(await section.getByRole('heading', { name: 'Blueprints on this machine' }).isVisible(), 'machine: its pages section')
    check((await section.locator('.page-row').count()) === 3, 'machine: its three pages')
    await page.screenshot({ path: path.join(shots, 'machine-pages-1440-light.png'), fullPage: true })
    await ctx.close()
  }

  // ---- a session's pages beside its chat, as artifacts open, in both themes ----
  // (from 1180 px they're the side panel's Blueprints tab, checked after this; narrower, the side view)
  for (const scheme of ['light', 'dark'] as const) {
    reset()
    const ctx = await browser.newContext({ ...desktop, viewport: { width: 1100, height: 900 }, colorScheme: scheme })
    const page = await ctx.newPage()
    watch(page)
    const label = `session desktop ${scheme}`
    await page.goto(`${base}/next/m/local/p/11`)
    await styled(page)
    const reply = page.locator('.reply-pages')
    await reply.waitFor()
    check((await reply.locator('.page-row').textContent())?.includes('Checkout redesign'), `${label}: the page a reply links to`)
    // this conversation's page and the tmux session's earlier one; not the accounts session's, nor another machine's
    const button = page.getByRole('button', { name: 'Blueprints: 2, changed' })
    await button.click()
    const side = page.getByRole('complementary', { name: 'Blueprints' })
    await side.waitFor()
    check((await button.getAttribute('aria-pressed')) === 'true', `${label}: the button shows the panel is open`)
    check((await side.locator('.side-label').allTextContents()).join('|') === 'This conversation|Earlier in storefront', `${label}: this conversation's first (${await side.locator('.side-label').allTextContents()})`)
    check((await side.locator('.side-row-name').allTextContents()).join('|') === 'Checkout redesign|Cart mockups', `${label}: the rows`)
    check(await side.locator('.side-tmux').getByText('storefront').isVisible(), `${label}: the tmux session in the panel's head`)
    check(await page.locator('.chat-column').first().isVisible(), `${label}: the chat stays beside it`)
    await page.screenshot({ path: path.join(shots, `session-side-1100-${scheme}.png`) })
    await layout(page, `${label} list`)
    // live: a page the conversation adds shows up at once
    state.pages.push({ host: 'local', slug: 'promo-codes', name: 'Promo codes', project: '/home/sam/code/storefront', by: 'claude', added: Date.now(), folder: '/home/sam/code/storefront/private/plans/promo-codes', session: 'chat-store-2', tmux: 'storefront', tmuxId: '$11' })
    publishPages()
    check(await until(async () => (await side.locator('.side-row-name').allTextContents()).join('|') === 'Promo codes|Checkout redesign|Cart mockups'), `${label}: a new page comes live, newest first`)
    await page.getByRole('button', { name: 'Blueprints: 3, changed' }).waitFor()
    // it opens in the panel, saying which page, session and machine
    await side.locator('.side-row', { hasText: 'Checkout redesign' }).click()
    const inside = page.frameLocator('.session-side iframe.page-frame')
    await inside.getByRole('heading', { name: 'Checkout redesign' }).waitFor()
    check((await side.locator('.viewer-name').textContent()) === 'Checkout redesign', `${label}: the open page's name`)
    check((await side.locator('.viewer-where').textContent()) === 'storefront · studio', `${label}: its session and machine (${await side.locator('.viewer-where').textContent()})`)
    check(!(await side.getByRole('radiogroup', { name: 'Frame size' }).count()), `${label}: no device sizes in the panel`)
    check(page.url().endsWith('/next/m/local/p/11'), `${label}: still on the session`)
    for (const name of ['Reload', 'Open full view', 'Open in new tab']) check(await side.getByRole('button', { name, exact: true }).isVisible(), `${label}: ${name} in the side view`)
    await page.screenshot({ path: path.join(shots, `session-side-viewer-1100-${scheme}.png`) })
    await layout(page, `${label} viewer`)
    if (scheme === 'dark') {
      // Open full view: the Blueprints screen, with the page
      await side.getByRole('button', { name: 'Open full view' }).click()
      await page.waitForURL(/\/next\/blueprints\/local\/checkout-redesign$/)
      // beside the sidebar and the tree the viewer is 556px: the bar takes two rows, so its parts,
      // notes and frame sizes leave the page's location its room (on one row it shrank to nothing)
      await page.locator('.viewer-bar .notes-button').waitFor()
      await page.locator('.crumbs').waitFor()
      const bar = await page.evaluate((() => { const r = (s: string) => document.querySelector(s)!.getBoundingClientRect(); return { crumbs: Math.round(r('.crumbs').width), bar: Math.round(r('.viewer-bar').height), below: Math.round(r('.viewer-bar [aria-label="Frame size"]').top - r('.crumbs').top) } }))
      check(bar.crumbs >= 200, `${label}: the full viewer says where the page is at this width (${JSON.stringify(bar)})`)
      check(bar.below >= 30 && bar.bar > 80, `${label}: with its tools on a second row (${JSON.stringify(bar)})`)
      check(await page.locator('.crumb-page').evaluate((b) => b.scrollWidth <= b.clientWidth), `${label}: and the page's name whole`)
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: nothing runs off the side`)
      await page.screenshot({ path: path.join(shots, `viewer-narrow-1100-${scheme}.png`) })
      // a tablet upright leaves the viewer 248px: the tools wrap again, every one in sight and clear of the rest
      await page.setViewportSize({ width: 768, height: 900 })
      await page.waitForTimeout(200)
      const tools = await page.evaluate((() => { const bar = document.querySelector('.viewer-bar')!; const b = bar.getBoundingClientRect(); const tools = [...bar.children].filter((c) => getComputedStyle(c).order === '3').map((c) => c.getBoundingClientRect()); const clear = tools.every((a, i) => tools.every((o, j) => i === j || a.bottom <= o.top - 4 || o.bottom <= a.top - 4 || a.right <= o.left || o.right <= a.left)); return { tools: tools.length, clear, inside: tools.every((t) => t.left >= b.left && t.right <= b.right + 0.5 && t.bottom <= b.bottom), fits: document.documentElement.scrollWidth <= innerWidth } }))
      check(tools.tools === 3 && tools.inside && tools.clear && tools.fits, `${label}: at 768px the bar's tools wrap inside it, none over another (${JSON.stringify(tools)})`)
      check((await page.locator('.crumbs').innerText()).trim() === 'Checkout redesign' && (await page.locator('.crumb-page').evaluate((b) => b.getBoundingClientRect().width)) >= 60, `${label}: and the location is the page's name alone (${await page.locator('.crumbs').innerText()})`)
      await page.screenshot({ path: path.join(shots, `viewer-narrow-768-${scheme}.png`) })
      await page.setViewportSize({ width: 1100, height: 900 })
      check(!(await page.locator('.session-side').count()), `${label}: the full viewer, not the side view`)
    }
    if (scheme === 'light') {
      // Open in browser opens what the frame shows: here the mockups
      await side.getByRole('radiogroup', { name: 'Part of the blueprint' }).getByRole('radio', { name: 'Mockups' }).click()
      await inside.getByRole('heading', { name: 'Checkout redesign: mockups' }).waitFor()
      const [tab] = await Promise.all([ctx.waitForEvent('page'), side.getByRole('button', { name: 'Open in new tab' }).click()])
      check(await until(() => /\/v\/tok-checkout-redesign-\d+\/mockups\/$/.test(tab.url())), `${label}: the new tab opens the part on screen (${tab.url()})`)
      await tab.close()
      // back to the list, and closed
      await side.getByRole('button', { name: "This session's blueprints" }).click()
      await side.locator('.side-row').first().waitFor()
      await side.getByRole('button', { name: 'Close blueprints' }).click()
      await side.waitFor({ state: 'detached' })
      check((await page.getByRole('button', { name: /^Blueprints: 3/ }).getAttribute('aria-pressed')) === 'false', `${label}: closed`)
      // the tmux session renamed: the list's heading follows it
      state.hosts[0]!.sessions[0].name = 'shop'
      publishOverview()
      // by its address from before 0.25, which keeps working
      await page.goto(`${base}/next/pages/local/checkout-redesign`)
      await page.getByRole('heading', { name: 'Blueprints' }).waitFor()
      const heads = () => page.locator('.tree-group .group-heading-name').allTextContents()
      // the running conversation's page follows at once; the hub moves the earlier one when it sees the rename
      check(await until(async () => (await heads()).join(',') === 'accounts,shop,storefront,docs-site'), `${label}: the heading follows a rename (${await heads()})`)
      state.pages.find((x) => x.slug === 'cart-mockups')!.tmux = 'shop'
      publishPages()
      check(await until(async () => (await heads()).join(',') === 'accounts,shop,docs-site'), `${label}: one heading again (${await heads()})`)
      check((await page.locator('.crumbs').textContent())?.replace(/\s+/g, '') === 'studio/shop/Checkoutredesign', `${label}: so does the viewer (${await page.locator('.crumbs').textContent()})`)
    }
    await ctx.close()
  }

  // ---- from 1180 px the header's Blueprints button opens the side panel's Blueprints tab ----
  for (const scheme of ['light', 'dark'] as const) {
    reset()
    const ctx = await browser.newContext({ ...desktop, colorScheme: scheme })
    const page = await ctx.newPage()
    watch(page)
    const label = `session panel ${scheme}`
    await page.goto(`${base}/next/m/local/p/11`)
    await styled(page)
    await page.locator('.reply-pages').waitFor()
    const button = page.getByRole('button', { name: 'Blueprints: 2, changed' })
    await button.click()
    const panel = page.locator('aside[aria-label="Side panel"]')
    check(await panel.getByRole('tab', { name: /Blueprints/ }).getAttribute('aria-selected') === 'true', `${label}: the button picks the panel's Blueprints tab`)
    check(await until(async () => (await button.getAttribute('aria-pressed')) === 'true'), `${label}: and shows as pressed`)
    check(!(await page.locator('.session-side').count()), `${label}: no second side view next to the panel`)
    // five tabs fit 420 px: nothing runs on, so nothing fades
    const row = panel.locator('#pp-tabs')
    check(await row.evaluate((el) => el.scrollWidth <= el.clientWidth), `${label}: the five tabs fit the panel`)
    check(!/end|start/.test((await row.getAttribute('data-fade')) ?? ''), `${label}: no faded end on a row that fits (${await row.getAttribute('data-fade')})`)
    check((await panel.locator('.side-label').allTextContents()).join('|') === 'This conversation|Earlier in storefront', `${label}: this conversation's first`)
    await panel.locator('.side-row', { hasText: 'Checkout redesign' }).click()
    await panel.frameLocator('iframe.page-frame').getByRole('heading', { name: 'Checkout redesign' }).waitFor()
    for (const name of ['Reload', 'Open full view', 'Open in new tab']) check(await panel.getByRole('button', { name, exact: true }).isVisible(), `${label}: ${name} in the panel`)
    check(page.url().endsWith('/next/m/local/p/11'), `${label}: still on the session`)
    await page.screenshot({ path: path.join(shots, `session-panel-blueprints-1440-${scheme}.png`) })
    await layout(page, `${label} viewer`)
    // pressed again, it hides the panel
    await button.click()
    await panel.waitFor({ state: 'detached' })
    check((await button.getAttribute('aria-pressed')) === 'false', `${label}: pressed again, the panel goes`)
    await ctx.close()
  }

  // ---- a session's pages on a phone: a sheet, the viewer, and back to the session ----
  for (const scheme of ['light', 'dark'] as const) {
    reset()
    const ctx = await browser.newContext({ ...phone, colorScheme: scheme })
    const page = await ctx.newPage()
    watch(page)
    const label = `session phone ${scheme}`
    await page.goto(`${base}/next/m/local/p/11`)
    await styled(page)
    await page.locator('.reply-pages').waitFor()
    await page.getByRole('button', { name: 'Blueprints: 2, changed' }).click()
    const sheet = page.getByRole('dialog', { name: 'Blueprints' })
    await sheet.waitFor()
    check((await sheet.locator('.side-label').allTextContents()).join('|') === 'This conversation|Earlier in storefront', `${label}: this conversation's first`)
    check((await sheet.locator('.side-row').count()) === 2, `${label}: two rows`)
    await page.screenshot({ path: path.join(shots, `session-sheet-390-${scheme}.png`) })
    await layout(page, `${label} sheet`)
    // a page opens in the sheet, over the session, with the side view's controls
    const opened = state.minted
    await sheet.locator('.side-row', { hasText: 'Cart mockups' }).click()
    await sheet.frameLocator('iframe.page-frame').getByRole('heading', { name: 'Cart mockups' }).waitFor()
    check(page.url().endsWith('/next/m/local/p/11'), `${label}: still on the session`)
    check((await sheet.locator('.viewer-where').textContent()) === 'storefront · studio', `${label}: the page's session and machine (${await sheet.locator('.viewer-where').textContent()})`)
    for (const name of ['Reload', 'Open full view', 'Open in new tab']) check(await sheet.getByRole('button', { name, exact: true }).isVisible(), `${label}: ${name} in the sheet`)
    await sheet.getByRole('button', { name: 'Reload', exact: true }).click()
    check(await until(() => state.minted > opened + 1), `${label}: Reload mints a new link`)
    await page.screenshot({ path: path.join(shots, `session-sheet-viewer-390-${scheme}.png`) })
    await layout(page, `${label} sheet viewer`)
    // the arrow back is the list again
    await sheet.getByRole('button', { name: "This session's blueprints" }).click()
    await sheet.locator('.side-row').first().waitFor()
    // Open full view: the Blueprints screen, whose Back returns to the session
    await sheet.locator('.side-row', { hasText: 'Cart mockups' }).click()
    await sheet.getByRole('button', { name: 'Open full view' }).click()
    await page.waitForURL(/\/next\/blueprints\/local\/cart-mockups$/)
    await page.frameLocator('iframe.page-frame').getByRole('heading', { name: 'Cart mockups' }).waitFor()
    check((await page.locator('.viewer-titles .viewer-where').textContent()) === 'storefront · studio', `${label}: the viewer names the session and machine`)
    await page.screenshot({ path: path.join(shots, `session-viewer-390-${scheme}.png`) })
    await layout(page, `${label} viewer`)
    await page.getByRole('button', { name: 'Back to the session' }).click()
    await page.waitForURL(/\/next\/m\/local\/p\/11$/)
    // the Blueprints list's own viewer goes back to the list
    await page.goto(`${base}/next/blueprints`)
    await page.locator('.page-card').first().click()
    await page.getByRole('button', { name: 'Back to Blueprints' }).waitFor()
    await ctx.close()
  }

  // ---- sharing a blueprint: Share… from every menu, the sheet, a link for your network and for anyone ----
  for (const [size, opts] of [['390', phone], ['1440', desktop]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      reset()
      const ctx = await browser.newContext({ ...opts, colorScheme: scheme })
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
      const page = await ctx.newPage()
      watch(page)
      const label = `share ${size} ${scheme}`
      const isWide = wide(size)
      await page.goto(`${base}/next/blueprints${isWide ? '/local/checkout-redesign' : ''}`)
      await styled(page)
      // from the card's ⋯ (phone) or the tree's right click (desktop), after Open in browser
      if (isWide) await page.locator('.tree-row', { hasText: 'Checkout redesign' }).click({ button: 'right' })
      else await page.locator('.page-card', { hasText: 'Checkout redesign' }).getByRole('button', { name: 'More for Checkout redesign' }).click()
      const items = await menuItems(page)
      check(items.join('|').includes('Open in browser') && items.join('|').includes('Share…|Revoke links|Show folder|Remove'), `${label}: Share… before Revoke links (${items.join('|')})`)
      await page.getByRole('menuitem', { name: 'Share…' }).click()
      const sheet = page.getByRole('dialog', { name: 'Share “Checkout redesign”' })
      await sheet.waitFor()
      await sheet.getByText('None yet.').waitFor()
      // the sheet has finished rising, so a forced click lands on it rather than below the window
      await sheet.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)))
      // no public address yet: only your network, with the way to Settings
      const network = sheet.getByRole('radio', { name: /People on your network/ })
      const anyone = sheet.getByRole('radio', { name: /Anyone with the link/ })
      check((await network.getAttribute('aria-checked')) === 'true', `${label}: your network by default`)
      check((await anyone.getAttribute('aria-disabled')) === 'true', `${label}: anyone needs an address first`)
      check(await sheet.getByText('Set an address for shared links in').isVisible(), `${label}: says where to set one`)
      check((await sheet.getByRole('link', { name: 'Settings › Blueprints' }).getAttribute('href')) === '/next/settings#blueprints', `${label}: the link to Settings`)
      await anyone.click({ force: true })
      check((await network.getAttribute('aria-checked')) === 'true', `${label}: a choice that's off can't be picked`)
      const days = sheet.getByRole('radiogroup', { name: 'Expires after' })
      check((await days.getByRole('radio').allTextContents()).join(',') === '1 day,7 days,30 days', `${label}: the three lengths`)
      check((await days.getByRole('radio', { name: '7 days' }).getAttribute('aria-checked')) === 'true', `${label}: 7 days unless picked`)
      await days.getByRole('radio', { name: '30 days' }).click()
      await sheet.getByRole('button', { name: 'Create link' }).click()
      const url = sheet.getByTestId('share-url')
      await url.waitFor()
      check((await url.textContent()) === `${base}/share/tok1/`, `${label}: a network link on this hub's address (${await url.textContent()})`)
      check(JSON.stringify(called('POST', '/api/pages/local/checkout-redesign/shares').at(-1)?.body) === JSON.stringify({ public: false, days: 30 }), `${label}: asked for 30 days on the network`)
      check(await sheet.getByText("Copy it now: the hub keeps only a fingerprint of it, so it can't show it again.").isVisible(), `${label}: shown once`)
      check(await until(async () => (await sheet.getByRole('button', { name: 'Copied' }).count()) === 1), `${label}: copied as it's made`)
      check((await page.evaluate(() => navigator.clipboard.readText())) === `${base}/share/tok1/`, `${label}: the link is on the clipboard`)
      const live = sheet.locator('.share-link-row')
      await live.first().waitFor()
      check((await live.locator('.share-link-title').textContent()) === 'Your network', `${label}: the live link's audience`)
      check(/^ends in 30 days · 0 opens · made [A-Z][a-z]{2} \d+$/.test((await live.locator('.share-link-meta').textContent()) ?? ''), `${label}: its line (${await live.locator('.share-link-meta').textContent()})`)
      await page.screenshot({ path: path.join(shots, `share-${size}-${scheme}.png`) })
      await layout(page, label)
      // revoked from the sheet
      await live.getByRole('button', { name: 'Revoke' }).click()
      await page.locator('.toast', { hasText: 'Link revoked' }).waitFor()
      check(await until(async () => (await sheet.getByText('None yet.').count()) === 1), `${label}: the revoked link leaves the list`)
      check(!shares.links.length, `${label}: revoked on the hub`)
      await sheet.getByRole('button', { name: 'Done' }).click()
      await sheet.waitFor({ state: 'detached' })

      // with a public address: anyone with the link, from the viewer's own ⋯
      shares.address = 'https://share.example.com'
      if (!isWide) {
        await page.locator('.page-card', { hasText: 'Checkout redesign' }).click()
        await page.locator('iframe.page-frame').waitFor()
        await page.getByRole('button', { name: 'More', exact: true }).click()
        const more = await menuItems(page)
        check(more.at(-2) === 'Share…' && more.at(-1) === 'Open studio', `${label}: the viewer's ⋯ shares, before the machine (${more.join('|')})`)
      } else {
        await page.getByRole('button', { name: 'More for Checkout redesign' }).click()
        check((await menuItems(page))[0] === 'Share…', `${label}: Share… first in the viewer's ⋯ (${await menuItems(page)})`)
      }
      await page.getByRole('menuitem', { name: 'Share…' }).click()
      await sheet.waitFor()
      await sheet.getByText('None yet.').waitFor()
      check(await sheet.getByText('Opens at share.example.com, through the proxy you set up.').isVisible(), `${label}: where links for anyone open`)
      await anyone.click()
      check((await anyone.getAttribute('aria-checked')) === 'true', `${label}: anyone picked`)
      check(await sheet.getByText("Every file in the blueprint's folder opens with the link, research notes too.").isVisible(), `${label}: the folder note`)
      // the arrows move between the two
      await anyone.focus()
      await page.keyboard.press('ArrowUp')
      check((await network.getAttribute('aria-checked')) === 'true', `${label}: arrows pick`)
      await page.keyboard.press('ArrowDown')
      await sheet.getByRole('button', { name: 'Create link' }).click()
      await url.waitFor()
      check((await url.textContent()) === 'https://share.example.com/share/tok2/', `${label}: a link for anyone on the public address (${await url.textContent()})`)
      check(called('POST', '/api/pages/local/checkout-redesign/shares').at(-1)?.body?.public === true && called('POST', '/api/pages/local/checkout-redesign/shares').at(-1)?.body?.days === 7, `${label}: asked for anyone, 7 days`)
      await sheet.locator('.share-link-row', { hasText: 'Anyone with the link' }).waitFor()
      await page.screenshot({ path: path.join(shots, `share-public-${size}-${scheme}.png`) })
      await layout(page, `${label} public`)
      await sheet.getByRole('button', { name: 'Copied' }).click()
      await page.locator('.toast', { hasText: 'Copied the link' }).waitFor()
      await ctx.close()
    }
  }

  // ---- Share… on a session's side view, and the list without the socket ----
  // (narrower than 1180 px, so the button opens the side view; the side panel's tab lists the same rows)
  {
    reset()
    const ctx = await browser.newContext({ ...desktop, viewport: { width: 1100, height: 900 }, colorScheme: 'light' })
    const page = await ctx.newPage()
    watch(page)
    await page.goto(`${base}/next/m/local/p/11`)
    await styled(page)
    await page.getByRole('button', { name: 'Blueprints: 2, changed' }).click()
    const side = page.getByRole('complementary', { name: 'Blueprints' })
    await side.locator('.side-row', { hasText: 'Checkout redesign' }).click({ button: 'right' })
    check((await menuItems(page)).includes('Share…'), `side: the row's menu shares (${await menuItems(page)})`)
    await page.keyboard.press('Escape')
    await side.locator('.side-row', { hasText: 'Checkout redesign' }).click()
    await side.locator('iframe.page-frame').waitFor()
    await side.getByRole('button', { name: 'More for Checkout redesign' }).click()
    check((await menuItems(page))[0] === 'Share…', `side: the side view's ⋯ shares (${await menuItems(page)})`)
    await page.getByRole('menuitem', { name: 'Share…' }).click()
    await page.getByRole('dialog', { name: 'Share “Checkout redesign”' }).getByText('None yet.').waitFor()
    // the Settings link closes the sheet and opens Blueprints in Settings
    // inside the radio that's off, as in the web app, so Playwright counts it as disabled
    await page.getByRole('link', { name: 'Settings › Blueprints' }).click({ force: true })
    check(await until(() => /\/next\/settings#blueprints$/.test(page.url())), `side: to Settings › Blueprints (${page.url()})`)
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
    check(await until(async () => !(await page.getByRole('dialog', { name: /^Share/ }).count())), 'side: the sheet closed on the way to Settings')
    await ctx.close()
  }
  for (const [size, opts] of [['390', phone], ['1440', desktop]] as const) {
    reset()
    state.noSocket = true
    state.listFails = true
    const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' })
    const page = await ctx.newPage()
    watch(page)
    const label = `no socket ${size}`
    await page.goto(`${base}/next/blueprints`)
    await styled(page)
    // the stream never comes: the list is fetched instead, and says why when that fails too
    const alert = page.locator('.pages-error')
    check(await until(async () => (await alert.count()) === 1, 8000), `${label}: an error line instead of "Loading" for good`)
    check((await alert.textContent()) === 'The hub is busy', `${label}: the hub's words (${await alert.textContent()})`)
    check((await alert.getAttribute('role')) === 'alert', `${label}: read out`)
    await page.screenshot({ path: path.join(shots, `pages-no-socket-error-${size}-dark.png`) })
    state.listFails = false
    await page.reload()
    await styled(page)
    const row = wide(size) ? page.locator('.tree-row', { hasText: 'Checkout redesign' }) : page.locator('.page-card', { hasText: 'Checkout redesign' })
    check(await until(async () => (await row.count()) === 1, 8000), `${label}: the list over REST`)
    check(called('GET', '/api/pages').length >= 2, `${label}: asked GET /api/pages`)
    check(!(await alert.count()), `${label}: no error line once it came`)
    if (wide(size)) check(await until(async () => /\/next\/blueprints\/local\//.test(page.url())), `${label}: the desktop opens a page from it (${page.url()})`)
    await page.screenshot({ path: path.join(shots, `pages-no-socket-${size}-dark.png`) })
    await layout(page, label)
    await ctx.close()
  }
} catch (e) {
  await capture(browser, shots, 'pages', problems)
  throw e
} finally {
  await browser.close()
  server.stop(true)
}

// a site without a matrix answers its HEAD with a 404, which the browser logs, and so are the
// refused socket and the list that fails on purpose
const unexpected = errors.filter((e) => !/WebSocket|status of (404|502|503)/.test(e))
check(!unexpected.length, `errors in the page: ${unexpected.join(' | ')}`)
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`ok: Blueprints at 390x844 and 1440x900 in light and dark, the sandboxed frame and its theme, live progress, changed marks, menus by ⋯, right click and long press, parts, notes, devices, revoke, remove with Undo, add, the Folder sheet, and the pages on a machine, a session (side panel and sheet) and a reply, sharing a blueprint, and the list without the socket; screenshots in ${shots}`)
