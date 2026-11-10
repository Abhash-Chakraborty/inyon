// bun apps/app/e2e/organize.ts — organising sessions (from 1.1) in the built app (apps/app/dist, from
// build.sh) in Chromium behind a stand-in hub: the page under the hub's own CSP for /next, the /ws2
// overview and organize streams, and PATCH …/organize, which it keeps the way the hub does. Checks
// the sidebar's sections, the session menu with its submenus (by mouse and keys), pinning, snoozing
// and parking with Undo, a new tag, a note, renaming, picking several sessions with Cmd/Ctrl- and
// Shift-click for the bulk menu and the selection bar, and on a phone the long-press menu, its
// submenus and picking by tap. Saves a screenshot of each size and theme to $SHOTS (default: a temp
// folder). CHROME=/path/to/chrome uses a browser other than Playwright's own.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, devices, type Page } from 'playwright'
import type { ServerWebSocket } from 'bun'
import { overview } from './demo.ts'
import { capture } from './failure.ts'

const root = path.join(import.meta.dir, '../../..')
const dist = path.join(import.meta.dir, '../dist')
const web = path.join(root, 'apps/web/public')
const shots = process.env.SHOTS ?? path.join(tmpdir(), 'inyon-app-shots')
mkdirSync(shots, { recursive: true })

const rs = await Bun.file(path.join(root, 'crates/inyon-hub/src/static_files.rs')).text()
const NEXT_CSP = /pub const NEXT_CSP: &str =\s*"([^"]+)"/.exec(rs)![1]!

type Entry = Record<string, any>
type Mark = Entry & { id: string; host: string; pane: string; live: boolean }
const state = {
  hosts: overview(Date.now()).hosts as Entry[],
  org: { v: 2, sessions: [] as Mark[], projects: [], groups: [], spaces: [] },
  calls: [] as { method: string; path: string; body?: any }[],
  marks: 0,
  /** ms the hub takes to answer a change */
  slow: 0,
}
type Socket = ServerWebSocket<{ subs: Set<string> }>
const sockets = new Set<Socket>()
let seq = 1
const EPOCH = 1
function frame(stream: string) {
  const rows = stream === 'overview' ? { hosts: state.hosts } : stream === 'pages' ? { pages: [] } : { sessions: state.org.sessions, projects: [], groups: [], spaces: [] }
  return JSON.stringify({ t: 'snapshot', stream, epoch: EPOCH, seq, rows })
}
function publish(stream: string) {
  seq++
  for (const ws of sockets) if (ws.data.subs.has(stream)) ws.send(frame(stream))
}
const patches = () => state.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/organize'))

