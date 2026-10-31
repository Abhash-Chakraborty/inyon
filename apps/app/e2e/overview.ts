// bun apps/app/e2e/overview.ts — the built app (apps/app/dist, from build.sh) in Chromium behind a
// stand-in hub: the page under the hub's own CSP for /next, the sign-in endpoints, the pane actions
// and the /ws2 streams (protocol v2), fed made-up data (demo.ts). Signs in, checks the Overview and
// a session's screen at phone and desktop sizes in light and dark, answers a waiting agent from a
// card and from the chat, sends a message, loads older messages, folds a machine, rides out a
// dropped socket, and saves a screenshot of each size and theme to $SHOTS (default: a temp folder).
// CHROME=/path/to/chrome uses a browser other than Playwright's own.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, devices, type Page } from 'playwright'
import type { ServerWebSocket } from 'bun'
import { accounts, overview, storefront, twoQuestions } from './demo.ts'

const root = path.join(import.meta.dir, '../../..')
const dist = path.join(import.meta.dir, '../dist')
const web = path.join(root, 'apps/web/public')
const shots = process.env.SHOTS ?? path.join(tmpdir(), 'inyon-app-shots')
mkdirSync(shots, { recursive: true })

// the policy the hub sends with the page, read from the hub's source so the two can't drift
const rs = await Bun.file(path.join(root, 'crates/inyon-hub/src/static_files.rs')).text()
const NEXT_CSP = /pub const NEXT_CSP: &str = "([^"]+)"/.exec(rs)![1]!

const PASSWORD = 'correct horse'
const state = { setup: false, setupCode: false, authed: false, refuse: false, answers: [] as unknown[], sends: [] as unknown[], drafts: [] as unknown[], frames: [] as unknown[] }
type Socket = ServerWebSocket<{ subs: Set<string> }>
const sockets = new Set<Socket>()

// the chats the stand-in hub has, as /ws2 streams: rows, single values and a seq per change
type Stream = { seq: number; items: Record<string, unknown>[]; state: Record<string, unknown>; older?: Record<string, unknown>[] }
const streams = new Map<string, Stream>()
function resetChats() {
  streams.clear()
  const s = storefront()
  streams.set('local:%11', { seq: 1, items: s.items, state: s.state, older: s.older })
  const a = accounts()
  streams.set('local:%12', { seq: 1, items: a.items, state: a.state })
}
resetChats()
const EPOCH = 1

function snapshot(stream: string) {
  if (stream === 'overview') return { t: 'snapshot', stream, epoch: EPOCH, seq: 1, rows: { hosts: overview().hosts } }
  const c = streams.get(stream)
  if (!c) return { t: 'snapshot', stream, epoch: EPOCH, seq: 1, rows: { items: [] }, state: { loaded: true, hasMore: false } }
  return { t: 'snapshot', stream, epoch: EPOCH, seq: c.seq, rows: { items: c.items, live: [], queue: [] }, state: c.state }
}

/** A change to a chat, sent to every socket that follows it. */
function change(stream: string, parts: { append?: Record<string, unknown>[]; state?: Record<string, unknown> }) {
  const c = streams.get(stream)!
  const from = c.seq++
  if (parts.append) c.items.push(...parts.append)
  if (parts.state) Object.assign(c.state, parts.state)
  const frame = JSON.stringify({ t: 'delta', stream, epoch: EPOCH, from, seq: c.seq, ...(parts.append ? { append: { items: parts.append } } : {}), ...(parts.state ? { state: parts.state } : {}) })
  for (const ws of sockets) if (ws.data.subs.has(stream)) ws.send(frame)
}

/** The key an answer names its question by (inyon-protocol's prompt_key). */
const promptKey = (p: { body: string[]; options: { n: number; label: string }[] }) => [...p.body, ...p.options.map((o) => `${o.n}.${o.label}`)].join('\n').replace(/\s+/g, '')

