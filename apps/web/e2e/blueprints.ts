// bun e2e/blueprints.ts — Blueprints in the built app (dist/, from `bun run build`) in Chromium, fed
// made-up machines and pages: the list grouped by tmux session with the machine as a label, a
// heading that follows a renamed session, the viewer naming the session, Open in new tab opening
// the part on screen, and a session's blueprints (this conversation's first, another tmux
// session's kept out) beside the chat on a desktop and in the Activity sheet on a phone, opened
// there with reload, a new tab and Open full view, whose back comes to the session again. Also
// the side panel's tabs scrolling in a 420px panel (Usage reachable by keyboard), and the phone
// viewer's top bar at 360px, and Share…: the sheet with your network as the default and anyone
// off until the hub has an address, a link made and shown, the address set in Settings with
// every live link and Revoke all. At 390×844 and 1440×900, light and dark, with a screenshot of each. CHROME=/path/to/chrome uses a browser other than Playwright's own; SHOTS= picks the folder.
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { chromium, devices, type Page as Tab } from 'playwright'

const dist = path.join(import.meta.dir, '../dist')
const shots = process.env.SHOTS ?? path.join(tmpdir(), 'inyon-web-shots')
mkdirSync(shots, { recursive: true })

const site = (title: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;padding:24px"><h1>${title}</h1><p>A made-up site.</p>`
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    // the hub's page links: /v/tok-<slug>/[mockups/]
    const v = /^\/v\/tok-([a-z0-9-]+)\/(.*)$/.exec(p)
    if (v) {
      if (v[2] === 'matrix.html') return new Response('Not found', { status: 404 })
      const name = state.pages.find((x) => x.slug === v[1])?.name ?? v[1]!
      return new Response(site(v[2] === 'mockups/' ? `${name}: mockups` : name), { headers: { 'content-type': 'text/html;charset=utf-8' } })
    }
    const f = Bun.file(path.join(dist, p))
    // the app routes every other path itself
    return new Response((await f.exists()) && !p.endsWith('/') ? f : Bun.file(path.join(dist, 'index.html')))
  },
})
const base = `http://127.0.0.1:${server.port}`

const now = Date.now()
const HOUR = 3_600_000
const pane = (id: string, cwd: string, title: string, sessionId: string) => ({
  id, index: 0, active: true, command: 'claude', cwd, title, width: 80, height: 40, dead: false, agent: { kind: 'claude', pid: 1, state: 'idle', mode: 'default', sessionId },
})
const machine = (id: string, name: string, kind: string, sessions: unknown[]) => ({
  config: { id, name, kind }, status: 'online', hostname: name, integration: 'installed', tmux: 'ok', agents: ['claude'], signedIn: ['claude'], os: 'Linux', latencyMs: 30, updatedAt: now, lastSeen: now, sessions,
})
const hosts = () => [
  machine('local', 'studio', 'local', [
    { id: '$11', name: state.tmux, attached: 0, windows: [{ id: '@1', index: 1, name: '', active: true, activity: now / 1000, panes: [pane('%11', '/home/sam/code/storefront', '✳ Cart work', 'chat-store-2')] }] },
    { id: '$12', name: 'accounts', attached: 0, windows: [{ id: '@2', index: 1, name: '', active: true, activity: now / 1000, panes: [pane('%12', '/home/sam/code/storefront', '✳ Passkeys', 'chat-acc')] }] },
  ]),
  machine('build', 'build-box', 'ssh', []),
]
type Entry = Record<string, any>
const fresh = (): Entry[] => [
  { host: 'local', slug: 'checkout-redesign', name: 'Checkout redesign', project: '/home/sam/code/storefront', by: 'claude', added: now - 2 * HOUR, folder: '/home/sam/code/storefront/private/plans/checkout-redesign', session: 'chat-store-2', tmux: 'storefront', tmuxId: '$11', progress: { done: 3, total: 8, now: 'Wiring the payment step', updated: new Date(now - 4 * 60_000).toISOString() } },
  { host: 'local', slug: 'cart-mockups', name: 'Cart mockups', project: '/home/sam/code/storefront', by: 'claude', added: now - 24 * HOUR, folder: '/home/sam/code/storefront/private/plans/cart-mockups', session: 'chat-store-1', tmux: 'storefront', tmuxId: '$11' },
  { host: 'local', slug: 'passkeys', name: 'Passkeys rollout', project: '/home/sam/code/storefront', by: 'claude', added: now - 3 * HOUR, folder: '/home/sam/code/storefront/private/plans/passkeys', session: 'chat-acc', tmux: 'accounts', tmuxId: '$12' },
  { host: 'build', slug: 'release-notes', name: 'Release notes site', project: '/srv/docs-site', by: 'cli', added: now - 5 * HOUR, folder: '/srv/docs-site/out' },
]
const note = () => ({ at: now, days: 14, pages: [{ host: 'local', slug: 'old-plan', name: 'Old plan' }, { host: 'local', slug: 'spike', name: 'Search spike' }] })
const hubSettings = () => ({ uploads: { retentionDays: 7, maxMB: 100, maxTotalMB: 1024, longPasteLines: 40 }, futureKey: 'kept' })
type Shared = { id: string; host: string; slug: string; public: boolean; created: number; expires: number; opens: number }
const state = { pages: fresh(), tmux: 'storefront', opened: [] as string[], cleaned: note() as { pages: unknown[] }, settings: hubSettings() as Record<string, any>, calls: [] as string[], address: null as string | null, shares: [] as Shared[] }
const reset = () => Object.assign(state, { pages: fresh(), tmux: 'storefront', opened: [], cleaned: note(), settings: hubSettings(), calls: [], address: null, shares: [] })
const shareList = (slug?: string) => ({ address: state.address, fromEnv: false, links: state.shares.filter((x) => !slug || x.slug === slug) })

