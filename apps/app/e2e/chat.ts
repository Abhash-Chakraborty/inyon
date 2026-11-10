// bun apps/app/e2e/chat.ts — what a session's chat says when there's no conversation to show, in
// the built app (apps/app/dist, from build.sh) behind a stand-in hub fed made-up data (demo.ts): an
// agent that exited (resume it, start another, or the terminal), an agent Inyon reads only in its
// terminal, why the last turn stopped, a long conversation still loading, a machine that drops (a
// question kept with its buttons, reconnecting, then offline), a message sent again once the
// connection is back, and coming back after five minutes. Screenshots go to $SHOTS (default: a
// temp folder). CHROME=/path/to/chrome uses a browser other than Playwright's own.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, devices, type Page } from 'playwright'
import type { ServerWebSocket } from 'bun'
import { accounts, info, overview, storefront } from './demo.ts'
import { capture } from './failure.ts'

const root = path.join(import.meta.dir, '../../..')
const dist = path.join(import.meta.dir, '../dist')
const CATALOG: Record<string, { models: unknown[] }> = await Bun.file(path.join(root, 'crates/inyon-protocol/src/agents.json')).json()
const web = path.join(root, 'apps/web/public')
const shots = process.env.SHOTS ?? path.join(tmpdir(), 'inyon-app-shots')
mkdirSync(shots, { recursive: true })

const rs = await Bun.file(path.join(root, 'crates/inyon-hub/src/static_files.rs')).text()
const NEXT_CSP = /pub const NEXT_CSP: &str =\s*"([^"]+)"/.exec(rs)![1]!

type Obj = Record<string, unknown>
type Socket = ServerWebSocket<{ subs: Set<string> }>
const sockets = new Set<Socket>()
const state = { starts: [] as Obj[], startFails: false, sends: [] as Obj[], sendDown: false, sendFailures: 0 }

// the machines: the demo's, with three more sessions on studio and docs run by Cursor CLI
type Host = { config: { id: string; name: string }; status: string; sessions: Obj[] } & Obj
let hosts: Host[] = []
const now = Date.now()
const pane = (id: string, title: string, agent: Obj) => ({ id, index: 0, active: true, command: 'claude', cwd: '/home/sam/code/storefront', title, width: 80, height: 40, dead: false, agent: { pid: 5000, startedAt: now - 3600_000, mappedBy: 'hook', ...agent } })
const session = (n: number, name: string, p: Obj) => ({ id: `$${n}`, name, attached: 0, windows: [{ id: `@${n}`, index: 1, name, active: true, activity: Math.floor(now / 1000) - 60, panes: [p] }] })
function resetHosts() {
  hosts = overview(now).hosts as unknown as Host[]
  const studio = hosts[0]!
  studio.sessions.push(
    session(21, 'search', pane('%21', 'Speed up search', { kind: 'claude', state: 'idle', failure: { error: 'rate_limit', resetsAt: Math.floor(now / 1000) + 3600 } })),
    session(22, 'archive', pane('%22', 'Read the archive', { kind: 'claude', state: 'idle' })),
    // a shell with no agent, and an empty chat whose agent stopped on a rate limit
    session(23, 'logs', { ...pane('%23', 'Shell', {}), agent: undefined }),
    session(24, 'notes', pane('%24', 'Tidy the notes', { kind: 'claude', state: 'idle', failure: { error: 'rate_limit', resetsAt: Math.floor(now / 1000) + 3600 } })),
  )
  const docs = (hosts[1]!.sessions[0] as { windows: { panes: { agent: Obj }[] }[] }).windows[0]!.panes[0]!
  docs.agent = { ...docs.agent, kind: 'cursor' }
}

