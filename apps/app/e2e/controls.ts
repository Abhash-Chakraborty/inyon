// bun apps/app/e2e/controls.ts — the composer's model, effort, mode and goal chips, in the built app
// (apps/app/dist) behind the stand-in hub (hub.ts), at phone and desktop sizes in light and dark:
// each chip reads what the session runs, its menu types the agent's own command without showing it
// in the chat, a pick held until the agent is free says so and can be dropped, one that didn't
// take says why, the Goal sheet sets and turns off a goal, and ultracode marks the box.
// Screenshots go to $SHOTS (default: a temp folder). CHROME=/path/to/chrome picks the browser.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from 'playwright'
import { base, change, check, errors, finish, launch, layout, open, problems, state, streams, until, dropSockets, resetChats, SIZES } from './hub.ts'
import { capture } from './failure.ts'

const shots = process.env.SHOTS ?? path.join(tmpdir(), 'inyon-app-shots')
mkdirSync(shots, { recursive: true })
const browser = await launch()
const done = finish(browser)

// what the chips ask of the hub besides /send
const asked: { method: string; path: string; body: unknown }[] = []
state.routes.push(async (req, url) => {
  if (!/\/api\/hosts\/local\/panes\/[^/]+\/(mode|chosen|ultracode)$/.test(url.pathname)) return
  asked.push({ method: req.method, path: url.pathname.split('/').pop()!, body: await req.json().catch(() => undefined) })
  return Response.json({ ok: true })
})

const STREAM = 'local:%11'
/** The session's chat info with `extra` over it, as the hub would send it. */
function info(extra: Record<string, unknown>) {
  const c = streams.get(STREAM)!
  change(STREAM, { state: { info: { ...(c.state.info as object), ...extra } } })
}
function screen(extra: Record<string, unknown>) {
  const c = streams.get(STREAM)!
  change(STREAM, { state: { screen: { ...(c.state.screen as object), ...extra } } })
}

const settings = () => state.sends.filter((s: { setting?: boolean }) => s.setting).map((s: { text: string }) => s.text)
const chip = (page: Page, name: string | RegExp) => page.locator('.controls').getByRole('button', { name })
async function pick(page: Page, chipName: string | RegExp, item: string) {
  await chip(page, chipName).click()
  await page.getByRole('menu').getByRole('menuitemradio', { name: item }).or(page.getByRole('menu').getByRole('menuitem', { name: item })).first().click()
  await until(async () => (await page.getByRole('menu').count()) === 0)
}