const ts = new Date(now).toISOString()
const items = [
  { kind: 'user', seq: 1, uuid: 'u1', ts, text: 'Make the checkout plan', images: 0 },
  { kind: 'assistant', seq: 2, uuid: 'u2', ts, msgId: 'm2', block: { type: 'text', text: 'The plan is up. Open it in the app at /blueprints/local/checkout-redesign' } },
]
const info = { hostId: 'local', paneId: '%11', running: false, agent: 'claude', queue: [], tasks: [], subagents: [], artifacts: [], stats: { turns: 1, compactions: 0 } }

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
const problems: string[] = []
let checks = 0
const check = (ok: unknown, what: string) => {
  checks++
  if (!ok) problems.push(what)
}
const until = async (f: () => boolean | Promise<boolean>, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await f()) return true
  return false
}

async function open(kind: 'phone' | 'desktop', scheme: 'light' | 'dark', width?: number) {
  const ctx = await browser.newContext(kind === 'phone' ? { ...devices['iPhone 13'], viewport: { width: width ?? 390, height: 844 }, colorScheme: scheme } : { viewport: { width: width ?? 1440, height: 900 }, colorScheme: scheme })
  await ctx.route('**/api/**', (r) => {
    const u = new URL(r.request().url())
    if (u.pathname === '/api/session') return r.fulfill({ json: { authed: true } })
    if (u.pathname === '/api/pages') return r.fulfill({ json: { pages: state.pages } })
    state.calls.push(`${r.request().method()} ${u.pathname}`)
    if (u.pathname === '/api/pages-cleaned') {
      if (r.request().method() === 'DELETE') state.cleaned = { pages: [] }
      return r.fulfill({ json: r.request().method() === 'DELETE' ? { ok: true } : state.cleaned })
    }
    if (/^\/api\/hosts\/[^/]+\/uploads$/.test(u.pathname)) return r.fulfill({ json: { bytes: 2048, files: 1, expired: 0, dir: '/home/sam/.inyon/uploads' } })
    if (u.pathname === '/api/pages-cleanup') return r.fulfill({ json: { pages: [{ host: 'local', slug: 'old-plan', name: 'Old plan' }], days: state.settings.pagesCleanupDays || 14 } })
    if (u.pathname === '/api/settings') {
      if (r.request().method() === 'PUT') state.settings = r.request().postDataJSON()
      return r.fulfill({ json: state.settings })
    }
    // shared links, as a hub from 0.25.4 answers them
    const method = r.request().method()
    const sh = /^\/api\/pages\/([^/]+)\/([^/]+)\/shares(?:\/([^/]+))?$/.exec(u.pathname)
    if (sh) {
      if (method === 'POST') {
        const b = r.request().postDataJSON()
        const made: Shared = { id: `s${state.shares.length + 1}`, host: sh[1]!, slug: sh[2]!, public: b.public, created: Date.now(), expires: Date.now() + b.days * 24 * HOUR, opens: 0 }
        state.shares.push(made)
        const token = `Tok${made.id}AbCdEfGhIjKlMnOp`.slice(0, 22)
        return r.fulfill({ json: { ...made, url: b.public ? `${state.address}/share/${token}/` : `/share/${token}/` } })
      }
      if (method === 'DELETE') state.shares = state.shares.filter((x) => x.id !== sh[3])
      return r.fulfill({ json: method === 'DELETE' ? { ok: true } : shareList(sh[2]) })
    }
    if (u.pathname === '/api/shares') {
      if (method === 'DELETE') state.shares = []
      return r.fulfill({ json: method === 'DELETE' ? { revoked: 1 } : shareList() })
    }
    if (u.pathname.startsWith('/api/shares/')) {
      state.shares = state.shares.filter((x) => x.id !== u.pathname.split('/').pop())
      return r.fulfill({ json: { ok: true } })
    }
    if (u.pathname === '/api/share-address/check') {
      return r.fulfill({ json: { address: state.address, dns: { ok: true, addresses: ['203.0.113.4'] }, reach: { ok: true }, wall: { ok: true, open: [] } } })
    }
    if (u.pathname === '/api/share-address') {
      const a = String(r.request().postDataJSON().address).trim()
      state.address = a ? (a.includes('://') ? a : `https://${a}`).replace(/\/$/, '').toLowerCase() : null
      return r.fulfill({ json: shareList() })
    }
    const o = /^\/api\/pages\/([^/]+)\/([^/]+)\/open$/.exec(u.pathname)
    if (o) {
      state.opened.push(o[2]!)
      return r.fulfill({ json: { url: `/v/tok-${o[2]}/`, expires: Date.now() + 12 * HOUR, ttl: 12 * HOUR } })
    }
    return r.fulfill({ json: {} })
  })
  const sockets: { send: (s: string) => void }[] = []
  await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    sockets.push(ws)
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m))
      if (msg.t === 'sub.overview') ws.send(JSON.stringify({ t: 'overview', hosts: hosts() }))
      if (msg.t === 'sub.chat') ws.send(JSON.stringify({ t: 'chat.reset', key: `${msg.host}:${msg.pane}`, info, items, hasMore: false }))
    })
  })
  const page = await ctx.newPage()
  // past the intro that plays once per app session
  await page.addInitScript(() => {
    // (it runs in the sandboxed blueprint frames too, which have no storage)
    try {
      sessionStorage.setItem('inyon.intro.seen', '1')
    } catch {}
  })
  page.on('pageerror', (e) => problems.push(`${kind} ${scheme}: ${e.message}`))
  // the machines as they are now, and the list read again, as the app does when it comes back into view
  const publish = async () => {
    for (const ws of sockets) ws.send(JSON.stringify({ t: 'overview', hosts: hosts() }))
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  }
  return { ctx, page, publish }
}