/** A change to one session's mark, as the hub makes it: a mark is made on first use, `null` or false clears a field. */
function organize(host: string, pane: string, b: Entry) {
  let m = state.org.sessions.find((x) => x.host === host && x.pane === pane)
  if (!m) {
    m = { id: `s-${++state.marks}`, host, pane, live: true, seen: Date.now() }
    state.org.sessions.push(m)
  }
  if ('pinned' in b) {
    if (!b.pinned) delete m.pinned
    else if (m.pinned === undefined) m.pinned = Math.max(-1, ...state.org.sessions.map((x) => x.pinned ?? -1)) + 1
  }
  if ('parked' in b) b.parked ? (m.parked = true) : delete m.parked
  if ('snoozedUntil' in b) b.snoozedUntil == null ? delete m.snoozedUntil : (m.snoozedUntil = b.snoozedUntil)
  if ('tags' in b) b.tags?.length ? (m.tags = b.tags) : delete m.tags
  if ('note' in b) b.note ? (m.note = b.note) : delete m.note
  if ('closeWhenDone' in b) b.closeWhenDone ? (m.closeWhenDone = true) : delete m.closeWhenDone
  setTimeout(() => publish('organize'), 30)
  return { session: m }
}

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
    const pane = /^\/api\/hosts\/([^/]+)\/panes\/([^/]+)\/(organize|name)$/.exec(p)
    if (pane) {
      const [host, id] = [decodeURIComponent(pane[1]!), `%${pane[2]}`]
      if (pane[3] === 'organize' && req.method === 'PATCH') {
        // the change is made at once; only the answer is late
        const done = organize(host, id, body)
        if (state.slow) await Bun.sleep(state.slow)
        return json(done)
      }
      if (pane[3] === 'name' && req.method === 'PUT') {
        for (const h of state.hosts) for (const s of h.sessions) for (const w of s.windows) for (const x of w.panes) if (h.config.id === host && x.id === id) x.label = body.name || undefined
        setTimeout(() => publish('overview'), 30)
        return json({ ok: true })
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
const menuItems = (page: Page, which = 'menu') => page.locator(`.${which}`).last().locator('.menu-item, .menu-header').allTextContents()
/** Esc in a submenu goes back to its menu; once more closes that. */
const closeMenu = async (page: Page) => {
  for (let i = 0; i < 3 && (await page.locator('.menu').count()); i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(80)
  }
  await page.locator('.menu').first().waitFor({ state: 'detached' })
}
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
  state.calls = []
  publish('overview')
  publish('organize')
}
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

try {
  // ---- desktop: the sidebar's sections, the menus and the bulk actions ----
  for (const scheme of ['light', 'dark'] as const) {
    reset()
    const ctx = await browser.newContext({ ...desktop, colorScheme: scheme })
    const page = await ctx.newPage()
    watch(page)
    await page.goto(`${base}/next/`)
    await styled(page)
    const label = `desktop ${scheme}`
    const list = page.locator('.session-list')
    await list.locator('.side-row').nth(3).waitFor()
    const heads = () => list.locator('.side-head-label').allTextContents()
    check((await heads()).join(',') === 'Sessions', `${label}: one section before anything is organised (${await heads()})`)
    check((await list.locator('.side-title').allTextContents()).join('|') === 'Fix flaky checkout test|Migrate auth to passkeys|Write release notes|Tidy the billing API types', `${label}: rows in the Overview's order`)
    const row = (title: string) => list.locator('.side-row', { hasText: title })

    if (scheme === 'light') {
      // the menu, in Ghostex's order
      await row('Write release notes').locator('.side-link').click({ button: 'right' })
      check((await menuItems(page)).join('|') === 'Open|Open terminal|Open in new tab|Rename…|Pin|Snooze…|Park|Tag as|Copy|More|Select|End session…', `${label}: the session menu (${await menuItems(page)})`)
      // a submenu opens beside its item on hover, and with → from the keyboard
      await page.locator('.menu .menu-item', { hasText: 'More' }).hover()
      await page.locator('.menu-sub').waitFor()
      check((await menuItems(page, 'menu-sub')).join('|') === 'Note…|Close when done', `${label}: More's submenu (${await menuItems(page, 'menu-sub')})`)
      const sub = (await page.locator('.menu-sub').boundingBox())!
      const main = (await page.locator('.menu').first().boundingBox())!
      check(sub.x >= main.x + main.width - 12, `${label}: the submenu sits beside the menu`)
      await page.screenshot({ path: path.join(shots, 'organize-menu-1440-light.png') })
      await page.locator('.menu .menu-item', { hasText: 'Copy' }).hover()
      check(await until(async () => (await menuItems(page, 'menu-sub')).join('|') === 'Folder path|tmux target'), `${label}: hovering another item swaps the submenu (${await menuItems(page, 'menu-sub')})`)
      await page.locator('.menu .menu-item', { hasText: 'Park' }).first().focus()
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowRight')
      check(await until(async () => (await page.evaluate(() => document.activeElement?.id)) === 'menu-sub-0'), `${label}: → opens the submenu and focuses its first item`)
      await page.keyboard.press('ArrowLeft')
      check(await until(async () => (await page.locator('.menu-sub').count()) === 0), `${label}: ← closes the submenu`)
      await closeMenu(page)

      // pin: its own section, and Pinned on the Overview
      await row('Write release notes').locator('.side-link').click({ button: 'right' })
      await page.locator('.menu .menu-item', { hasText: 'Pin' }).click()
      check(await until(() => patches().length === 1), `${label}: Pin asks the hub`)
      check(JSON.stringify(patches()[0]?.body) === '{"pinned":true}' && patches()[0]?.path === '/api/hosts/build-box/panes/13/organize', `${label}: the pin's request (${JSON.stringify(patches()[0])})`)
      check(await until(async () => (await heads()).join(',') === 'Pinned,Sessions'), `${label}: a Pinned section (${await heads()})`)
      check(await until(async () => (await page.locator('.pinned .card-title').allTextContents()).join() === 'Write release notes'), `${label}: Pinned on the Overview`)

      // snooze for an hour from the Snooze sheet, told when it's back, then Undo on the toast
      await row('Tidy the billing API types').locator('.side-link').click({ button: 'right' })
      await page.locator('.menu .menu-item', { hasText: 'Snooze…' }).click()
      const snoozeSheet = page.getByRole('dialog', { name: 'Snooze' })
      await snoozeSheet.waitFor()
      const choices = await snoozeSheet.locator('.snooze-label').allTextContents()
      check(choices.join('|') === 'For an hour|For three hours|Until tomorrow morning|Until next week', `${label}: the snooze choices (${choices})`)
      check((await snoozeSheet.locator('.snooze-at').nth(3).textContent())?.startsWith('until Mon '), `${label}: next week is a Monday (${await snoozeSheet.locator('.snooze-at').nth(3).textContent()})`)
      check(await snoozeSheet.getByText('It moves to Parked and snoozed on every device and comes back on its own. The agent keeps running.').isVisible(), `${label}: the sheet says what a snooze does`)
      await snoozeSheet.getByRole('switch', { name: "Tell me when it's back" }).click()
      await page.screenshot({ path: path.join(shots, 'organize-snooze-1440-light.png') })
      await snoozeSheet.getByRole('button', { name: /For an hour/ }).click()
      check(await until(() => patches().length === 2), `${label}: Snooze asks the hub`)
      const until1h = patches()[1]?.body?.snoozedUntil
      check(Math.abs(until1h - (Date.now() + 3600_000)) < 60_000, `${label}: snoozed for an hour (${until1h})`)
      check(patches()[1]?.body?.snoozeNotice === true, `${label}: and told when it's back (${JSON.stringify(patches()[1]?.body)})`)
      await snoozeSheet.waitFor({ state: 'detached' })
      check(await until(async () => (await heads()).join(',') === 'Pinned,Sessions,Snoozed'), `${label}: a folded Snoozed section (${await heads()})`)
      check((await list.locator('.side-section', { hasText: 'Snoozed' }).locator('.side-head').getAttribute('aria-expanded')) === 'false', `${label}: Snoozed starts folded`)
      const toast = page.locator('.toast', { hasText: 'Snoozed until' })
      await toast.waitFor()
      await toast.getByRole('button', { name: 'Undo' }).click()
      check(await until(() => patches().length === 3 && patches()[2]?.body?.snoozedUntil === null), `${label}: Undo ends the snooze (${JSON.stringify(patches()[2]?.body)})`)
      check(await until(async () => (await heads()).join(',') === 'Pinned,Sessions'), `${label}: back in Sessions`)

      // park, with Undo offered, and the Overview's folded section
      await row('Tidy the billing API types').locator('.side-link').click({ button: 'right' })
      await page.locator('.menu .menu-item', { hasText: 'Park' }).click()
      await page.locator('.toast', { hasText: 'Parked “Tidy the billing API types”' }).waitFor()
      check(await until(async () => (await page.locator('.set-aside .group-count').textContent()) === '1'), `${label}: Parked and snoozed on the Overview`)

      // a new tag from Tag as
      await row('Migrate auth to passkeys').locator('.side-link').click({ button: 'right' })
      await page.locator('.menu .menu-item', { hasText: 'Tag as' }).click()
      await page.locator('.menu-sub .menu-item', { hasText: 'New tag…' }).click()
      const tagSheet = page.getByRole('dialog', { name: 'New tag' })
      await tagSheet.waitFor()
      await tagSheet.getByRole('textbox').fill('#Review')
      await page.keyboard.press('Enter')
      check(await until(() => JSON.stringify(patches().at(-1)?.body) === '{"tags":["review"]}'), `${label}: the tag, as the hub keeps it (${JSON.stringify(patches().at(-1)?.body)})`)
      check(await until(async () => (await row('Migrate auth to passkeys').locator('.side-tag').textContent()) === '#review'), `${label}: the row shows its tag`)
      // the tag is offered, ticked, next time
      await row('Migrate auth to passkeys').locator('.side-link').click({ button: 'right' })
      await page.locator('.menu .menu-item', { hasText: 'Tag as' }).click()
      check((await page.locator('.menu-sub [role=menuitemcheckbox][aria-checked=true]').textContent())?.includes('#review'), `${label}: its tag is ticked`)
      await closeMenu(page)

      // a note from More
      await row('Migrate auth to passkeys').locator('.side-link').click({ button: 'right' })
      await page.locator('.menu .menu-item', { hasText: 'More' }).click()
      await page.locator('.menu-sub .menu-item', { hasText: 'Note…' }).click()
      const noteSheet = page.getByRole('dialog', { name: 'Note' })
      await noteSheet.locator('textarea').fill('Ask about the passkey fallback')
      await noteSheet.getByRole('button', { name: 'Save' }).click()
      check(await until(() => patches().at(-1)?.body?.note === 'Ask about the passkey fallback'), `${label}: the note goes to the hub`)
      check(await until(async () => (await row('Migrate auth to passkeys').locator('.side-note').count()) === 1), `${label}: the row shows it has a note`)

      // rename
      await row('Write release notes').locator('.side-link').click({ button: 'right' })
      await page.locator('.menu .menu-item', { hasText: 'Rename…' }).click()
      const renameSheet = page.getByRole('dialog', { name: 'Rename' })
      await renameSheet.getByRole('textbox').fill('Docs pass')
      await page.keyboard.press('Enter')
      check(await until(() => state.calls.some((c) => c.method === 'PUT' && c.path === '/api/hosts/build-box/panes/13/name' && c.body?.name === 'Docs pass')), `${label}: Rename names the pane`)
      check(await until(async () => (await row('Docs pass').count()) === 1), `${label}: the row takes the new name`)
    } else {
      // dark: a few marks straight from the hub, for the screenshot
      organize('build-box', '%13', { pinned: true })
      organize('local', '%12', { tags: ['review'], note: 'Ask about the passkey fallback' })
      organize('build-box', '%14', { parked: true })
      check(await until(async () => (await heads()).join(',') === 'Pinned,Sessions,Parked'), `${label}: sections from the stream (${await heads()})`)
    }

    // pick two with Cmd/Ctrl-click: the selection bar, and the bulk menu on a picked row
    const before = patches().length
    await row('Fix flaky checkout test').locator('.side-link').click({ modifiers: [mod] })
    await row('Migrate auth to passkeys').locator('.side-link').click({ modifiers: [mod] })
    check(page.url() === `${base}/next/`, `${label}: Cmd/Ctrl-click picks rather than opens (${page.url()})`)
    const bar = page.getByRole('toolbar', { name: 'Selected sessions' })
    await bar.waitFor()
    check((await bar.locator('.select-count').textContent()) === '2 selected', `${label}: the bar counts the picked sessions`)
    check((await list.locator('.side-row-picked').count()) === 2, `${label}: both rows show as picked`)
    check((await page.locator('.card-picked').count()) === 2, `${label}: and so do their cards`)
    await page.screenshot({ path: path.join(shots, `organize-1440-${scheme}.png`) })
    await layout(page, label)
    // a screen reader hears which ones are picked, on the row's link and on the card's
    check((await list.getByRole('link', { name: /Fix flaky checkout test.*, selected$/ }).count()) === 1, `${label}: a picked row's link says so (${await row('Fix flaky checkout test').locator('.side-link').ariaSnapshot()})`)
    check((await page.getByRole('link', { name: 'Fix flaky checkout test, selected', exact: true }).count()) === 1, `${label}: and so does its card's`)
    // Esc closes a menu without letting go of the selection
    await row('Migrate auth to passkeys').locator('.side-link').click({ button: 'right' })
    await page.getByRole('menu').first().waitFor()
    await page.keyboard.press('Escape')
    check(await until(async () => (await page.locator('.menu').count()) === 0 && (await bar.count()) === 1), `${label}: Esc closes the menu and keeps the selection`)
    await row('Migrate auth to passkeys').locator('.side-link').click({ button: 'right' })
    check((await menuItems(page)).join('|') === '2 sessions selected|Pin selected|Park selected|Snooze selected…|Tag selected as|Clear selection', `${label}: the bulk menu (${await menuItems(page)})`)
    await page.locator('.menu .menu-item', { hasText: 'Park selected' }).click()
    check(await until(() => patches().length === before + 2 && patches().slice(-2).every((c) => c.body?.parked === true)), `${label}: both parked (${JSON.stringify(patches().slice(before))})`)
    await page.locator('.toast', { hasText: 'Parked 2 sessions' }).waitFor()
    check(await until(async () => (await bar.count()) === 0), `${label}: a bulk action lets go of the selection`)

    if (scheme === 'light') {
      // Shift-click picks a range of cards on the Overview; Esc lets go
      await page.locator('.set-aside .group-head').click()
      const cards = page.locator('.card')
      await cards.nth(0).locator('.card-link').click({ modifiers: [mod] })
      await cards.nth(2).locator('.card-link').click({ modifiers: ['Shift'] })
      check(await until(async () => (await page.locator('.select-count').textContent()) === '3 selected'), `${label}: Shift-click picks the cards between (${await page.locator('.select-count').textContent()})`)
      await page.keyboard.press('Escape')
      check(await until(async () => (await page.locator('.select-bar').count()) === 0), `${label}: Esc lets go`)

      // two quick tags on one session while the hub is slow to answer: the second waits for the
      // first, so neither is lost
      organize('local', '%11', { tags: ['alpha', 'beta'] })
      organize('build-box', '%14', { pinned: false, parked: false, snoozedUntil: null, tags: null })
      await page.waitForTimeout(150)
      state.slow = 500
      for (const t of ['#alpha', '#beta']) {
        await row('Tidy the billing API types').locator('.side-link').click({ button: 'right' })
        await page.locator('.menu .menu-item', { hasText: 'Tag as' }).click()
        await page.locator('.menu-sub .menu-item', { hasText: t }).click()
      }
      const tags = () => state.org.sessions.find((m) => m.host === 'build-box' && m.pane === '%14')?.tags?.join(',')
      check(await until(() => tags() === 'alpha,beta'), `${label}: both tags stay (${tags()})`)
      state.slow = 0
    }
    await ctx.close()
  }

  // ---- phone: the long-press menu as pages, picking by tap, the bar over the tab bar ----
  for (const scheme of ['light', 'dark'] as const) {
    reset()
    const ctx = await browser.newContext({ ...phone, colorScheme: scheme })
    const page = await ctx.newPage()
    watch(page)
    await page.goto(`${base}/next/`)
    await page.locator('.card').nth(3).waitFor()
    await styled(page)
    const label = `phone ${scheme}`
    const card = (title: string) => page.locator('.card', { hasText: title })
    const cdp = await ctx.newCDPSession(page)
    const hold = async (title: string) => {
      await card(title).scrollIntoViewIfNeeded()
      const box = (await card(title).boundingBox())!
      const pt = { x: box.x + box.width / 2, y: box.y + 40 }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] })
      await page.waitForTimeout(700)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.getByRole('menu').first().waitFor({ timeout: 5000 }).catch(async (e) => {
        await page.screenshot({ path: path.join(shots, 'organize-hold-failed.png') })
        throw new Error(`no menu after a long press at ${JSON.stringify(pt)}: ${e}`)
      })
    }
    await hold('Write release notes')
    check((await menuItems(page)).includes('Select'), `${label}: the long-press menu (${await menuItems(page)})`)
    // a submenu takes the menu's place, with a way back
    await page.locator('.menu .menu-item', { hasText: 'Copy' }).tap()
    await page.locator('.menu-back').waitFor()
    check((await page.locator('.menu').count()) === 1, `${label}: one menu at a time on a phone`)
    // the Back row counts when it's placed: the last row stays on the screen
    const lastRow = (await page.locator('.menu-sub .menu-item').last().boundingBox())!
    check(lastRow.y + lastRow.height <= 844 - 8, `${label}: the submenu's last row is on the screen (${JSON.stringify(lastRow)})`)
    if (scheme === 'light') {
      await page.screenshot({ path: path.join(shots, 'organize-submenu-390-light.png') })
      // ← goes back, and the keys still work: the focus is on the item the submenu came from
      await page.keyboard.press('ArrowLeft')
      check(await until(async () => (await page.evaluate(() => document.activeElement?.textContent ?? '')).includes('Copy')), `${label}: ← puts the focus back on Copy (${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))})`)
    } else {
      await page.locator('.menu-back').tap()
    }
    await page.locator('.menu .menu-item', { hasText: 'Select' }).tap()
    const bar = page.getByRole('toolbar', { name: 'Selected sessions' })
    await bar.waitFor()
    // a tap while picking adds the card rather than opening it
    await card('Fix flaky checkout test').locator('.card-link').tap()
    check(await until(async () => (await page.locator('.card-picked').count()) === 2), `${label}: a tap picks another card`)
    check(page.url() === `${base}/next/`, `${label}: and doesn't open it`)
    const barBox = (await bar.boundingBox())!
    const tabs = (await page.locator('.tabbar').boundingBox())!
    check(barBox.y + barBox.height <= tabs.y, `${label}: the bar sits above the tab bar`)
    await page.screenshot({ path: path.join(shots, `organize-390-${scheme}.png`) })
    await layout(page, label)
    if (scheme === 'light') {
      // the narrowest phones: the whole bar, clear button and all, stays on the screen
      await page.setViewportSize({ width: 320, height: 640 })
      await page.waitForTimeout(100)
      const b = (await bar.boundingBox())!
      const clear = (await bar.getByRole('button', { name: 'Clear selection' }).boundingBox())!
      check(b.x >= 0 && b.x + b.width <= 320 && clear.x + clear.width <= 320, `${label}: the bar fits at 320px (${JSON.stringify(b)})`)
      const wide = await page.locator('.card').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().right > window.innerWidth).length)
      check(wide === 0, `${label}: and so do the cards (${wide} wider)`)
      await page.screenshot({ path: path.join(shots, 'organize-320-light.png') })
      await page.setViewportSize({ width: 390, height: 844 })
    }
    await bar.getByRole('button', { name: 'Pin' }).tap()
    check(await until(() => patches().length === 2 && patches().every((c) => c.body?.pinned === true)), `${label}: Pin on the bar pins both (${JSON.stringify(patches())})`)
    check(await until(async () => (await page.locator('.pinned .card').count()) === 2), `${label}: both under Pinned`)
    await ctx.close()
  }
} catch (e) {
  await capture(browser, shots, 'organize')
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
console.log(`ok: organising sessions at 1440x900 and 390x844 in light and dark: sections, the session menu and its submenus by mouse, keys and touch, pin, snooze and park with Undo, tags, notes, rename, Cmd/Ctrl- and Shift-click, the bulk menu and the selection bar; screenshots in ${shots}`)
