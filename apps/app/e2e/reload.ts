// bun apps/app/e2e/reload.ts — a reload in the built app (apps/app/dist) behind the stand-in hub
// (hub.ts), at phone and desktop sizes in light and dark. The first visit shows "Opening Inyon"
// while the sign-in check runs, then keeps the overview and the open chat in the browser. A
// reload then paints both before the hub answers, without "Reconnecting" or a jump when the
// live data lands; a draft typed just before it isn't lost; a deep link to a pane the kept copy
// doesn't have shows the session's loading shape, not "This pane is gone", until the hub says so;
// links stay inside the app; a real drop still says "Reconnecting"; and a sign-in that ran out
// shows the form and takes the kept copies away. With the React app built (apps/web/dist) it
// draws the same moments there, from the same kept copies, for comparison.
// Screenshots go to $SHOTS (default: a temp folder). CHROME=/path/to/chrome picks the browser.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BrowserContext, Page } from 'playwright'
import { base, check, dropSockets, errors, finish, hasReact, launch, layout, open, resetChats, SIZES, state, until } from './hub.ts'

const shots = process.env.SHOTS ?? path.join(tmpdir(), 'inyon-app-shots')
mkdirSync(shots, { recursive: true })
const browser = await launch()
const done = finish(browser)
const LAST = 'All 20 runs pass now.'

/** Holds every sub until the returned function lets them through. */
function hold() {
  let open!: () => void
  state.gate = new Promise<void>((r) => (open = r))
  return () => {
    state.gate = undefined
    open()
  }
}

/** Notes, from the page's first moment, any time something on it says "Reconnecting". */
async function watchReconnecting(ctx: BrowserContext) {
  await ctx.addInitScript(() => {
    const w = window as unknown as { sawReconnecting?: string }
    const look = () => {
      const el = [...document.querySelectorAll('[aria-label], [role=status], .reconnecting')].find((e) => /Reconnecting/.test(e.getAttribute('aria-label') ?? '') || /Reconnecting/.test(e.textContent ?? ''))
      if (el && !w.sawReconnecting) w.sawReconnecting = el.outerHTML.slice(0, 120)
    }
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
  })
}
const sawReconnecting = (page: Page) => page.evaluate(() => (window as unknown as { sawReconnecting?: string }).sawReconnecting ?? '')
const kept = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key)
const atBottom = (page: Page) => page.locator('#chat-scroll').evaluate((s) => s.scrollTop + s.clientHeight >= s.scrollHeight - 2)