const server = Bun.serve({
  port: 0,
  async fetch(req, srv) {
    const url = new URL(req.url)
    const p = url.pathname
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers })
    if (p === '/ws2') {
      if (!state.authed || state.refuse) return new Response('Not signed in', { status: 401 })
      return srv.upgrade(req, { data: { subs: new Set<string>() } }) ? undefined : new Response('no upgrade', { status: 400 })
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
    const action = /^\/api\/hosts\/([^/]+)\/panes\/([^/]+)\/(answer|send)$/.exec(p)
    if (action && req.method === 'POST') {
      const host = decodeURIComponent(action[1]!)
      const pane = action[2]!
      const body = await req.json()
      const stream = `${host}:%${pane}`
      if (action[3] === 'send') {
        state.sends.push({ host, pane, ...body })
        // the agent's record picks the message up a moment later
        setTimeout(() => change(stream, { append: [{ kind: 'user', seq: 1000 + state.sends.length, uuid: `sent${state.sends.length}`, ts: new Date().toISOString(), text: body.text, images: 0 }] }), 400)
        return json({ ok: true })
      }
      state.answers.push({ host, pane, ...body })
      const c = streams.get(stream)
      const asked = (c?.state.screen as { prompt?: { body: string[]; options: { n: number; label: string }[] } } | undefined)?.prompt
      if (c && asked) {
        // the hub presses keys only for the question on screen
        if (body.question !== undefined && body.question !== promptKey(asked)) return json({ error: 'That question is no longer on screen' }, 409)
        // the first answer brings the next question; the second lets the agent go on
        const next = asked.body[0] === twoQuestions.body[0] ? { working: true, activity: 'Writing the migration…', model: 'GPT-6-Astra', effort: 'medium', width: 120 } : { working: false, model: 'GPT-6-Astra', effort: 'medium', width: 120, prompt: twoQuestions }
        setTimeout(() => change(stream, { state: { screen: next } }), 300)
      }
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
      state.frames.push(msg)
      if (msg.t === 'hello') ws.send(JSON.stringify({ t: 'hello', v: 2 }))
      if (msg.t === 'sub') {
        ws.data.subs.add(msg.stream)
        // the overview and a chat that hasn't changed since `at`: up to date already
        const c = streams.get(msg.stream)
        const seq = msg.stream === 'overview' ? 1 : (c?.seq ?? 1)
        if (msg.at?.epoch === EPOCH && msg.at.seq === seq) ws.send(JSON.stringify({ t: 'delta', stream: msg.stream, epoch: EPOCH, from: seq, seq }))
        else ws.send(JSON.stringify(snapshot(msg.stream)))
      }
      if (msg.t === 'unsub') ws.data.subs.delete(msg.stream)
      if (msg.t === 'more') {
        const c = streams.get(msg.stream)
        ws.send(JSON.stringify({ t: 'more', stream: msg.stream, items: c?.older ?? [], hasMore: false }))
        if (c) c.state.hasMore = false
      }
      if (msg.t === 'draft') state.drafts.push(msg)
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
      check((await page.locator('a[href="/next/m/local/p/11"]').count()) === 1, `${label}: a card opens its session in this app`)
      await layout(page, label)
      await page.screenshot({ path: path.join(shots, `overview-${w}-${scheme}.png`) })
      // the page scrolls inside the shell, so the lower half is a second picture
      await page.locator('.scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight))
      await page.screenshot({ path: path.join(shots, `overview-${w}-${scheme}-end.png`) })
      await ctx.close()
    }

  // ---- a session: the chat at both sizes, light and dark ----
  resetChats()
  for (const [w, h] of [[390, 844], [1440, 900]] as const)
    for (const scheme of ['light', 'dark'] as const) {
      const label = `session ${w}x${h} ${scheme}`
      const phone = w < 600
      const ctx = await browser.newContext({ ...(phone ? devices['iPhone 13'] : {}), viewport: { width: w, height: h }, colorScheme: scheme, reducedMotion: 'reduce' })
      const page = await ctx.newPage()
      watch(page)
      await page.goto(`${base}/next/m/local/p/11`)
      await page.getByRole('heading', { name: 'Fix flaky checkout test' }).waitFor()
      await page.getByText('All 20 runs pass now.').waitFor()
      check(await page.getByText('Claude Code · studio · storefront:1').isVisible(), `${label}: where the pane is`)
      check(await page.locator('.working-verb').filter({ hasText: 'Running the whole suite…' }).isVisible(), `${label}: the working line`)
      check(await page.getByRole('button', { name: 'Queue follow-up' }).count() + (await page.getByRole('button', { name: 'Stop' }).count()) === 1, `${label}: one send/stop button`)
      check(await page.locator('.composer-controls').filter({ hasText: 'Sonnet 5.5 · medium' }).isVisible(), `${label}: the model and effort under the box`)
      check(phone === (await page.getByRole('link', { name: 'Back' }).isVisible()), `${label}: a back link on phones only`)
      check((await page.getByRole('link', { name: /Terminal/ }).getAttribute('href')) === '/m/local/p/11?view=terminal', `${label}: the terminal opens in the web app`)
      // only the rows near the screen are in the page
      const drawn = await page.locator('.vrow').count()
      check(drawn > 3 && drawn < 40, `${label}: ${drawn} of 64 rows drawn`)
      await layout(page, label)
      await page.screenshot({ path: path.join(shots, `session-${w}-${scheme}.png`) })
      // the reply's code block, open tool details and the indented message, from closer up
      await page.getByRole('button', { name: /Edited|Edit/ }).last().click()
      await page.getByText('expect(total).toBe(4200)').scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
      await page.screenshot({ path: path.join(shots, `session-${w}-${scheme}-history.png`) })

      await page.goto(`${base}/next/m/local/p/12`)
      await page.getByText('Would you like to run the following command?').waitFor()
      check(!(await page.locator('.composer').count()), `${label}: the question takes the box's place`)
      check(await page.locator('.prompt-why').isVisible(), `${label}: one line says where the model controls went`)
      check((await page.evaluate(() => document.activeElement?.textContent)) === '1Yes, proceed', `${label}: focus on the likely answer`)
      await layout(page, `${label} question`)
      await page.screenshot({ path: path.join(shots, `session-${w}-${scheme}-question.png`) })
      await ctx.close()
    }

  // ---- a session: send, load older messages, answer two questions ----
  {
    resetChats()
    state.answers = []
    const ctx = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'light', reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    watch(page)
    // from the Overview's card, without loading the page again
    await page.goto(`${base}/next/`)
    await page.locator('a[href="/next/m/local/p/11"]').click()
    await page.getByRole('heading', { name: 'Fix flaky checkout test' }).waitFor()
    check(await page.evaluate(() => performance.getEntriesByType('navigation').length === 1 && location.pathname === '/next/m/local/p/11'), 'route: the card opens the session in place')

    // a message's own indentation and the code block's survive (Ghostex #252)
    const bubble = await page.locator('.bubble').filter({ hasText: 'expect(total)' }).evaluate((el) => ({ text: el.textContent, ws: getComputedStyle(el).whiteSpace }))
    check(bubble.text?.includes('\n    expect(total).toBe(4200)\n      at checkout.test.ts:88') && bubble.ws === 'pre-wrap', `indent: the message keeps its spaces (${JSON.stringify(bubble)})`)
    const code = await page.locator('.code-body').first().textContent()
    check(code?.includes('\n  const discounted = await applyDiscount(cart)\n  return discounted.items.reduce(\n    (sum, item)'), `indent: the code block keeps its spaces (${JSON.stringify(code)})`)

    // older messages: reading back to the top fetches them (a wheel, as a reader's own scroll)
    await page.mouse.move(195, 400)
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -1500)
    // reaching the top fetches them by itself; the button is there for a reader who stops short
    const earlier = page.getByRole('button', { name: 'Earlier messages' })
    if (await earlier.isVisible()) await earlier.click()
    // they come in above the row being read, which stays put: scroll up to them
    await page.waitForTimeout(500)
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -1500)
    await page.getByText('Start the cart refactor: one map for the items').waitFor()
    check(state.frames.some((f) => JSON.stringify(f) === JSON.stringify({ t: 'more', stream: 'local:%11', before: 1 })), 'more: asks for what came before the first message')

    // typing is the draft, sending posts the message and it lands in the conversation
    const box = page.getByRole('textbox', { name: 'Message Claude Code' })
    await box.fill('Commit it as "Wait for the discount before totalling"')
    await page.waitForTimeout(700)
    check(state.drafts.some((d) => JSON.stringify(d) === JSON.stringify({ t: 'draft', host: 'local', pane: '%11', text: 'Commit it as "Wait for the discount before totalling"' })), `draft: sent to the hub (${JSON.stringify(state.drafts)})`)
    await page.getByRole('button', { name: 'Queue follow-up' }).click()
    await page.locator('.bubble').filter({ hasText: 'Commit it as' }).first().waitFor()
    const sent = state.sends[0] as { text?: string; requestId?: string } | undefined
    check(sent?.text === 'Commit it as "Wait for the discount before totalling"' && !!sent.requestId, `send: posted ${JSON.stringify(state.sends)}`)
    check((await box.inputValue()) === '', 'send: the box empties')
    await page.waitForTimeout(1200)
    check((await page.locator('.bubble').filter({ hasText: 'Commit it as' }).count()) === 1, 'send: the message shows once after it lands')
    check(!(await page.locator('.bubble-pending').count()), 'send: no longer pending once the record has it')
    await page.screenshot({ path: path.join(shots, 'session-390-light-sent.png') })

    // the agent asks: keys pick, and the answer names its question (Ghostex #251)
    await page.goto(`${base}/next/m/local/p/12`)
    await page.getByText('Would you like to run the following command?').waitFor()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await page.getByText('Which store should the passkeys live in?').waitFor()
    const first = state.answers[0] as Record<string, unknown> | undefined
    check(first?.option === 2 && first.question === promptKey(accounts().state.screen.prompt), `answer: ${JSON.stringify(first)}`)
    check((await page.getByRole('tab').count()) === 3, 'questions: one tab each')
    check((await page.evaluate(() => document.activeElement?.textContent ?? '')).startsWith('1In the accounts table'), 'questions: focus moves to the new question')
    await page.screenshot({ path: path.join(shots, 'session-390-light-questions.png') })
    // the free-text choice opens a box for the answer
    await page.keyboard.press('3')
    const free = page.getByRole('textbox', { name: 'Your answer' })
    await free.waitFor()
    await page.getByRole('button', { name: 'Back' }).click()
    await page.keyboard.press('2')
    await page.locator('.composer').waitFor()
    const second = state.answers[1] as Record<string, unknown> | undefined
    check(second?.option === 2 && second.question === promptKey(twoQuestions), `answer: ${JSON.stringify(second)}`)
    check(await page.locator('.composer-controls').filter({ hasText: 'GPT-6-Astra · medium' }).isVisible(), 'answer: the model controls are back')
    await ctx.close()
  }

  // ---- the questions on a desktop, dark ----
  {
    resetChats()
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    watch(page)
    await page.goto(`${base}/next/m/local/p/12`)
    await page.getByText('Would you like to run the following command?').waitFor()
    await page.getByRole('option', { name: /Yes, proceed/ }).click()
    await page.getByText('Which store should the passkeys live in?').waitFor()
    await layout(page, 'questions 1440 dark')
    await page.screenshot({ path: path.join(shots, 'session-1440-dark-questions.png') })
    await ctx.close()
  }

  // ---- answering, folding, a dropped socket ----
  resetChats()
  state.answers = []
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
console.log(`ok: sign-in, setup, the overview and a session at 390x844 and 1440x900 in light and dark, sending, older messages, answering from a card and from the chat, filtering, folding, reconnecting; screenshots in ${shots}`)
