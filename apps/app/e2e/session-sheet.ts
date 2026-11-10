// bun apps/app/e2e/session-sheet.ts — the session controls sheet and the header's usage chip, in the
// built app (apps/app/dist) behind the stand-in hub (hub.ts), at phone and desktop sizes in light and
// dark: the chip shows the context ring and the 5-hour window and opens the sheet, a desktop's hover
// shows the summary, a phone's ⋯ opens the sheet where a desktop's opens the menu (whose first item is
// Session controls…), the sheet's model, effort and mode buttons and its switches act on the session,
// Clear asks first, and while the agent asks something only its Usage part stays.
// Screenshots go to $SHOTS (default: a temp folder). CHROME=/path/to/chrome picks the browser.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from 'playwright'
import { base, change, check, finish, launch, layout, open, problems, state, streams, until, resetChats, SIZES } from './hub.ts'
import { capture } from './failure.ts'

const shots = process.env.SHOTS ?? path.join(tmpdir(), 'inyon-app-shots')
mkdirSync(shots, { recursive: true })
const browser = await launch()
const done = finish(browser)

// what the sheet asks of the hub besides /send
const asked: { method: string; path: string; body: unknown }[] = []
state.routes.push(async (req, url) => {
  if (!/\/api\/hosts\/local\/panes\/[^/]+\/(mode|chosen|ultracode)$/.test(url.pathname)) return
  asked.push({ method: req.method, path: url.pathname.split('/').pop()!, body: await req.json().catch(() => undefined) })
  return Response.json({ ok: true })
})

const STREAM = 'local:%11'
function screen(extra: Record<string, unknown>) {
  const c = streams.get(STREAM)!
  change(STREAM, { state: { screen: { ...(c.state.screen as object), ...extra } } })
}

type Send = { text: string; setting?: boolean }
const settings = () => state.sends.filter((s: Send) => s.setting).map((s: Send) => s.text)
const typed = () => state.sends.filter((s: Send) => !s.setting).map((s: Send) => s.text)
const sheetOf = (page: Page) => page.getByRole('dialog', { name: 'Claude Code' })
const gone = (page: Page, name: string) => until(async () => (await page.getByRole('dialog', { name }).count()) === 0)