for (const [w, h] of SIZES)
  for (const scheme of ['light', 'dark'] as const) {
    const tag = `${w}-${scheme}`
    resetChats()
    state.drafts.length = 0
    const { ctx, page } = await open(browser, w, h, scheme)
    await watchReconnecting(ctx)
    try {
      // ---- the first visit: nothing kept yet, so the sign-in check shows the Overview's shape ----
      state.sessionDelay = 1500
      await page.goto(`${base}/next/`)
      const opening = page.getByRole('status').filter({ hasText: 'Opening Inyon' })
      check(await opening.waitFor({ timeout: 5000 }).then(() => true, () => false), `${tag} first visit: "Opening Inyon" while the sign-in check runs`)
      check((await page.locator('.opening .skeleton').count()) === 4, `${tag} first visit: four card shapes`)
      await page.screenshot({ path: path.join(shots, `reload-opening-${tag}.png`) })
      state.sessionDelay = 0
      await page.getByText('Fix flaky checkout test').first().waitFor()
      check(!(await opening.count()), `${tag} first visit: the shape gives way to the Overview`)
      check(await until(async () => !!(await kept(page, 'inyon.overview.v1'))), `${tag} first visit: the overview is kept in the browser`)
      const ov = JSON.parse((await kept(page, 'inyon.overview.v1'))!)
      check(typeof ov.at === 'number' && Array.isArray(ov.data) && ov.data.some((h: { config: { name: string } }) => h.config.name === 'studio'), `${tag} first visit: kept as the web app keeps it ({at, data})`)

      // ---- links stay inside the app ----
      await page.evaluate(() => ((window as unknown as { stay?: number }).stay = 1))
      await page.locator('a[href="/next/machines"]:visible').first().click()
      await page.waitForURL(/\/next\/machines$/)
      check((await page.evaluate(() => (window as unknown as { stay?: number }).stay)) === 1, `${tag} links: Machines opens without loading the page again`)
      await page.locator('a[href="/next/"]:visible').first().click()
      await page.waitForURL(/\/next\/$/)

      // ---- a session, kept too ----
      await page.evaluate(() => {
        history.pushState(null, '', '/next/m/local/p/11')
        dispatchEvent(new PopStateEvent('popstate'))
      })
      await page.getByText(LAST).first().waitFor()
      check(await until(async () => !!(await kept(page, 'inyon.chat.v1.local:%11'))), `${tag} session: its last page is kept`)
      const chat = JSON.parse((await kept(page, 'inyon.chat.v1.local:%11'))!)
      check(chat.data.items.length === 40 && chat.data.hasMore === true, `${tag} session: the last 40 messages, more before them (${chat.data.items.length})`)
      check((await kept(page, 'inyon.chats.v1')) === '["local:%11"]', `${tag} session: listed among the kept chats`)

      // ---- a draft typed just before the reload goes with it ----
      const box = page.locator('#composer-input')
      await box.click()
      await box.fill('and check the coupon path too')
      await page.reload({ waitUntil: 'commit' })
      check(await until(() => state.drafts.some((d) => d.text === 'and check the coupon path too'), 3000), `${tag} draft: sent as the page went away`)

      // ---- the reload: real content before the hub answers ----
      const let_go = hold()
      state.sessionDelay = 800
      await page.waitForLoadState('domcontentloaded')
      const painted = await page.getByText(LAST).first().waitFor({ timeout: 8000 }).then(() => true, () => false)
      check(painted, `${tag} reload: the chat draws from the kept copy while the hub hasn't answered`)
      check(!(await page.getByRole('status').filter({ hasText: 'Opening' }).count()), `${tag} reload: no loading shape over kept content`)
      check(await page.locator('.session-title').filter({ hasText: 'Fix flaky checkout test' }).isVisible(), `${tag} reload: the title from the kept overview`)
      await page.waitForTimeout(300)
      await page.screenshot({ path: path.join(shots, `reload-kept-${tag}.png`) })
      check(await atBottom(page), `${tag} reload: the kept chat opens at its latest message`)
      let_go()
      state.sessionDelay = 0
      // the hub's whole conversation lands above it: the reader stays at the latest message
      let off = 0
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(50)
        if (!(await atBottom(page))) off++
      }
      check(off <= 1, `${tag} reload: stays at the latest message as the hub's copy lands (${off} of 20 looks away)`)
      check(await page.getByText(LAST).first().isVisible(), `${tag} reload: the latest reply still on screen`)
      check(!(await sawReconnecting(page)), `${tag} reload: never said Reconnecting: ${await sawReconnecting(page)}`)
      await layout(page, `${tag} reload`)

      // ---- a deep link to a pane the kept copy doesn't have ----
      const let_go2 = hold()
      await page.goto(`${base}/next/m/local/p/99`)
      const shape = page.getByRole('status').filter({ hasText: 'Opening the session on studio' })
      check(await shape.waitFor({ timeout: 8000 }).then(() => true, () => false), `${tag} deep link: "Opening the session on studio" until the hub answers`)
      check(!(await page.getByText('This pane is gone').count()), `${tag} deep link: not called gone from the kept copy`)
      await page.screenshot({ path: path.join(shots, `reload-deeplink-${tag}.png`) })
      let_go2()
      check(await page.getByText('This pane is gone').waitFor({ timeout: 5000 }).then(() => true, () => false), `${tag} deep link: gone once the hub's overview says so`)
      check(!(await sawReconnecting(page)), `${tag} deep link: never said Reconnecting`)

      // ---- a real drop still says so ----
      await page.goto(`${base}/next/m/local/p/11`)
      await page.getByText(LAST).first().waitFor()
      state.refuseWs = true
      dropSockets()
      check(await page.getByRole('status').filter({ hasText: 'Reconnecting…' }).waitFor({ timeout: 6000 }).then(() => true, () => false), `${tag} drop: the chat says Reconnecting…`)
      state.refuseWs = false
      check(await page.getByRole('status').filter({ hasText: 'Reconnecting…' }).waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false), `${tag} drop: and stops once it's back`)
      // the refused tries are in the browser's log
      for (let i = errors.length - 1; i >= 0; i--) if (/Unexpected response code: 503/.test(errors[i]!)) errors.splice(i, 1)

      // ---- a sign-in that ran out ----
      state.authed = false
      await page.goto(`${base}/next/`)
      check(await page.getByLabel('Password', { exact: true }).waitFor({ timeout: 8000 }).then(() => true, () => false), `${tag} signed out: the sign-in form`)
      check(await until(async () => !(await kept(page, 'inyon.overview.v1')) && !(await kept(page, 'inyon.chat.v1.local:%11')) && !(await kept(page, 'inyon.chats.v1'))), `${tag} signed out: the kept copies are gone`)
      // the socket tried before the check answered, as the web app's does; the browser logs its refusal
      for (let i = errors.length - 1; i >= 0; i--) if (/HTTP Authentication failed/.test(errors[i]!)) errors.splice(i, 1)
    } catch (e) {
      check(false, `${tag}: ${(e as Error).message.split('\n')[0]}`)
      await page.screenshot({ path: path.join(shots, `reload-failed-${tag}.png`) }).catch(() => {})
    } finally {
      state.authed = true
      state.sessionDelay = 0
      state.refuseWs = false
      state.gate = undefined
      await ctx.close()
    }
  }

// ---- the React app at the same moments, for comparison ----
if (hasReact)
  for (const [w, h] of SIZES)
    for (const scheme of ['light', 'dark'] as const) {
      const tag = `${w}-${scheme}`
      const { ctx, page } = await open(browser, w, h, scheme)
      try {
        state.sessionDelay = 1500
        await page.goto(`${base}/`)
        await page.getByText('Opening Inyon').waitFor({ timeout: 8000 })
        await page.screenshot({ path: path.join(shots, `react-reload-opening-${tag}.png`) })
        state.sessionDelay = 0
        // the copy the Rust app keeps, read by the web app
        await page.goto(`${base}/next/m/local/p/11`)
        await page.getByText(LAST).first().waitFor()
        await until(async () => !!(await kept(page, 'inyon.chat.v1.local:%11')))
        const let_go = hold()
        await page.goto(`${base}/m/local/p/11`)
        check(await page.getByText(LAST).first().waitFor({ timeout: 8000 }).then(() => true, () => false), `${tag} React: draws the chat the Rust app kept`)
        await page.waitForTimeout(300)
        await page.screenshot({ path: path.join(shots, `react-reload-kept-${tag}.png`) })
        let_go()
      } catch (e) {
        check(false, `${tag} React: ${(e as Error).message.split('\n')[0]}`)
      } finally {
        state.sessionDelay = 0
        state.gate = undefined
        await ctx.close()
      }
    }

await done()