/** No text runs out of its box sideways, and the page doesn't scroll sideways. */
async function layout(page: Tab, what: string) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check(wide <= 0, `${what}: the page scrolls sideways by ${wide}px`)
}

const heads = (page: Tab) => page.locator('.group-heading-name').allTextContents()

/** How much of an element its scrolling strip shows, from 0 (none) to 1 (all of it). */
const shown = (el: import('playwright').Locator) =>
  el.evaluate((e) => {
    const strip = e.parentElement!
    const a = e.getBoundingClientRect()
    const b = strip.getBoundingClientRect()
    return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) / a.width
  })

try {
  for (const scheme of ['light', 'dark'] as const) {
    // ---- the list on a desktop: by tmux session, the machine as a label, a rename followed ----
    {
      reset()
      const { ctx, page, publish } = await open('desktop', scheme)
      const label = `desktop ${scheme}`
      await page.goto(`${base}/blueprints/local/checkout-redesign`)
      await page.frameLocator('iframe').first().getByRole('heading', { name: 'Checkout redesign' }).waitFor()
      check((await heads(page)).join('|') === 'accounts|storefront|docs-site', `${label}: tmux sessions first, then projects (${await heads(page)})`)
      check(await page.locator('.group-heading', { hasText: 'docs-site' }).getByText('build-box').isVisible(), `${label}: the machine as a label`)
      check((await page.locator('.crumb-group').textContent()) === 'storefront', `${label}: the viewer names the session`)
      {
        // with the room a wide screen gives, the viewer's bar is one row
        const bar = await page.evaluate((() => { const r = (s: string) => document.querySelector(s)!.getBoundingClientRect(); return { crumbs: Math.round(r('.viewer-bar nav').width), bar: Math.round(r('.viewer-bar').height), below: Math.round(r('.viewer-bar [aria-label="Frame size"]').top - r('.viewer-bar nav').top) } }))
        check(bar.bar === 52 && bar.below < 20 && bar.crumbs >= 200, `${label}: the viewer's bar is one row (${JSON.stringify(bar)})`)
        // beside the sidebar and the list on a small laptop the viewer is narrow: the bar takes two rows,
        // so its parts and frame sizes leave the page's location its room (on one row it shrank to nothing)
        await page.setViewportSize({ width: 1100, height: 900 })
        const narrow = await page.evaluate((() => { const r = (s: string) => document.querySelector(s)!.getBoundingClientRect(); return { crumbs: Math.round(r('.viewer-bar nav').width), bar: Math.round(r('.viewer-bar').height), below: Math.round(r('.viewer-bar [aria-label="Frame size"]').top - r('.viewer-bar nav').top) } }))
        check(narrow.crumbs >= 200, `${label}: at 1100px the viewer still says where the page is (${JSON.stringify(narrow)})`)
        check(narrow.below >= 30 && narrow.bar > 80, `${label}: with its tools on a second row (${JSON.stringify(narrow)})`)
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: and nothing runs off the side`)
        await page.screenshot({ path: path.join(shots, `viewer-narrow-1100-${scheme}.png`) })
        // a tablet upright leaves the viewer 248px: the tools wrap again, every one in sight and clear of the rest
        await page.setViewportSize({ width: 768, height: 900 })
        await page.waitForTimeout(200)
        const tools = await page.evaluate((() => { const bar = document.querySelector('.viewer-bar')!; const b = bar.getBoundingClientRect(); const tools = [...bar.children].filter((c) => getComputedStyle(c).order === '3').map((c) => c.getBoundingClientRect()); const clear = tools.every((a, i) => tools.every((o, j) => i === j || a.bottom <= o.top - 4 || o.bottom <= a.top - 4 || a.right <= o.left || o.right <= a.left)); return { tools: tools.length, clear, inside: tools.every((t) => t.left >= b.left && t.right <= b.right + 0.5 && t.bottom <= b.bottom), fits: document.documentElement.scrollWidth <= innerWidth } }))
        check(tools.tools >= 2 && tools.inside && tools.clear && tools.fits, `${label}: at 768px the bar's tools wrap inside it, none over another (${JSON.stringify(tools)})`)
        check((await page.locator('.viewer-bar nav').innerText()).trim() === 'Checkout redesign' && (await page.locator('.viewer-bar nav b').evaluate((b) => b.getBoundingClientRect().width)) >= 60, `${label}: and the location is the page's name alone (${await page.locator('.viewer-bar nav').innerText()})`)
        // the sidebar is 240px here: its search keeps one line, the words giving way to the key
        check(await page.getByRole('button', { name: /^Search or jump to/ }).evaluate((b) => b.querySelector('kbd')!.getBoundingClientRect().height <= 24 && b.querySelector('span')!.getBoundingClientRect().height <= 24), `${label}: the sidebar's search stays on one line`)
        await page.screenshot({ path: path.join(shots, `viewer-narrow-768-${scheme}.png`) })
        await page.setViewportSize({ width: 1440, height: 900 })
      }
      // Open in new tab opens the part on screen
      await page.getByRole('radiogroup', { name: 'Part of the blueprint' }).getByRole('radio', { name: 'Mockups' }).click()
      await page.frameLocator('iframe').first().getByRole('heading', { name: 'Checkout redesign: mockups' }).waitFor()
      const [tab] = await Promise.all([ctx.waitForEvent('page'), page.getByRole('button', { name: 'Open in new tab' }).click()])
      check(await until(() => /\/v\/tok-checkout-redesign\/mockups\/$/.test(tab.url())), `${label}: the new tab opens the part on screen (${tab.url()})`)
      await tab.close()
      await page.screenshot({ path: path.join(shots, `blueprints-1440-${scheme}.png`) })
      await layout(page, label)
      // renamed: the running conversation's pages follow at once, the earlier one when the hub says so
      state.tmux = 'shop'
      await publish()
      check(await until(async () => (await heads(page)).join('|') === 'accounts|shop|storefront|docs-site'), `${label}: the heading follows a rename (${await heads(page)})`)
      state.pages.find((x) => x.slug === 'cart-mockups')!.tmux = 'shop'
      await publish()
      check(await until(async () => (await heads(page)).join('|') === 'accounts|shop|docs-site'), `${label}: one heading again (${await heads(page)})`)
      // the address from before 0.25 still opens it
      await page.goto(`${base}/pages/local/passkeys`)
      await page.frameLocator('iframe').first().getByRole('heading', { name: 'Passkeys rollout' }).waitFor()
      await ctx.close()
    }

    // ---- a session's blueprints beside its chat ----
    {
      reset()
      const { ctx, page, publish } = await open('desktop', scheme)
      const label = `session desktop ${scheme}`
      await page.goto(`${base}/m/local/p/11`)
      // the panel may be open already (the app keeps it as it was)
      const toggle = page.getByRole('button', { name: /^(Show|Hide) side panel$/ })
      await toggle.waitFor()
      if ((await toggle.getAttribute('aria-label')) === 'Show side panel') await toggle.click()
      // the panel is resized by its left edge: it comes 420px wide, and is dragged to its least here
      const strip = page.getByRole('tablist', { name: 'Side panel' })
      const panel = page.locator('aside').filter({ has: strip })
      const handle = page.getByRole('separator', { name: 'Resize the side panel' })
      const width = async () => Math.round((await panel.boundingBox())!.width)
      const drag = async (by: number) => {
        const b = (await panel.boundingBox())!
        await page.mouse.move(b.x, b.y + 300)
        await page.mouse.down()
        await page.mouse.move(b.x + by, b.y + 300, { steps: 8 })
        await page.mouse.up()
      }
      const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('inyon.settings.v2') ?? '{}').panelWidth)
      check((await width()) === 420, `${label}: the panel comes 420px wide (${await width()})`)
      check(await strip.getByRole('tab', { name: 'Preview' }).count() === 0, `${label}: no Preview tab`)
      await drag(300)
      check((await width()) === 340, `${label}: dragged right, it stops at its least, 340px (${await width()})`)
      check((await saved()) === 340, `${label}: the width is kept (${await saved()})`)
      // a 340px panel has more tabs than room: the strip scrolls, and the arrows reach the end
      check(await strip.evaluate((el) => el.scrollWidth > el.clientWidth), `${label}: the tabs overflow a 340px panel (the case this covers)`)
      await strip.getByRole('tab', { name: /Changes/ }).click()
      await page.keyboard.press('End')
      const usage = strip.getByRole('tab', { name: 'Usage' })
      check((await usage.getAttribute('aria-selected')) === 'true', `${label}: End picks the last tab`)
      check(await until(async () => (await shown(usage)) === 1), `${label}: Usage scrolled fully into view (${await shown(usage)})`)
      check(await page.evaluate(() => document.activeElement?.textContent === 'Usage'), `${label}: focus follows the arrows`)
      check((await strip.evaluate((el) => getComputedStyle(el).maskImage)).includes('gradient'), `${label}: the hidden side fades`)
      await page.screenshot({ path: path.join(shots, `session-tabs-1440-${scheme}.png`) })
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('Home')
      check((await strip.getByRole('tab', { name: /Changes/ }).getAttribute('aria-selected')) === 'true', `${label}: Home goes back to the first`)
      // wider, over the chat: the chat keeps 420px, and the width survives a reload
      await drag(-900)
      const row = Math.round((await page.locator('main').boundingBox())!.width)
      check((await width()) === row - 420, `${label}: dragged far left, the chat keeps 420px (${await width()} of ${row})`)
      await drag(200)
      const wide = await width()
      await page.reload()
      await strip.waitFor()
      check((await width()) === wide, `${label}: the same width after a reload (${await width()} vs ${wide})`)
      // the sidebar folds to a rail (Ctrl B), which gives the session the room, and opens again
      await page.locator('body').click({ position: { x: 700, y: 5 } })
      await page.keyboard.press('Control+b')
      const rail = page.locator('aside[data-sidebar="rail"]')
      await rail.waitFor()
      check(Math.round((await rail.boundingBox())!.width) === 60, `${label}: the sidebar folded to a 60px rail`)
      check(await rail.getByRole('button', { name: 'Show sidebar' }).isVisible(), `${label}: the rail's way back`)
      // it fades in; once it has, it's fully there
      await rail.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
      check((await rail.evaluate((el) => getComputedStyle(el).opacity)) === '1', `${label}: the rail is fully shown`)
      check((await rail.getByRole('link').count()) === 4, `${label}: the rail's four places (${await rail.getByRole('link').count()})`)
      await page.screenshot({ path: path.join(shots, `sidebar-rail-1440-${scheme}.png`) })
      await rail.getByRole('button', { name: 'Show sidebar' }).click()
      await page.locator('aside[data-sidebar="open"]').waitFor()
      // a double click on the edge puts the usual width back
      await handle.dblclick()
      check((await width()) === 420, `${label}: a double click puts 420px back (${await width()})`)
      check((await saved()) === 0, `${label}: and forgets the dragged width`)
      await page.getByRole('tab', { name: /Blueprints/ }).click()
      const side = page.locator('aside')
      check((await side.locator('.side-label').allTextContents()).join('|') === 'This conversation|Earlier in storefront', `${label}: this conversation's first (${await side.locator('.side-label').allTextContents()})`)
      check(!(await side.getByText('Passkeys rollout').count()), `${label}: another tmux session's stays out`)
      await page.screenshot({ path: path.join(shots, `session-blueprints-1440-${scheme}.png`) })
      // live: one the conversation adds shows up
      state.pages.push({ host: 'local', slug: 'promo-codes', name: 'Promo codes', project: '/home/sam/code/storefront', by: 'claude', added: Date.now(), folder: '/home/sam/code/storefront/private/plans/promo-codes', session: 'chat-store-2', tmux: 'storefront', tmuxId: '$11' })
      await publish()
      check(await until(async () => (await side.getByText('Promo codes').count()) === 1), `${label}: a new one comes live`)
      // it opens in the panel, saying which blueprint, session and machine
      await side.getByRole('link', { name: /Cart mockups/ }).click()
      await side.frameLocator('iframe').getByRole('heading', { name: 'Cart mockups' }).waitFor()
      check((await side.locator('.viewer-name').textContent()) === 'Cart mockups', `${label}: its name`)
      check((await side.locator('.viewer-where').textContent()) === 'storefront · studio', `${label}: its session and machine (${await side.locator('.viewer-where').textContent()})`)
      check(page.url().endsWith('/m/local/p/11'), `${label}: still on the session`)
      // the viewer's controls, in small
      for (const name of ['Reload', 'Open full view', 'Open in new tab']) check(await side.getByRole('button', { name }).isVisible(), `${label}: ${name} in the side view`)
      const opens = state.opened.length
      await side.getByRole('button', { name: 'Reload' }).click()
      check(await until(() => state.opened.length > opens), `${label}: Reload asks for a fresh link`)
      await page.screenshot({ path: path.join(shots, `session-blueprints-viewer-1440-${scheme}.png`) })
      await layout(page, label)
      await side.getByRole('button', { name: "This session's blueprints" }).click()
      await side.locator('.side-label').first().waitFor()
      // Open full view: the Blueprints screen with that one open
      await side.getByRole('link', { name: /Cart mockups/ }).click()
      await side.getByRole('button', { name: 'Open full view' }).click()
      await page.waitForURL(/\/blueprints\/local\/cart-mockups$/)
      await page.frameLocator('iframe').first().getByRole('heading', { name: 'Cart mockups' }).waitFor()
      check((await page.locator('.crumb-group').textContent()) === 'storefront', `${label}: the full viewer`)
      await ctx.close()
    }

    // ---- Settings: when old blueprints are cleaned up, and Clean up now ----
    {
      reset()
      const { ctx, page } = await open('desktop', scheme)
      const label = `settings ${scheme}`
      await page.goto(`${base}/settings#blueprints`)
      const days = page.getByRole('radiogroup', { name: 'Clean up old blueprints after' })
      await days.waitFor()
      check((await days.getByRole('radio', { name: '14 days' }).getAttribute('aria-checked')) === 'true', `${label}: 14 days unless set`)
      await days.getByRole('radio', { name: 'Never' }).click()
      check(await until(() => state.settings.pagesCleanupDays === 0 && state.settings.futureKey === 'kept'), `${label}: never, the rest kept (${JSON.stringify(state.settings)})`)
      await days.getByRole('radio', { name: '30 days' }).click()
      check(await until(() => state.settings.pagesCleanupDays === 30), `${label}: after 30 days`)
      await page.getByRole('button', { name: 'Clean up', exact: true }).click()
      await page.getByText('Cleaned up “Old plan”').waitFor()
      check(state.calls.filter((c) => c === 'POST /api/pages-cleanup').length === 1, `${label}: cleaned up on the hub`)
      await page.locator('#blueprints').screenshot({ path: path.join(shots, `settings-blueprints-1440-${scheme}.png`) })
      await layout(page, label)
      await ctx.close()
    }

    // ---- Share…: on a desktop from the viewer's ⋯, then the address and the list in Settings ----
    {
      reset()
      const { ctx, page } = await open('desktop', scheme)
      const label = `share desktop ${scheme}`
      await page.goto(`${base}/blueprints/local/checkout-redesign`)
      await page.frameLocator('iframe').first().getByRole('heading', { name: 'Checkout redesign' }).waitFor()
      await page.getByRole('button', { name: 'More for Checkout redesign' }).click()
      await page.getByRole('menuitem', { name: 'Share…' }).click()
      const sheet = page.getByRole('dialog', { name: 'Share “Checkout redesign”' })
      await sheet.getByText('None yet.').waitFor()
      check((await sheet.getByRole('radio', { name: /People on your network/ }).getAttribute('aria-checked')) === 'true', `${label}: your network by default`)
      check((await sheet.getByRole('radio', { name: /Anyone with the link/ }).getAttribute('aria-disabled')) === 'true', `${label}: anyone is off without an address`)
      await page.screenshot({ path: path.join(shots, `share-sheet-1440-${scheme}.png`) })
      await sheet.getByRole('radio', { name: '30 days' }).click()
      await sheet.getByRole('button', { name: 'Create link' }).click()
      const url = sheet.getByTestId('share-url')
      await url.waitFor()
      check((await url.textContent()) === `${base}/share/Toks1AbCdEfGhIjKlMnOp/`, `${label}: a network link on the app's own address (${await url.textContent()})`)
      await sheet.getByRole('listitem').getByText('Your network').waitFor()
      check(state.shares[0]?.expires! - state.shares[0]?.created! === 30 * 24 * HOUR, `${label}: for the days picked`)
      await page.screenshot({ path: path.join(shots, `share-made-1440-${scheme}.png`) })
      await layout(page, label)
      await sheet.getByRole('button', { name: 'Done' }).click()
      // Settings › Blueprints: the address, then the links
      await page.goto(`${base}/settings#blueprints`)
      await page.getByText('Off. Links stay on your network until you set one up.').waitFor()
      await page.getByRole('button', { name: 'Set up' }).click()
      const setup = page.getByRole('dialog', { name: 'Address for shared links' })
      const field = setup.getByRole('textbox', { name: 'Name for shared links' })
      await field.fill('example.com')
      await setup.getByText(/That's a main domain/).waitFor()
      await field.fill('share.example.com')
      await setup.getByRole('radio', { name: 'Traefik' }).click()
      check(((await setup.locator('pre').textContent()) ?? '').includes('Host(`share.example.com`) && PathPrefix(`/share/`)'), `${label}: the Traefik example follows the name`)
      await page.screenshot({ path: path.join(shots, `share-setup-1440-${scheme}.png`) })
      await layout(page, `${label} setup`)
      await setup.getByRole('button', { name: 'Save and check' }).click()
      await setup.getByText('Links reach this hub').waitFor()
      check(state.address === 'https://share.example.com' && state.calls.includes('POST /api/share-address/check'), `${label}: saved, then checked`)
      await setup.getByRole('button', { name: 'Done' }).click()
      await page.getByText('Checked: links reach this hub.').waitFor()
      check(await page.getByText('Checkout redesign').first().isVisible(), `${label}: the live link, by its blueprint`)
      await page.locator('#blueprints').screenshot({ path: path.join(shots, `settings-shares-1440-${scheme}.png`) })
      await layout(page, `${label} settings`)
      await page.getByRole('button', { name: 'Revoke all' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Revoke all' }).click()
      check(await until(() => state.calls.includes('DELETE /api/shares')), `${label}: Revoke all on the hub`)
      await page.getByText('None live. Share a blueprint from its ⋯ menu.').waitFor()
      await ctx.close()
    }

    // ---- Share… on a phone, with the address set: a link for anyone ----
    {
      reset()
      state.address = 'https://share.example.com'
      const { ctx, page } = await open('phone', scheme)
      const label = `share phone ${scheme}`
      await page.goto(`${base}/blueprints`)
      await page.getByRole('button', { name: 'More for Checkout redesign' }).click()
      await page.getByRole('menuitem', { name: 'Share…' }).click()
      const sheet = page.getByRole('dialog', { name: 'Share “Checkout redesign”' })
      const anyone = sheet.getByRole('radio', { name: /Anyone with the link/ })
      await anyone.getByText('Opens at share.example.com, through the proxy you set up.').waitFor()
      await anyone.click()
      await sheet.getByText(/research notes too/).waitFor()
      await sheet.getByRole('button', { name: 'Create link' }).click()
      const url = sheet.getByTestId('share-url')
      await url.waitFor()
      check((await url.textContent()) === 'https://share.example.com/share/Toks1AbCdEfGhIjKlMnOp/', `${label}: a link on the share address (${await url.textContent()})`)
      check(state.shares[0]?.public === true && state.shares[0]?.expires! - state.shares[0]?.created! === 7 * 24 * HOUR, `${label}: for anyone, 7 days`)
      await sheet.getByRole('listitem').getByText('Anyone with the link').waitFor()
      await page.screenshot({ path: path.join(shots, `share-sheet-390-${scheme}.png`) })
      await layout(page, label)
      await sheet.getByRole('button', { name: 'Revoke' }).click()
      check(await until(() => state.shares.length === 0), `${label}: Revoke on the hub`)
      await sheet.getByText('None yet.').waitFor()
      await ctx.close()
    }

    // ---- on a phone: the list, then a session's blueprints in its Activity sheet ----
    {
      reset()
      const { ctx, page } = await open('phone', scheme)
      const label = `phone ${scheme}`
      await page.goto(`${base}/blueprints`)
      await page.locator('.group-heading-name').first().waitFor()
      check((await heads(page)).join('|') === 'accounts|storefront|docs-site', `${label}: tmux sessions first (${await heads(page)})`)
      // what the hub cleaned up, in one line over the list until dismissed
      const cleaned = page.locator('.cleaned-line')
      await cleaned.waitFor()
      check((await cleaned.textContent()) === "Cleaned up 2 blueprints: their sessions ended and they hadn't changed in 14 days. Folders stay where they were.", `${label}: the clean-up line (${await cleaned.textContent()})`)
      check((await cleaned.getAttribute('title')) === 'Old plan, Search spike', `${label}: the clean-up line names them`)
      await page.screenshot({ path: path.join(shots, `blueprints-390-${scheme}.png`) })
      await layout(page, label)
      await cleaned.getByRole('button', { name: 'Dismiss' }).click()
      check(await until(() => state.calls.includes('DELETE /api/pages-cleaned')), `${label}: dismissed on the hub`)
      check((await cleaned.count()) === 0, `${label}: the clean-up line goes`)
      await page.goto(`${base}/m/local/p/11`)
      // a phone's header holds four things: back, the title, the view switch and the menu
      const header = page.locator('header', { has: page.getByRole('link', { name: 'Back' }) })
      await header.getByRole('radiogroup', { name: 'View' }).waitFor()
      await page.screenshot({ path: path.join(shots, `session-header-390-${scheme}.png`), clip: { x: 0, y: 0, width: 390, height: 140 } })
      const shown = await header.locator('a, button, [role=radiogroup]').evaluateAll((els) => els.filter((e) => !e.closest('[role=radiogroup] button') && e.getClientRects().length && !e.closest('h1')).map((e) => e.getAttribute('aria-label') ?? e.getAttribute('title') ?? e.textContent))
      check(shown.join('|') === 'Back|View|More', `${label}: the session header's controls on a phone (${shown})`)
      check(!(await page.getByRole('button', { name: 'Running tasks, subagents and changes' }).isVisible()), `${label}: Activity is in the menu's sheet, not the header`)
      await page.getByRole('button', { name: /^More/ }).filter({ visible: true }).first().click()
      await page.getByRole('dialog').getByRole('button', { name: /^Activity/ }).click()
      const sheet = page.getByRole('dialog')
      // the sheet's five tabs fit across a phone
      const strip = await sheet.getByRole('radiogroup').first().evaluate((el) => el.scrollWidth - el.clientWidth)
      check(strip <= 0, `${label}: the sheet's tabs run ${strip}px past its width`)
      await sheet.getByRole('radio', { name: 'Blueprints' }).click()
      check((await sheet.locator('.side-label').allTextContents()).join('|') === 'This conversation|Earlier in storefront', `${label}: the sheet, this conversation's first`)
      await page.screenshot({ path: path.join(shots, `session-sheet-390-${scheme}.png`) })
      // a row opens the blueprint over the session, in the sheet
      await sheet.getByRole('link', { name: /Cart mockups/ }).click()
      await sheet.frameLocator('iframe').getByRole('heading', { name: 'Cart mockups' }).waitFor()
      check(page.url().endsWith('/m/local/p/11'), `${label}: still on the session`)
      for (const name of ['Reload', 'Open full view']) check(await sheet.getByRole('button', { name }).isVisible(), `${label}: ${name} in the sheet`)
      check((await sheet.locator('.viewer-where').textContent()) === 'storefront · studio', `${label}: the sheet names the session and machine`)
      await page.screenshot({ path: path.join(shots, `session-sheet-viewer-390-${scheme}.png`) })
      await layout(page, `${label} sheet viewer`)
      // Open full view goes to Blueprints, whose back comes to the session
      await sheet.getByRole('button', { name: 'Open full view' }).click()
      await page.waitForURL(/\/blueprints\/local\/cart-mockups$/)
      await page.frameLocator('iframe').first().getByRole('heading', { name: 'Cart mockups' }).waitFor()
      check((await page.locator('.viewer-where').textContent()) === 'storefront · studio', `${label}: the viewer names the session and machine (${await page.locator('.viewer-where').textContent()})`)
      await page.screenshot({ path: path.join(shots, `session-viewer-390-${scheme}.png`) })
      await layout(page, `${label} viewer`)
      await page.getByRole('button', { name: 'Back to the session' }).click()
      await page.waitForURL(/\/m\/local\/p\/11$/)
      await ctx.close()
    }

    // ---- the phone viewer's top bar at 360px: back, the name, and everything else in ⋯ ----
    {
      reset()
      const { ctx, page } = await open('phone', scheme, 360)
      const label = `phone viewer 360 ${scheme}`
      await page.goto(`${base}/blueprints/local/checkout-redesign`)
      await page.frameLocator('iframe').first().getByRole('heading', { name: 'Checkout redesign' }).waitFor()
      const bar = page.locator('header').first()
      const title = await bar.locator('h1').evaluate((el) => el.getBoundingClientRect().width)
      check(title >= 200, `${label}: the name has room (${title}px)`)
      check((await bar.getByRole('button').count()) === 2, `${label}: only Back and More in the bar (${await bar.getByRole('button').count()})`)
      await bar.getByRole('button', { name: 'More' }).click()
      const menu = page.getByRole('menu')
      for (const name of ['Reload', 'Open in browser', 'Plan', 'Mockups', 'Cart mockups', 'Open studio']) check(await menu.getByRole('menuitem', { name }).first().isVisible(), `${label}: ${name} in ⋯`)
      await page.screenshot({ path: path.join(shots, `blueprints-viewer-menu-360-${scheme}.png`) })
      await menu.getByRole('menuitem', { name: 'Mockups', exact: true }).click()
      await page.frameLocator('iframe').first().getByRole('heading', { name: 'Checkout redesign: mockups' }).waitFor()
      check((await page.locator('.viewer-part').textContent()) === ' · Mockups', `${label}: the part on screen under the name`)
      await page.screenshot({ path: path.join(shots, `blueprints-viewer-360-${scheme}.png`) })
      await layout(page, label)
      // a machine's six tabs scroll at this width too, and the last one comes into view
      await page.goto(`${base}/machines/local`)
      const integration = page.getByRole('radio', { name: 'Integration' })
      await integration.waitFor()
      check(await integration.evaluate((el) => el.parentElement!.scrollWidth > el.parentElement!.clientWidth), `${label}: a machine's tabs overflow 360px (the case this covers)`)
      await page.getByRole('radio', { name: 'Sessions' }).focus()
      await page.keyboard.press('End')
      check((await integration.getAttribute('aria-checked')) === 'true', `${label}: End picks the machine's last tab`)
      check(await until(async () => (await shown(integration)) === 1), `${label}: Integration scrolled into view (${await shown(integration)})`)
      await layout(page, `${label} machine`)
      // let the pill finish sliding under the tab
      await page.waitForTimeout(400)
      await page.screenshot({ path: path.join(shots, `machine-tabs-360-${scheme}.png`) })
      await ctx.close()
    }
  }
} catch (e) {
  console.error(problems.join('\n'))
  // what was on screen when a step gave up
  for (const c of browser.contexts()) for (const [i, t] of c.pages().entries()) await t.screenshot({ path: path.join(shots, `failed-${i}.png`) }).catch(() => {})
  throw e
} finally {
  await browser.close()
  server.stop(true)
}

if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`blueprints: ${checks} checks at 390×844 and 1440×900, light and dark; screenshots in ${shots}`)