try {
  for (const [w, h] of SIZES)
    for (const scheme of ['light', 'dark'] as const) {
      const label = `sheet ${w}x${h} ${scheme}`
      const phone = w < 768
      resetChats()
      Object.assign(state, { sends: [] })
      asked.length = 0
      const { ctx, page } = await open(browser, w, h, scheme)
      await page.goto(`${base}/next/m/local/p/11`)
      await page.getByText('All 20 runs pass now.').waitFor()

      // the usage chip: the ring always, the share from 640 px, the 5-hour window from 1024 px
      const chip = page.getByRole('button', { name: 'Usage and limits' })
      check(await chip.isVisible(), `${label}: the usage chip`)
      check(await chip.locator('.context-ring').isVisible(), `${label}: its ring`)
      check((await chip.locator('.usage-chip-pct').isVisible()) === w >= 640, `${label}: the share ${w >= 640 ? 'shown' : 'hidden'}`)
      if (w >= 640) check((await chip.locator('.usage-chip-pct').innerText()) === '6%', `${label}: 6% of the window (${await chip.innerText()})`)
      check((await chip.locator('.usage-chip-five').isVisible()) === w >= 1024, `${label}: the 5-hour window ${w >= 1024 ? 'shown' : 'hidden'}`)
      if (w >= 1024) check((await chip.locator('.usage-chip-five').innerText()).includes('5h 22%'), `${label}: 5h 22%`)
      if (!phone) {
        // a hover shows the summary card
        await chip.hover()
        const card = page.locator('.usage-hover-card')
        await until(async () => (await card.evaluate((el) => getComputedStyle(el.parentElement!).opacity)) === '1')
        check(await card.getByText('Context', { exact: true }).isVisible(), `${label}: the hover card's context`)
        check(await card.getByText('5-hour').isVisible(), `${label}: and its 5-hour window`)
        await page.screenshot({ path: path.join(shots, `sheet-hover-${scheme}.png`) })
        await page.mouse.move(5, 5)
      }
      await layout(page, label)

      // ⋯: the sheet on a phone, the menu (with Session controls… first) on a desktop
      const more = page.locator('.session-head').getByRole('button', { name: 'More' }).filter({ visible: true })
      check((await more.count()) === 1, `${label}: one ⋯ on the screen`)
      await more.click()
      const sheet = sheetOf(page)
      if (phone) {
        await sheet.waitFor()
        check((await page.getByRole('menu').count()) === 0, `${label}: no menu on a phone`)
      } else {
        const menu = page.getByRole('menu')
        await menu.waitFor()
        check((await menu.getByRole('menuitem').first().innerText()).includes('Session controls…'), `${label}: Session controls… first`)
        await menu.getByRole('menuitem', { name: 'Session controls…' }).click()
        await sheet.waitFor()
      }
      await sheet.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)))
      await page.screenshot({ path: path.join(shots, `sheet-${w}-${scheme}.png`) })

      // model, effort and mode: what runs is marked, a pick goes as a setting or to /mode
      check((await sheet.getByRole('button', { name: 'Sonnet 5.5' }).getAttribute('aria-pressed')) === 'true', `${label}: Sonnet marked`)
      await sheet.getByRole('button', { name: 'Opus 5.5' }).click()
      await until(() => settings().includes('/model opus'))
      check(settings().includes('/model opus'), `${label}: /model opus as a setting (${JSON.stringify(state.sends)})`)
      const levels = sheet.getByRole('radiogroup', { name: 'Reasoning effort' })
      check((await levels.getByRole('radio', { name: 'Med' }).getAttribute('aria-checked')) === 'true', `${label}: Med picked`)
      await levels.getByRole('radio', { name: 'High', exact: true }).click()
      await until(() => settings().includes('/effort high'))
      check(settings().includes('/effort high'), `${label}: /effort high`)
      check((await sheet.getByRole('button', { name: 'Ask each time' }).getAttribute('aria-pressed')) === 'true', `${label}: the mode marked`)
      await sheet.getByRole('button', { name: 'Plan', exact: true }).click()
      await until(() => asked.some((a) => a.path === 'mode'))
      check(asked.some((a) => a.path === 'mode' && (a.body as { mode?: string })?.mode === 'plan'), `${label}: POST /mode plan (${JSON.stringify(asked)})`)

      // the switches
      await sheet.getByRole('switch', { name: 'Ultracode' }).click()
      await until(() => asked.some((a) => a.path === 'ultracode'))
      check(asked.some((a) => a.path === 'ultracode' && a.method === 'POST'), `${label}: Ultracode on (${JSON.stringify(asked)})`)

      // the actions: Compact goes at once, Clear asks first
      await sheet.getByRole('button', { name: 'Compact', exact: true }).click()
      await until(() => typed().includes('/compact'))
      check(typed().includes('/compact'), `${label}: Compact sends /compact`)
      await sheet.getByRole('button', { name: 'Clear', exact: true }).click()
      const ask = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: 'Start a fresh conversation?' })).first()
      await ask.waitFor()
      check(await ask.getByText('The current one is saved and can be resumed later.').isVisible(), `${label}: Clear asks first`)
      check(!typed().includes('/clear'), `${label}: nothing sent before the answer`)
      await ask.getByRole('button', { name: 'Clear' }).click()
      await until(() => typed().includes('/clear'))
      check(typed().includes('/clear'), `${label}: then /clear`)

      // its Usage part
      check(await sheet.getByText('Context window').isVisible(), `${label}: the Usage panel in the sheet`)

      // the goal row opens the Goal sheet in its place
      await sheet.getByRole('button', { name: /^Goal/ }).click()
      await page.getByRole('dialog', { name: 'Goal' }).waitFor()
      check(await gone(page, 'Claude Code'), `${label}: the controls sheet makes way for the goal`)
      await page.keyboard.press('Escape')
      await gone(page, 'Goal')

      // while the agent asks something only the Usage part stays, and the menu has no Session controls…
      screen({ prompt: { body: ['Run the checkout suite again?'], options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: 'No', selected: false }], multi: false } })
      await chip.click()
      await sheet.waitFor()
      await sheet.getByText('Claude Code is asking you something.', { exact: false }).waitFor()
      check((await sheet.getByText('Reasoning effort').count()) === 0, `${label}: no levels while it asks`)
      check(await sheet.getByText('Context window').isVisible(), `${label}: the Usage part stays`)
      if (!phone) await page.screenshot({ path: path.join(shots, `sheet-asking-${scheme}.png`) })
      await page.keyboard.press('Escape')
      await gone(page, 'Claude Code')
      if (!phone) {
        await more.click()
        await page.getByRole('menu').waitFor()
        check((await page.getByRole('menuitem', { name: 'Session controls…' }).count()) === 0, `${label}: no Session controls… while it asks`)
        await page.keyboard.press('Escape')
      }
      await ctx.close()
    }
} catch (e) {
  await capture(browser, shots, 'session-sheet', problems)
  throw e
} finally {
  await done()
}