try {
  for (const [w, h] of SIZES)
    for (const scheme of ['light', 'dark'] as const) {
      const label = `controls ${w}x${h} ${scheme}`
      const phone = w < 600
      resetChats()
      Object.assign(state, { sends: [] })
      asked.length = 0
      const { ctx, page } = await open(browser, w, h, scheme)
      await page.goto(`${base}/next/m/local/p/11`)
      await page.getByText('All 20 runs pass now.').waitFor()

      // what the session runs, one chip each
      check(await chip(page, 'Model').filter({ hasText: 'Sonnet 5.5' }).isVisible(), `${label}: the model chip`)
      check(await chip(page, 'Reasoning effort: Medium').filter({ hasText: 'Medium' }).isVisible(), `${label}: the effort chip`)
      check((await page.locator('.effort-bar.on').count()) === 2, `${label}: two of four bars lit for medium`)
      check(await chip(page, 'Permission mode: Ask each time').isVisible(), `${label}: the mode chip`)
      check(await chip(page, 'Set a goal').isVisible(), `${label}: the goal chip`)
      // a narrow box keeps the mode to its shield
      const modeWord = chip(page, 'Permission mode: Ask each time').locator('.control-word')
      check((await modeWord.isVisible()) === !phone, `${label}: the mode's word ${phone ? 'hidden on a phone' : 'shown'}`)
      await layout(page, label)
      await page.screenshot({ path: path.join(shots, `controls-${w}-${scheme}.png`) })

      // the model menu: what's running is ticked, a pick types /model without a chat message
      await chip(page, 'Model').click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      check(await menu.getByText('Model', { exact: true }).isVisible(), `${label}: the menu's heading`)
      check((await menu.getByRole('menuitemradio', { name: 'Sonnet 5.5' }).getAttribute('aria-checked')) === 'true', `${label}: Sonnet ticked`)
      if (!phone) await page.screenshot({ path: path.join(shots, `controls-model-menu-${scheme}.png`) })
      await menu.getByRole('menuitemradio', { name: 'Opus 5.5' }).click()
      await until(() => settings().includes('/model opus'))
      check(settings().includes('/model opus'), `${label}: /model opus as a setting (${JSON.stringify(state.sends)})`)

      await pick(page, /^Reasoning effort/, 'High')
      await until(() => settings().includes('/effort high'))
      check(settings().includes('/effort high'), `${label}: /effort high`)
      // Claude Code's ultracode switch sits with the levels
      await chip(page, /^Reasoning effort/).click()
      check(await page.getByRole('menu').getByText('Ultracode: off').isVisible(), `${label}: Ultracode in the effort menu`)
      await page.keyboard.press('Escape')
      await until(async () => (await page.getByRole('menu').count()) === 0)

      await pick(page, /^Permission mode/, 'Plan')
      await until(() => asked.some((a) => a.path === 'mode'))
      check(asked.some((a) => a.path === 'mode' && (a.body as { mode?: string })?.mode === 'plan'), `${label}: POST /mode plan (${JSON.stringify(asked)})`)

      // a level waiting for the agent to be free, then dropped
      info({ chosen: { effort: 'low' } })
      const waiting = chip(page, 'Switches to Low when Claude Code is free')
      await waiting.waitFor()
      check((await waiting.innerText()).includes('Low'), `${label}: the chip shows the pick`)
      await waiting.click()
      const keep = page.getByRole('menu').getByRole('menuitem', { name: /Don't switch/ })
      check(await keep.getByText('Keeps Medium').isVisible(), `${label}: Don't switch keeps the level running`)
      await keep.click()
      await until(() => asked.some((a) => a.path === 'chosen'))
      check(asked.some((a) => a.path === 'chosen' && a.method === 'DELETE'), `${label}: DELETE /chosen`)

      // one that didn't take says why
      info({ chosen: { effort: 'low', error: 'Claude Code kept its level' } })
      await chip(page, "Couldn't switch to Low: Claude Code kept its level").waitFor()
      check(await chip(page, "Couldn't switch to Low: Claude Code kept its level").filter({ hasText: 'Medium' }).isVisible(), `${label}: the failed pick keeps the level running`)
      info({ chosen: null })

      // the goal: set it, then it shows and can be turned off
      await chip(page, 'Set a goal').click()
      const sheet = page.getByRole('dialog', { name: 'Goal' })
      await sheet.waitFor()
      check(await sheet.getByRole('button', { name: 'Set goal' }).isDisabled(), `${label}: Set goal waits for a condition`)
      await sheet.locator('textarea').fill('All 20 runs pass')
      if (!phone) await page.screenshot({ path: path.join(shots, `controls-goal-${scheme}.png`) })
      await sheet.getByRole('button', { name: 'Set goal' }).click()
      await until(() => settings().includes('/goal All 20 runs pass'))
      check(settings().includes('/goal All 20 runs pass'), `${label}: /goal with the condition`)
      await until(async () => (await page.getByRole('dialog', { name: 'Goal' }).count()) === 0)
      info({ goal: { condition: 'All 20 runs pass', met: false, ts: new Date().toISOString() } })
      const on = chip(page, 'Goal: All 20 runs pass')
      await on.waitFor()
      check((await on.innerText()).includes('All 20 runs pass'), `${label}: the goal on its chip`)
      await on.click()
      await sheet.waitFor()
      check(await sheet.getByText('Active goal').isVisible(), `${label}: the sheet shows the goal`)
      check((await sheet.locator('textarea').inputValue()) === 'All 20 runs pass', `${label}: the sheet starts from it`)
      await sheet.getByRole('button', { name: 'Turn off' }).click()
      await until(() => settings().includes('/goal clear'))
      check(settings().includes('/goal clear'), `${label}: Turn off clears it`)

      // none of these went into the chat as a message
      check(state.sends.every((s: { setting?: boolean }) => s.setting), `${label}: only settings were sent`)

      // ultracode on: the box carries its label
      screen({ ultracode: true })
      await page.locator('.ultracode-label').waitFor()
      check(await page.locator('.composer-box.ultracode-box').isVisible(), `${label}: the box marked for ultracode`)
      check(await chip(page, /Ultracode on/).isVisible(), `${label}: the effort chip says Ultracode is on`)
      await layout(page, `${label} with every chip`)

      // with the hub away nothing can say the pane is still this session, so the chips take no picks
      state.refuseWs = true
      dropSockets()
      check(await until(async () => await chip(page, 'Model').isDisabled()), `${label}: the chips are inert while the hub is away`)
      check(await chip(page, 'Set a goal').or(chip(page, /^Goal:/)).first().isDisabled(), `${label}: the goal chip too`)
      state.refuseWs = false
      check(await until(async () => await chip(page, 'Model').isEnabled(), 15000), `${label}: and back once it reconnects`)
      // the refused tries are in the browser's log
      for (let i = errors.length - 1; i >= 0; i--) if (/Unexpected response code: 503/.test(errors[i]!)) errors.splice(i, 1)
      await ctx.close()
    }
} catch (e) {
  await capture(browser, shots, 'controls', problems)
  throw e
} finally {
  await done()
}
