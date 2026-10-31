// bun apps/app/e2e/overview.ts — the built app (apps/app/dist, from build.sh) in Chromium behind a
// stand-in hub: the page under the hub's own CSP for /next, the sign-in endpoints and the /ws
// overview, fed made-up data (demo.ts). Signs in, checks the Overview at phone and desktop sizes in
// light and dark, answers a waiting agent, folds a machine, rides out a dropped socket, and saves a
// screenshot of each size and theme to $SHOTS (default: a temp folder).
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

// the policy the hub sends with the page, read from the hub's source so the two can't drift
const rs = await Bun.file(path.join(root, 'crates/inyon-hub/src/static_files.rs')).text()
const NEXT_CSP = /pub const NEXT_CSP: &str = "([^"]+)"/.exec(rs)![1]!

const PASSWORD = 'correct horse'
const state = { setup: false, setupCode: false, authed: false, refuse: false, answers: [] as unknown[] }
const sockets = new Set<ServerWebSocket<unknown>>()

const server = Bun.serve({
  port: 0,
  async fetch(req, srv) {
    const url = new URL(req.url)
    const p = url.pathname
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers })
    if (p === '/ws') {
      if (!state.authed || state.refuse) return new Response('Not signed in', { status: 401 })
      return srv.upgrade(req) ? undefined : new Response('no upgrade', { status: 400 })
    }
    if (p === '/api/session') return json({ authed: state.authed, setup: state.setup, setupCode: state.setupCode })
    if (p === '/api/login' && req.method === 'POST') {
      const { password } = await req.json()
      if (password !== PASSWORD) return json({ error: 'Wrong password' }, 401)
      state.authed = true
      return json({ ok: true }, 200, { 'set-cookie': 'inyon_session=test; Path=/; HttpOnly; SameSite=Strict' })
    }
    if (p === '/api/setup' && req.method === 'POST') {
      const { password, code } = await req.json()
      if (state.setupCode && code !== 'ab12-cd34') return json({ error: 'That setup code is wrong' }, 403)
      if (password.length < 8) return json({ error: 'Too short' }, 400)
      state.setup = false
      state.authed = true
      return json({ ok: true })
    }
    const answer = /^\/api\/hosts\/([^/]+)\/panes\/([^/]+)\/answer$/.exec(p)
    if (answer && req.method === 'POST') {
      state.answers.push({ host: decodeURIComponent(answer[1]!), pane: answer[2], ...(await req.json()) })
      return json({ ok: true })
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
    message(ws, m) {
      const msg = JSON.parse(String(m))
      if (msg.t === 'sub.overview') ws.send(JSON.stringify(overview()))
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

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
const errors: string[] = []
const watch = (page: Page) => {
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
}
try {
  // ---- sign in, as a returning user ----
  {
    const ctx = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'light', reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    watch(page)
    await page.goto(`${base}/next/`)
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
    await page.screenshot({ path: path.join(shots, 'signin-390-light.png') })
    await layout(page, 'sign-in')
    const pw = page.getByLabel('Password', { exact: true })
    await pw.fill('wrong one')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('alert').filter({ hasText: 'Wrong password' }).waitFor()
    await pw.fill(PASSWORD)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('heading', { name: 'Overview' }).waitFor()
    check(await page.getByText('1 session needs you.').isVisible(), 'sign-in: the overview after signing in')
    await ctx.close()
  }

  // ---- the first password on a new hub, with its setup code ----
  {
    Object.assign(state, { authed: false, setup: true, setupCode: true })
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    watch(page)
    await page.goto(`${base}/next`)
    await page.getByRole('heading', { name: 'Create your password' }).waitFor()
    const submit = page.getByRole('button', { name: 'Create password' })
    await page.getByLabel('New password').fill('long enough')
    await page.getByLabel('Type the password again').fill('long enougj')
    check(await submit.isDisabled(), 'setup: submit waits for the setup code')
    await page.getByLabel('Setup code').fill('ab12-cd34')
    await submit.click()
    await page.getByRole('alert').filter({ hasText: "The two passwords don't match." }).waitFor()
    await page.getByLabel('Type the password again').fill('long enough')
    await page.screenshot({ path: path.join(shots, 'setup-1440-dark.png') })
    await submit.click()
    await page.getByRole('heading', { name: 'Overview' }).waitFor()
    await ctx.close()
  }

  // ---- the overview at both sizes, light and dark ----
  state.authed = true
  for (const [w, h] of [[390, 844], [1440, 900]] as const)
    for (const scheme of ['light', 'dark'] as const) {
      const label = `overview ${w}x${h} ${scheme}`
      const phone = w < 600
      const ctx = await browser.newContext({ ...(phone ? devices['iPhone 13'] : {}), viewport: { width: w, height: h }, colorScheme: scheme, reducedMotion: 'reduce' })
      const page = await ctx.newPage()
      watch(page)
      await page.goto(`${base}/next/`)
      await page.getByRole('heading', { name: 'Overview' }).waitFor()
      await page.locator('.card').first().waitFor()
      check((await page.evaluate(() => document.documentElement.dataset.theme)) === scheme, `${label}: the theme follows the system`)
      check((await page.locator('.card').count()) === 4, `${label}: four session cards`)
      check(await page.getByRole('button', { name: /studio/ }).isVisible(), `${label}: sessions grouped by machine`)
      check(await page.getByText('Plan limits').isVisible(), `${label}: the plan limits`)
      check(await page.locator(phone ? '.machine-list' : '.machine-table').isVisible(), `${label}: the machines as a ${phone ? 'list' : 'table'}`)
      check(await page.locator(phone ? '.tabbar' : '.sidebar').isVisible(), `${label}: the ${phone ? 'tab bar' : 'sidebar'}`)
      check((await page.locator('a[href="/m/local/p/11"]').count()) === 1, `${label}: a card opens its session in the web app`)
      await layout(page, label)
      await page.screenshot({ path: path.join(shots, `overview-${w}-${scheme}.png`) })
      // the page scrolls inside the shell, so the lower half is a second picture
      await page.locator('.scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight))
      await page.screenshot({ path: path.join(shots, `overview-${w}-${scheme}-end.png`) })
      await ctx.close()
    }

  // ---- answering, folding, a dropped socket ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    watch(page)
    await page.goto(`${base}/next/`)
    await page.locator('.card').first().waitFor()
    await page.locator('.card-waiting').getByRole('button', { name: 'Yes' }).click()
    await page.locator('.card-waiting').getByText('Sent').waitFor()
    check(JSON.stringify(state.answers) === JSON.stringify([{ host: 'local', pane: '12', option: 1 }]), `answer: posted ${JSON.stringify(state.answers)}`)

    await page.getByRole('radio', { name: 'Working' }).click()
    check((await page.locator('.card').count()) === 2, 'filter: working and background sessions only')
    await page.getByRole('radio', { name: 'All' }).click()
    check((await page.locator('.card').count()) === 4, 'filter: all again')

    const group = page.getByRole('button', { name: /build-box/ })
    await group.click()
    check((await group.getAttribute('aria-expanded')) === 'false', 'fold: the group closes')
    check((await page.evaluate(() => localStorage.getItem('inyon.folded'))) === '["home:build-box"]', 'fold: kept in the web app’s key')
    await page.reload()
    await page.locator('.card').first().waitFor()
    check((await page.getByRole('button', { name: /build-box/ }).getAttribute('aria-expanded')) === 'false', 'fold: still closed after a reload')

    // the hub restarting: the socket drops and isn't taken back for a moment
    state.refuse = true
    for (const ws of sockets) ws.close()
    await page.getByText('Reconnecting').first().waitFor()
    state.refuse = false
    await page.getByText('Reconnecting').first().waitFor({ state: 'hidden', timeout: 15_000 })
    check((await page.locator('.card').count()) === 4, 'reconnect: the overview is back')

    // signed out elsewhere: the next drop finds the session gone and shows the form
    state.authed = false
    for (const ws of sockets) ws.close()
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor({ timeout: 15_000 })
    await ctx.close()
  }
} finally {
  await browser.close()
  server.stop(true)
}

// the sign-in check above reads a wrong password on purpose, and the hub refuses the socket once signed out
const unexpected = errors.filter((e) => !/401|Unauthorized|WebSocket/.test(e))
check(!unexpected.length, `errors in the page: ${unexpected.join(' | ')}`)
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`ok: sign-in, setup, the overview at 390x844 and 1440x900 in light and dark, answering, filtering, folding, reconnecting; screenshots in ${shots}`)