// the chats, as /ws2 streams
type Stream = { seq: number; items: Obj[]; state: Obj }
const streams = new Map<string, Stream>()
function resetChats() {
  streams.clear()
  // the agent exited, with a conversation to resume
  const s = storefront(now)
  streams.set('local:%11', { seq: 1, items: s.items, state: { ...s.state, info: { ...s.state.info, running: false, sessionId: 'c0ffee' }, screen: { working: false, width: 120 }, hasMore: false } })
  const a = accounts(now)
  streams.set('local:%12', { seq: 1, items: a.items, state: a.state })
  // a shell where nothing ran yet
  streams.set('build-box:%14', { seq: 1, items: [], state: { info: info('build-box', '%14', 'opencode', { running: false }), loaded: true, hasMore: false } })
  // stopped on a rate limit
  streams.set('local:%21', { seq: 1, items: s.items.slice(-6), state: { info: info('local', '%21', 'claude', { title: 'Speed up search' }), screen: { working: false, width: 120, model: 'Sonnet 5.5' }, loaded: true, hasMore: false } })
  streams.set('local:%23', { seq: 1, items: [], state: { info: info('local', '%23', 'claude', { running: false }), loaded: true, hasMore: false } })
  streams.set('local:%24', { seq: 1, items: [], state: { info: info('local', '%24', 'claude', { running: false, title: 'Tidy the notes' }), loaded: true, hasMore: false } })
  // a long record the hub is still reading
  streams.set('local:%22', { seq: 1, items: [], state: { loaded: false, progress: { done: 42, total: 100 } } })
}
resetHosts()
resetChats()
const EPOCH = 1
let overviewSeq = 1

function snapshot(stream: string) {
  if (stream === 'overview') return { t: 'snapshot', stream, epoch: EPOCH, seq: overviewSeq, rows: { hosts } }
  const c = streams.get(stream)
  if (!c) return { t: 'snapshot', stream, epoch: EPOCH, seq: 1, rows: { items: [] }, state: { loaded: true, hasMore: false } }
  return { t: 'snapshot', stream, epoch: EPOCH, seq: c.seq, rows: { items: c.items, live: [], queue: [] }, state: c.state }
}

function send(stream: string, frame: Obj) {
  const text = JSON.stringify(frame)
  for (const ws of sockets) if (ws.data.subs.has(stream)) ws.send(text)
}

/** A change to a chat, to every socket that follows it. */
function change(stream: string, parts: { append?: Obj[]; state?: Obj }) {
  const c = streams.get(stream)!
  const from = c.seq++
  if (parts.append) c.items.push(...parts.append)
  if (parts.state) Object.assign(c.state, parts.state)
  send(stream, { t: 'delta', stream, epoch: EPOCH, from, seq: c.seq, ...(parts.append ? { append: { items: parts.append } } : {}), ...(parts.state ? { state: parts.state } : {}) })
}

/** A machine changed. */
function machine(id: string, f: (h: Host) => void) {
  const h = hosts.find((x) => x.config.id === id)!
  f(h)
  const from = overviewSeq++
  send('overview', { t: 'delta', stream: 'overview', epoch: EPOCH, from, seq: overviewSeq, replace: { hosts: [h] } })
}

const server = Bun.serve({
  port: 0,
  async fetch(req, srv) {
    const url = new URL(req.url)
    const p = url.pathname
    const json = (body: unknown, status = 200) => Response.json(body, { status })
    if (p === '/ws2') return srv.upgrade(req, { data: { subs: new Set<string>() } }) ? undefined : new Response('no upgrade', { status: 400 })
    if (p === '/api/session') return json({ authed: true, setup: false, setupCode: false })
    // the model chip's catalog, for the agents that report one
    const models = /^\/api\/hosts\/([^/]+)\/panes\/([^/]+)\/models$/.exec(p)
    if (models) {
      const agent = (streams.get(`${decodeURIComponent(models[1]!)}:%${models[2]}`)?.state.info as { agent?: string } | undefined)?.agent ?? 'claude'
      return json({ models: CATALOG[agent]?.models ?? [], source: 'fallback', updatedAt: Date.now() })
    }
    const action = /^\/api\/hosts\/([^/]+)\/panes\/([^/]+)\/(start|send)$/.exec(p)
    if (action && req.method === 'POST') {
      const host = decodeURIComponent(action[1]!)
      const body = (await req.json()) as Obj
      if (action[3] === 'start') {
        state.starts.push({ pane: action[2], ...body })
        return state.startFails ? json({ error: 'tmux could not type into the pane' }, 409) : json({ ok: true })
      }
      if (state.sendDown) return json({ error: 'The machine is not answering' }, 503)
      if (state.sendFailures > 0) {
        state.sendFailures--
        return json({ error: 'The machine is not answering' }, 503)
      }
      state.sends.push({ host, pane: action[2], ...body })
      const stream = `${host}:%${action[2]}`
      setTimeout(() => change(stream, { append: [{ kind: 'user', seq: 2000 + state.sends.length, uuid: `sent${state.sends.length}`, ts: new Date().toISOString(), text: body.text, images: 0 }] }), 300)
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
      if (msg.t === 'hello') ws.send(JSON.stringify({ t: 'hello', v: 2 }))
      if (msg.t === 'sub') {
        ws.data.subs.add(msg.stream)
        ws.send(JSON.stringify(snapshot(msg.stream)))
      }
      if (msg.t === 'unsub') ws.data.subs.delete(msg.stream)
      if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }))
    },
  },
})
const base = `http://127.0.0.1:${server.port}`

