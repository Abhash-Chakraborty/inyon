// bun apps/app/e2e/names.ts — a session's names and history, and its header, in the built app
// (apps/app/dist) behind the stand-in hub (hub.ts), at phone and desktop sizes in light and dark:
// the title renames the session (or a plain terminal), the ⋯ menu's Past conversations…, Rename…,
// Rename tmux session… and Clear conversation (which asks first), a bare "/resume" opening Past
// conversations, the menu trimmed while the agent asks, the Ultracode and Remote Control buttons,
// "isn't signed in" with Sign in, the agent mark's working dot, "Start here:" over a plain shell,
// "This pane is gone", and a tmux session's own menu on a machine's page.
// Screenshots go to $SHOTS (default: a temp folder). CHROME=/path/to/chrome picks the browser.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from 'playwright'
import { base, change, check, finish, launch, layout, open, resetChats, SIZES, state, streams, until } from './hub.ts'
import { info as chatInfo, overview } from './demo.ts'

const shots = process.env.SHOTS ?? path.join(tmpdir(), 'inyon-app-shots')
mkdirSync(shots, { recursive: true })
const browser = await launch()
const done = finish(browser)

type Obj = Record<string, unknown>
const now = Date.now()

// the demo's machines, with Claude Code not signed in on studio, a conversation id on the
// storefront session, a plain shell (logs) and a shell whose Claude Code exited (notes)
function hosts() {
  const h = overview(now).hosts as unknown as { config: { id: string }; sessions: Obj[] }[]
  const studio = h[0]! as unknown as Obj & { sessions: Obj[] }
  studio.signedIn = ['codex']
  const store = (studio.sessions[0] as { windows: { panes: { agent: Obj }[] }[] }).windows[0]!.panes[0]!
  store.agent = { ...store.agent, sessionId: 'c0ffee' }
  const shell = (id: string, name: string) => ({
    id: `$${id}`,
    name,
    attached: 0,
    windows: [{ id: `@${id}`, index: 1, name, active: true, activity: Math.floor(now / 1000) - 60, panes: [{ id: `%${id}`, index: 0, active: true, command: 'zsh', cwd: '/home/sam/code/storefront', title: 'studio', width: 80, height: 40, dead: false }] }],
  })
  studio.sessions.push(shell('23', 'logs'), shell('24', 'notes'))
  return h as unknown as Obj[]
}

const asked: { method: string; path: string; body: unknown }[] = []
const calls = (method: string, re: RegExp) => asked.filter((a) => a.method === method && re.test(a.path))
state.routes.push(async (req, url) => {
  const p = url.pathname
  if (!/^\/api\/hosts\/local\/(panes\/\d+\/(conversations|switch|name|start|ultracode|rc)|sessions\/[^/]+\/name|signin(\/\d+)?)$/.test(p)) return
  const body = req.method === 'GET' ? undefined : await req.json().catch(() => undefined)
  asked.push({ method: req.method, path: p + url.search, body })
  if (p.endsWith('/conversations'))
    return Response.json({
      agent: 'claude',
      cwd: '/home/sam/code/storefront',
      conversations: [
        { id: 'c0ffee', title: 'Fix flaky checkout test', at: now - 60_000, current: true },
        { id: 'beef01', title: 'Start the cart refactor', at: now - 3 * 86400_000 },
      ],
    })
  if (p.endsWith('/switch')) return Response.json({ switched: true })
  if (/sessions\/[^/]+\/name$/.test(p)) return Response.json({ name: String((body as Obj)?.name ?? '').replace(/[.:]/g, '_') })
  if (p.endsWith('/signin')) return Response.json({ pane: '%40' })
  if (p.endsWith('/signin/40') && req.method === 'GET') return Response.json({ lines: ['Open this link to sign in:', 'https://auth.example/device'], links: ['https://auth.example/device'] })
  return Response.json({ ok: true })
})

const STREAM = 'local:%11'
function info(extra: Obj) {
  change(STREAM, { state: { info: { ...(streams.get(STREAM)!.state.info as Obj), ...extra } } })
}
function screen(extra: Obj) {
  change(STREAM, { state: { screen: { ...(streams.get(STREAM)!.state.screen as Obj), ...extra } } })
}

