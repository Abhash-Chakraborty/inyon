// bun e2e/blueprints.ts — Blueprints in the built app (dist/, from `bun run build`) in Chromium, fed
// made-up machines and pages: the list grouped by tmux session with the machine as a label, a
// heading that follows a renamed session, the viewer naming the session, Open in new tab opening
// the part on screen, and a session's blueprints (this conversation's first, another tmux
// session's kept out) beside the chat on a desktop and in the Activity sheet on a phone, whose
// viewer goes back to the session. At 390×844 and 1440×900, light and dark, with a screenshot of
// each. CHROME=/path/to/chrome uses a browser other than Playwright's own; SHOTS= picks the folder.
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
const state = { pages: fresh(), tmux: 'storefront', opened: [] as string[], cleaned: note() as { pages: unknown[] }, settings: hubSettings() as Record<string, any>, calls: [] as string[] }
const reset = () => Object.assign(state, { pages: fresh(), tmux: 'storefront', opened: [], cleaned: note(), settings: hubSettings(), calls: [] })

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

async function open(kind: 'phone' | 'desktop', scheme: 'light' | 'dark') {
  const ctx = await browser.newContext(kind === 'phone' ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, colorScheme: scheme } : { viewport: { width: 1440, height: 900 }, colorScheme: scheme })
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
      await page.screenshot({ path: path.join(shots, `session-blueprints-viewer-1440-${scheme}.png`) })
      await layout(page, label)
      await side.getByRole('button', { name: "This session's blueprints" }).click()
      await side.locator('.side-label').first().waitFor()
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
      await page.getByRole('button', { name: 'Running tasks, subagents and changes' }).click()
      const sheet = page.getByRole('dialog')
      // the sheet's five tabs fit across a phone
      const strip = await sheet.getByRole('radiogroup').first().evaluate((el) => el.scrollWidth - el.clientWidth)
      check(strip <= 0, `${label}: the sheet's tabs run ${strip}px past its width`)
      await sheet.getByRole('radio', { name: 'Blueprints' }).click()
      check((await sheet.locator('.side-label').allTextContents()).join('|') === 'This conversation|Earlier in storefront', `${label}: the sheet, this conversation's first`)
      await page.screenshot({ path: path.join(shots, `session-sheet-390-${scheme}.png`) })
      await sheet.getByRole('link', { name: /Cart mockups/ }).click()
      await page.waitForURL(/\/blueprints\/local\/cart-mockups$/)
      await page.frameLocator('iframe').first().getByRole('heading', { name: 'Cart mockups' }).waitFor()
      check((await page.locator('.viewer-where').textContent()) === 'storefront', `${label}: the viewer names the session`)
      await page.screenshot({ path: path.join(shots, `session-viewer-390-${scheme}.png`) })
      await layout(page, `${label} viewer`)
      await page.getByRole('button', { name: 'Back to the session' }).click()
      await page.waitForURL(/\/m\/local\/p\/11$/)
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