const problems: string[] = []
const check = (ok: unknown, what: string) => {
  if (!ok) problems.push(what)
}
async function until(ok: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms
  while (!(await ok()) && Date.now() < end) await Bun.sleep(50)
  return ok()
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

/** The page out of sight for `ms`, then back (another tab, the phone in a pocket). */
async function away(page: Page, ms: number) {
  await page.evaluate((ms) => {
    const w = window as unknown as { __skew?: number; __now?: () => number }
    if (w.__skew === undefined) {
      const real = Date.now.bind(Date)
      w.__skew = 0
      Date.now = () => real() + (w.__skew ?? 0)
    }
    const show = (state: string) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    }
    show('hidden')
    w.__skew += ms
    show('visible')
  }, ms)
}

const atBottom = (page: Page) => page.locator('#chat-scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4)

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
const errors: string[] = []
async function open(w: number, h: number, scheme: 'light' | 'dark') {
  const phone = w < 600
  const ctx = await browser.newContext({ ...(phone ? devices['iPhone 13'] : {}), viewport: { width: w, height: h }, colorScheme: scheme, reducedMotion: 'reduce' })
  await ctx.addInitScript(() => {
    try {
      sessionStorage.setItem('inyon.intro.seen', '1')
    } catch {}
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  return { ctx, page }
}

try {
  // ---- each state at both sizes, light and dark ----
  for (const [w, h] of [[390, 844], [1440, 900]] as const)
    for (const scheme of ['light', 'dark'] as const) {
      const label = `${w} ${scheme}`
      const { ctx, page } = await open(w, h, scheme)

      // the agent exited: a card under the conversation offers the way back
      await page.goto(`${base}/next/m/local/p/11`)
      const card = page.locator('.not-running-card')
      await card.waitFor()
      check(await card.getByText('No agent is running in this pane').isVisible(), `${label}: the ended chat says nothing runs`)
      for (const name of ['Resume conversation', 'Start Claude Code', 'Start Codex', 'Start OpenCode']) check(await card.getByRole('button', { name }).isVisible(), `${label}: ${name}`)
      check((await card.getByRole('link', { name: 'Terminal' }).getAttribute('href')) === '/next/m/local/p/11?view=terminal', `${label}: Terminal opens the pane's terminal`)
      check(!(await page.locator('.composer').count()), `${label}: no message box while nothing runs`)
      await card.scrollIntoViewIfNeeded()
      await layout(page, `${label} ended`)
      await page.screenshot({ path: path.join(shots, `chat-${w}-${scheme}-ended.png`) })

      // a shell where nothing ran: the same choices in place of the conversation, no Resume
      await page.goto(`${base}/next/m/build-box/p/14?view=chat`)
      const empty = page.locator('.not-running').first()
      await empty.waitFor()
      check(!(await page.locator('.not-running-card').count()), `${label}: an empty pane shows the full version`)
      check(!(await empty.getByRole('button', { name: 'Resume conversation' }).count()), `${label}: nothing to resume`)
      check((await empty.getByRole('button', { name: /^Start / }).count()) === 3, `${label}: one Start per installed agent`)

      // an agent Inyon reads only in its terminal
      await page.goto(`${base}/next/m/build-box/p/13?view=chat`)
      await page.getByText('Cursor CLI runs in the terminal').waitFor()
      check((await page.getByRole('link', { name: 'Open terminal' }).getAttribute('href')) === '/next/m/build-box/p/13', `${label}: Open terminal goes to its terminal`)
      check(await page.getByText("Inyon doesn't read Cursor CLI's conversation files yet").isVisible(), `${label}: why the chat is empty`)
      check(!(await page.locator('.composer').count()), `${label}: no message box for a terminal-first agent`)
      await layout(page, `${label} terminal-first`)
      await page.screenshot({ path: path.join(shots, `chat-${w}-${scheme}-terminal-first.png`) })

      // the last turn stopped on a rate limit
      await page.goto(`${base}/next/m/local/p/21`)
      const failure = page.locator('.chat-failure')
      await failure.waitFor()
      check(/^Stopped: rate limit · resets \d{1,2}:\d\d$/.test((await failure.textContent()) ?? ''), `${label}: the failure line (${await failure.textContent()})`)
      check(await failure.locator('.dot-danger').isVisible(), `${label}: a red dot`)
      await page.screenshot({ path: path.join(shots, `chat-${w}-${scheme}-failure.png`) })

      // a long record still being read
      await page.goto(`${base}/next/m/local/p/22`)
      await page.getByText('Loading the conversation · 42%').waitFor()
      await page.screenshot({ path: path.join(shots, `chat-${w}-${scheme}-loading.png`) })
      await ctx.close()
    }

  // ---- starting an agent ----
  {
    const { ctx, page } = await open(390, 844, 'light')
    await page.goto(`${base}/next/m/local/p/11`)
    const card = page.locator('.not-running-card')
    await card.getByRole('button', { name: 'Start Codex' }).click()
    // the stand-in's overview already lists an agent in this pane, so the start is over at once; the
    // wait for a pane that isn't running yet has its own check below
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.not-running-card button')?.disabled, null, { timeout: 5000 })
    check(JSON.stringify(state.starts.at(-1)) === JSON.stringify({ pane: '11', agent: 'codex' }), `start: ${JSON.stringify(state.starts.at(-1))}`)
    await card.getByRole('button', { name: 'Resume conversation' }).click()
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.not-running-card button')?.disabled, null, { timeout: 5000 })
    check(JSON.stringify(state.starts.at(-1)) === JSON.stringify({ pane: '11', agent: 'claude', resume: 'c0ffee' }), `resume: ${JSON.stringify(state.starts.at(-1))}`)
    state.startFails = true
    await card.getByRole('button', { name: 'Start OpenCode' }).click()
    await page.getByText('Could not start').waitFor()
    check(await page.getByText('tmux could not type into the pane').isVisible(), 'start: the toast says why')
    state.startFails = false
    await ctx.close()
  }

  // ---- the machine drops: the question stays, reconnecting, then offline ----
  {
    const { ctx, page } = await open(390, 844, 'light')
    // the overview first, which notes what each session asks, then the session in place
    await page.goto(`${base}/next/`)
    await page.locator('a.card-link[href="/next/m/local/p/12"]').click()
    await page.getByText('Would you like to run the following command?').waitFor()
    machine('local', (h) => {
      h.status = 'error'
    })
    // the hub's copy of the screen is gone with the machine
    change('local:%12', { state: { screen: { working: false, width: 120 } } })
    await page.getByText('Reconnecting to studio…').waitFor()
    check(await page.getByText('Run bun test src/auth?').isVisible(), 'offline: the question seen on the overview stays')
    check(await page.getByRole('option', { name: /Yes/ }).first().isDisabled(), 'offline: its buttons wait for the machine')
    await page.screenshot({ path: path.join(shots, 'chat-390-light-reconnecting.png') })
    await page.getByText('studio is offline. This is the conversation as last seen; you can send again once it reconnects.').waitFor({ timeout: 20_000 })
    await layout(page, 'offline')
    await page.screenshot({ path: path.join(shots, 'chat-390-light-offline.png') })
    await page.locator('.chat-status').getByRole('button', { name: "Can't connect?" }).click()
    await page.getByRole('dialog', { name: "Can't connect?" }).waitFor()
    await page.keyboard.press('Escape')
    // back, and no longer asking: the question goes and the box returns
    machine('local', (h) => {
      h.status = 'online'
      const p = (h.sessions[1] as { windows: { panes: { agent: Obj }[] }[] }).windows[0]!.panes[0]!
      p.agent = { ...p.agent, state: 'idle', waitingFor: undefined, options: undefined }
    })
    await page.locator('.composer').waitFor()
    check(!(await page.getByText('Run bun test src/auth?').count()), 'online: the kept question goes once the machine is back')
    await ctx.close()
  }

  // ---- a message that failed with the connection goes again once it's back ----
  {
    const { ctx, page } = await open(390, 844, 'light')
    await page.goto(`${base}/next/m/local/p/21`)
    const box = page.getByRole('textbox', { name: 'Message Claude Code' })
    await box.waitFor()
    state.sendDown = true
    await box.fill('Try the index on the title column')
    // on a phone Enter is a new line; the button sends
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    // three tries over about eight seconds, then it waits
    await page.locator('.msg-retry').waitFor({ timeout: 15_000 })
    check(!state.sends.length, 'resend: nothing arrived while the machine was down')
    state.sendDown = false
    for (const ws of sockets) ws.close()
    await page.waitForFunction(() => !document.querySelector('.msg-retry'), null, { timeout: 15_000 })
    await page.waitForTimeout(800)
    check(state.sends.length === 1 && (state.sends[0] as { text?: string }).text === 'Try the index on the title column', `resend: sent once after reconnecting (${JSON.stringify(state.sends)})`)
    check((await page.locator('.bubble').filter({ hasText: 'Try the index on the title column' }).count()) === 1, 'resend: the message shows once')
    await ctx.close()
  }

  // ---- a send whose failure lands after the connection came back goes again by itself ----
  {
    state.sends = []
    const { ctx, page } = await open(390, 844, 'light')
    await page.goto(`${base}/next/m/local/p/21`)
    const box = page.getByRole('textbox', { name: 'Message Claude Code' })
    await box.waitFor()
    // the send's four tries all fail, over about eight seconds; the connection drops and comes back
    // in the middle of them
    state.sendFailures = 4
    await box.fill('Cache the search results')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.waitForTimeout(1000)
    for (const ws of sockets) ws.close()
    check(await until(() => state.sends.length === 1, 20_000), `spanned: sent again by itself (${JSON.stringify(state.sends)})`)
    await page.waitForTimeout(800)
    check(!(await page.locator('.msg-retry').count()), 'spanned: no Retry left to tap')
    check((await page.locator('.bubble').filter({ hasText: 'Cache the search results' }).count()) === 1, 'spanned: the message shows once')
    state.sendFailures = 0
    await ctx.close()
  }

  // ---- a start holds every button until the pane runs; nothing starts while the machine is away ----
  {
    const { ctx, page } = await open(390, 844, 'light')
    await page.goto(`${base}/next/m/local/p/23?view=chat`)
    const card = page.locator('.not-running').first()
    await card.getByRole('button', { name: 'Start Codex' }).waitFor()
    const n = state.starts.length
    await card.getByRole('button', { name: 'Start Codex' }).click()
    check(await until(() => state.starts.length === n + 1), 'guard: the start goes out')
    await page.waitForTimeout(3000)
    check(await card.getByRole('button', { name: 'Start Claude Code' }).isDisabled(), 'guard: three seconds on, the pane not running yet, the buttons still wait')
    await card.getByRole('button', { name: 'Start Codex' }).click({ force: true })
    await page.waitForTimeout(500)
    check(state.starts.length === n + 1, `guard: a second tap types nothing (${state.starts.length - n} starts)`)
    // the pane says an agent runs: the start is over
    machine('local', (h) => {
      const p = (h.sessions.find((x) => x.id === '$23') as { windows: { panes: { agent?: Obj }[] }[] }).windows[0]!.panes[0]!
      p.agent = { kind: 'codex', state: 'idle', pid: 7, startedAt: now, mappedBy: 'hook' }
    })
    check(await until(async () => !(await card.getByRole('button', { name: 'Start Claude Code' }).isDisabled())), 'guard: free again once the pane runs')
    // the machine drops: nothing can start until it's back
    machine('local', (h) => (h.status = 'error'))
    check(await until(async () => await card.getByRole('button', { name: 'Start Claude Code' }).isDisabled()), 'offline: Start waits for the machine')
    machine('local', (h) => (h.status = 'online'))
    check(await until(async () => !(await card.getByRole('button', { name: 'Start Claude Code' }).isDisabled())), 'offline: and works once it is back')
    resetHosts()
    await ctx.close()
  }

  // ---- an empty chat whose agent stopped says why, over the way back ----
  {
    const { ctx, page } = await open(390, 844, 'light')
    await page.goto(`${base}/next/m/local/p/24`)
    const failure = page.locator('.chat-failure')
    await failure.waitFor()
    check(/^Stopped: rate limit/.test((await failure.textContent()) ?? ''), `stopped empty: the failure line (${await failure.textContent()})`)
    check(await page.locator('.not-running').first().isVisible(), 'stopped empty: and the way back under it')
    await ctx.close()
  }

  // ---- opening a session takes its pushed notification away too ----
  {
    const { ctx, page } = await open(390, 844, 'light')
    // the service worker's notifications, as the page sees them
    await ctx.addInitScript(() => {
      const w = window as unknown as { closedTags: string[] }
      w.closedTags = []
      const reg = { getNotifications: async (o?: { tag?: string }) => [{ close: () => w.closedTags.push(o?.tag ?? '') }] }
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => reg, register: async () => reg, ready: Promise.resolve(reg), addEventListener() {} } })
    })
    await page.goto(`${base}/next/m/local/p/21`)
    await page.getByRole('textbox', { name: 'Message Claude Code' }).waitFor()
    check(await until(async () => ((await page.evaluate(() => (window as unknown as { closedTags: string[] }).closedTags)) ?? []).includes('local:%21')), `push: the session's notification closes (${await page.evaluate(() => (window as unknown as { closedTags: string[] }).closedTags)})`)
    await ctx.close()
  }

  // ---- back after five minutes ----
  {
    resetChats()
    streams.get('local:%11')!.state.info = { ...(streams.get('local:%11')!.state.info as Obj), running: true }
    const { ctx, page } = await open(390, 844, 'light')
    await page.goto(`${base}/next/m/local/p/11`)
    await page.getByText('All 20 runs pass now.').waitFor()
    await page.waitForTimeout(400)
    await page.mouse.move(195, 400)
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -1200)
    await page.waitForTimeout(400)
    check(!(await atBottom(page)), 'back: scrolled up to read')
    await away(page, 60_000)
    await page.waitForTimeout(400)
    check(!(await atBottom(page)), 'back: a minute away keeps the place')
    await away(page, 6 * 60_000)
    // six minutes on the clock also reads as a dead socket, so it reconnects meanwhile (as a phone
    // back from a pocket does) and the reconnecting line comes and goes: wait for the end to stay
    const bottom = () =>
      page
        .waitForFunction(() => {
          const el = document.getElementById('chat-scroll')
          return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 4
        }, null, { timeout: 8000 })
        .then(() => true, () => false)
    await bottom()
    await page.waitForTimeout(1500)
    const where = await page.locator('#chat-scroll').evaluate((el) => `${el.scrollTop}+${el.clientHeight} of ${el.scrollHeight}`)
    check(await bottom(), `back: six minutes away opens at the latest (${where})`)
    await page.screenshot({ path: path.join(shots, 'chat-390-light-back.png') })
    await ctx.close()
  }
} catch (e) {
  await capture(browser, shots, 'chat')
  throw e
} finally {
  await browser.close()
  server.stop(true)
}

const unexpected = errors.filter((e) => !/WebSocket|503|409|Service Unavailable|Conflict/.test(e))
check(!unexpected.length, `errors in the page: ${unexpected.join(' | ')}`)
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`ok: the ended chat, an empty shell, a terminal-first agent, the failure line and loading at 390x844 and 1440x900 in light and dark, starting and resuming, a machine dropping with its question kept, a resend after reconnecting, and coming back after five minutes; screenshots in ${shots}`)