const menuItems = (page: Page) => page.locator('.menu').last().locator('.menu-item, .menu-header').allTextContents()
/** The ⋯ menu's labels, without the lead's Session controls… (another change puts it first). */
async function more(page: Page) {
  await page.locator('#session-more').click()
  await page.locator('.menu').waitFor()
  return (await menuItems(page)).filter((l) => l !== 'Session controls…')
}
async function pickMenu(page: Page, label: string) {
  await page.locator('.menu .menu-item', { hasText: label }).first().click()
  await until(async () => (await page.locator('.menu').count()) === 0)
}
async function closeSheet(page: Page, name: string | RegExp) {
  await page.keyboard.press('Escape')
  await until(async () => (await page.getByRole('dialog', { name }).count()) === 0)
}
const toast = (page: Page, title: string) => page.locator('.toast-title', { hasText: title })

try {
  for (const [w, h] of SIZES)
    for (const scheme of ['light', 'dark'] as const) {
      const label = `names ${w}x${h} ${scheme}`
      const phone = w < 600
      resetChats()
      streams.set('local:%24', { seq: 1, items: [], state: { info: chatInfo('local', '%24', 'claude', { running: false }), loaded: true, hasMore: false } })
      state.hosts = hosts()
      Object.assign(state, { sends: [] })
      asked.length = 0
      const { ctx, page } = await open(browser, w, h, scheme)
      await page.goto(`${base}/next/m/local/p/11`)
      await page.getByText('All 20 runs pass now.').waitFor()

      // Claude Code isn't signed in on studio: Sign in opens the sheet
      const banner = page.locator('.signin-banner')
      check(await banner.getByText("Claude Code isn't signed in on studio.").isVisible(), `${label}: the sign-in banner`)
      // the mark holds still while working, with the working dot on its corner (from 640px)
      check((await page.locator('.session-logo .session-logo-dot.dot-working').isVisible()) === !phone, `${label}: the working dot on the mark ${phone ? 'hidden' : 'shown'}`)
      await layout(page, label)
      await page.screenshot({ path: path.join(shots, `names-${w}-${scheme}.png`) })
      await banner.getByRole('button', { name: 'Sign in' }).click()
      await page.getByRole('dialog', { name: 'Sign in to Claude Code' }).waitFor()
      check(await until(() => calls('POST', /\/signin$/).some((c) => (c.body as Obj)?.agent === 'claude')), `${label}: Sign in starts Claude Code's sign-in`)
      await closeSheet(page, 'Sign in to Claude Code')

      // a click on the title renames the session
      await page.locator('.session-title-button').click()
      const rename = page.getByRole('dialog', { name: 'Rename session' })
      await rename.waitFor()
      check(await rename.getByText('Shown in Inyon and kept with the conversation, so it survives a resume.').isVisible(), `${label}: the session's rename hint`)
      await rename.getByRole('textbox').fill('Checkout race')
      if (!phone) await page.screenshot({ path: path.join(shots, `names-rename-${scheme}.png`) })
      await rename.getByRole('button', { name: 'Save' }).click()
      check(await until(() => calls('PUT', /panes\/11\/name$/).some((c) => (c.body as Obj)?.name === 'Checkout race')), `${label}: Save names the pane`)
      await until(async () => (await page.getByRole('dialog', { name: 'Rename session' }).count()) === 0)

      // a bare /resume opens Past conversations instead of reaching the agent
      await page.locator('#composer-input').fill('/resume')
      if (phone) await page.getByRole('button', { name: /^(Send|Queue follow-up)$/ }).click()
      else await page.locator('#composer-input').press('Enter')
      const convos = page.getByRole('dialog', { name: 'Past conversations' })
      await convos.waitFor()
      await convos.getByText('Start the cart refactor').waitFor()
      check(!state.sends.some((s) => (s as Obj).text === '/resume'), `${label}: /resume not sent (${JSON.stringify(state.sends)})`)
      check((await page.locator('#composer-input').inputValue()) === '', `${label}: the box empties`)
      check(calls('GET', /panes\/11\/conversations\?agent=claude$/).length > 0, `${label}: the list asked for Claude Code's`)
      check(await convos.getByText(/^Open now · /).isVisible(), `${label}: the open one says so`)
      await page.screenshot({ path: path.join(shots, `names-conversations-${w}-${scheme}.png`) })
      // the agent works, so switching asks first
      await convos.getByRole('button', { name: /Start the cart refactor/ }).click()
      const ask = page.getByRole('dialog', { name: 'Switch conversation?' })
      await ask.waitFor()
      await ask.getByRole('button', { name: 'Switch' }).click()
      check(await until(() => calls('POST', /panes\/11\/switch$/).some((c) => JSON.stringify(c.body) === '{"agent":"claude","id":"beef01"}')), `${label}: POST /switch (${JSON.stringify(asked)})`)
      check(await until(() => toast(page, 'Conversation switched').isVisible()), `${label}: Conversation switched`)
      await until(async () => (await convos.count()) === 0)

      // the header's switches while they're on
      screen({ ultracode: true })
      info({ rc: { url: 'https://claude.ai/code/abc', ts: new Date().toISOString() } })
      const gauge = page.getByRole('button', { name: 'Ultracode is on' })
      await gauge.waitFor()
      await gauge.click()
      check((await menuItems(page)).join('|') === 'Ultracode is on|Turn off', `${label}: Ultracode's menu (${await menuItems(page)})`)
      await pickMenu(page, 'Turn off')
      check(await until(() => calls('POST', /panes\/11\/ultracode$/).some((c) => JSON.stringify(c.body) === '{"on":false}')), `${label}: Ultracode off`)
      await page.getByRole('button', { name: 'Remote Control is on' }).click()
      check((await menuItems(page)).join('|') === 'Remote Control is on|Open on claude.ai|Turn off', `${label}: Remote Control's menu (${await menuItems(page)})`)
      if (!phone) await page.screenshot({ path: path.join(shots, `names-remote-${scheme}.png`) })
      await pickMenu(page, 'Turn off')
      check(await until(() => calls('POST', /panes\/11\/rc$/).some((c) => JSON.stringify(c.body) === '{"on":false}')), `${label}: Remote Control off`)
      await layout(page, `${label} with the header's switches`)

      // the ⋯ menu (phones get the session controls sheet from another change)
      if (!phone) {
        const l = await more(page)
        check(
          l.join('|') === 'Compact context|Rewind…|Past conversations…|Fork conversation|Rename…|Rename tmux session…|Copy session ID|Clear conversation|Exit to shell|End session…',
          `${label}: the ⋯ menu (${l})`,
        )
        await page.screenshot({ path: path.join(shots, `names-menu-${scheme}.png`) })
        await pickMenu(page, 'Rename tmux session…')
        const tmux = page.getByRole('dialog', { name: 'Rename tmux session' })
        await tmux.waitFor()
        check(await tmux.getByText('tmux on that machine shows it too. Dots and colons become underscores.').isVisible(), `${label}: the tmux rename hint`)
        check((await tmux.getByRole('textbox').inputValue()) === 'storefront', `${label}: starts from the tmux name`)
        check((await tmux.getByRole('button', { name: 'Use automatic name' }).count()) === 0, `${label}: a tmux session has no automatic name`)
        await tmux.getByRole('textbox').fill('shop.v2')
        await tmux.getByRole('button', { name: 'Save' }).click()
        check(await until(() => calls('PUT', /sessions\/11\/name$/).some((c) => (c.body as Obj)?.name === 'shop.v2')), `${label}: PUT the tmux session's name (${JSON.stringify(asked)})`)
        await until(async () => (await tmux.count()) === 0)

        await more(page)
        await pickMenu(page, 'Clear conversation')
        const fresh = page.getByRole('dialog', { name: 'Start a fresh conversation?' })
        await fresh.waitFor()
        check(await fresh.getByText('The current one is saved and can be resumed later.').isVisible(), `${label}: Clear says the conversation is kept`)
        await fresh.getByRole('button', { name: 'Clear' }).click()
        check(await until(() => state.sends.some((s) => (s as Obj).text === '/clear')), `${label}: Clear types /clear`)

        await more(page)
        await pickMenu(page, 'Past conversations…')
        await page.getByRole('dialog', { name: 'Past conversations' }).waitFor()
        await closeSheet(page, 'Past conversations')

        // Codex asking something: only what can't reach its question stays
        await page.goto(`${base}/next/m/local/p/12`)
        await page.getByText('Would you like to run the following command?').waitFor()
        const asking = await more(page)
        check(asking.join('|') === 'Past conversations…|Rename…|End session…', `${label}: the menu while Codex asks (${asking})`)
        await page.keyboard.press('Escape')

        // a tmux session's own menu on its machine's page
        await page.goto(`${base}/next/machines/local`)
        const head = page.locator('.session-group-head', { hasText: 'storefront' })
        await head.waitFor()
        await head.click({ button: 'right' })
        check((await menuItems(page)).join('|') === 'Rename tmux session…|Copy tmux name', `${label}: the tmux session's menu (${await menuItems(page)})`)
        await page.keyboard.press('Escape')
      }

      // Claude Code exited: Past conversations from "No agent is running"
      await page.goto(`${base}/next/m/local/p/24`)
      await page.getByText('No agent is running in this pane').waitFor()
      await page.getByRole('button', { name: 'Past conversations' }).click()
      await page.getByRole('dialog', { name: 'Past conversations' }).waitFor()
      check(await until(() => calls('GET', /panes\/24\/conversations\?agent=claude$/).length > 0), `${label}: the exited agent's conversations`)
      if (!phone) {
        // going to another session takes this one's list away with it
        await page.evaluate(() => (document.querySelector('a[href="/next/m/local/p/12"]') as HTMLElement | null)?.click())
        await page.getByText('Would you like to run the following command?').waitFor()
        check(await until(async () => (await page.getByRole('dialog', { name: 'Past conversations' }).count()) === 0), `${label}: the list closes with its session`)
        await page.goto(`${base}/next/m/local/p/24`)
        await page.getByText('No agent is running in this pane').waitFor()
      } else await closeSheet(page, 'Past conversations')

      // a plain shell: Start here, and the title renames its tmux window
      await page.goto(`${base}/next/m/local/p/23`)
      const start = page.locator('.term-start')
      await start.waitFor()
      check(await start.getByText('Start here:').isVisible(), `${label}: Start here:`)
      check((await start.getByRole('button').allTextContents()).join('|') === 'Claude Code|Codex|OpenCode', `${label}: a chip per installed agent (${await start.getByRole('button').allTextContents()})`)
      await layout(page, `${label} shell`)
      await page.screenshot({ path: path.join(shots, `names-shell-${w}-${scheme}.png`) })
      await start.getByRole('button', { name: 'Codex' }).click()
      check(await until(() => calls('POST', /panes\/23\/start$/).some((c) => (c.body as Obj)?.agent === 'codex')), `${label}: POST /start codex`)
      check(await until(() => toast(page, 'Starting Codex…').isVisible()), `${label}: Starting Codex…`)
      check(await start.getByRole('button', { name: 'Claude Code' }).isDisabled(), `${label}: one start at a time`)
      await page.locator('.session-title-button').click()
      const term = page.getByRole('dialog', { name: 'Rename terminal' })
      await term.waitFor()
      check(await term.getByText('Renames the tmux window, so tmux shows it too.').isVisible(), `${label}: the terminal's rename hint`)
      check((await term.getByRole('textbox').inputValue()) === 'logs', `${label}: starts from the window's name`)
      await closeSheet(page, 'Rename terminal')

      // a pane that's gone
      await page.goto(`${base}/next/m/local/p/99`)
      await page.getByText('This pane is gone').waitFor()
      check(await page.getByText('The tmux pane was closed or its machine is unreachable.').isVisible(), `${label}: the gone pane's text`)
      await ctx.close()
    }
} finally {
  state.hosts = undefined
  await done()
}
