// bun apps/app/e2e/composer-menus.ts — the lists over the message box, in the built app
// (apps/app/dist) behind the stand-in hub (hub.ts), at phone and desktop sizes in light and dark:
// `/` lists the machine's commands and skills with where each comes from (read again each time it
// opens), the arrows and Enter or Tab pick, a bare `/model` or `/effort` opens its chip's menu and
// `/resume` Past conversations instead of typing it, a command that takes nothing runs at once, Esc
// closes the list, `@` lists the folder's files and folders (a folder keeps the list open inside
// it), and in Codex `$` lists its skills.
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

const CLAUDE = [
  { name: '/clear', description: 'Start a fresh conversation', source: 'built-in', instant: true },
  { name: '/compact', description: 'Summarise the conversation so far', source: 'built-in' },
  { name: '/model', description: 'Pick the model', source: 'built-in' },
  { name: '/effort', description: 'Set the reasoning effort', source: 'built-in' },
  { name: '/resume', description: 'Resume a past conversation', source: 'built-in' },
  { name: '/review', description: 'Review the working tree', source: 'skill' },
  { name: '/deploy-docs', description: 'Publish the docs site', source: 'project' },
]
const CODEX = [
  { name: '/model', description: 'Pick the model', source: 'built-in' },
  { name: '/review', description: 'Review the current changes', source: 'built-in' },
  { name: '$review-pr', description: 'Review a pull request', source: 'skill' },
  { name: '$tidy-imports', description: 'Sort and prune imports', source: 'skill' },
]
const FILES = ['src/checkout/total.ts', 'src/checkout/checkout.test.ts', 'src/cart.ts', 'README.md']

/** How often each pane's commands were asked for. */
const asked = new Map<string, number>()
state.routes.push((req, url) => {
  const m = /^\/api\/hosts\/local\/panes\/(\d+)\/(commands|files)$/.exec(url.pathname)
  if (!m || req.method !== 'GET') return
  if (m[2] === 'files') return Response.json({ cwd: '/home/sam/code/storefront', files: FILES })
  asked.set(m[1]!, (asked.get(m[1]!) ?? 0) + 1)
  return Response.json(m[1] === '12' ? CODEX : CLAUDE)
})

const box = (page: Page) => page.locator('#composer-input')
const list = (page: Page) => page.locator('.suggest')
const rows = (page: Page) => page.getByRole('listbox').getByRole('option')
const shown = async (page: Page) => (await list(page).count()) > 0
/** Empties the box and types `text` into it, a key at a time. */
async function type(page: Page, text: string) {
  await box(page).fill('')
  await until(async () => !(await shown(page)))
  await box(page).click()
  await page.keyboard.type(text, { delay: 15 })
}
const messages = () => state.sends.filter((s: { setting?: boolean }) => !s.setting).map((s: { text: string }) => s.text)

try {
  for (const [w, h] of SIZES)
    for (const scheme of ['light', 'dark'] as const) {
      const label = `menus ${w}x${h} ${scheme}`
      resetChats()
      Object.assign(state, { sends: [] })
      asked.clear()
      const { ctx, page } = await open(browser, w, h, scheme)
      await page.goto(`${base}/next/m/local/p/11`)
      await page.getByText('All 20 runs pass now.').waitFor()

      // `/` lists the commands and skills, with where each comes from
      await type(page, '/')
      await list(page).waitFor()
      check(await list(page).getByText('Commands and skills').isVisible(), `${label}: the list's heading`)
      check(await until(async () => (await rows(page).filter({ hasText: '/deploy-docs' }).count()) === 1), `${label}: the machine's commands`)
      check(await rows(page).filter({ hasText: '/review' }).getByText('skill', { exact: true }).isVisible(), `${label}: a skill says so`)
      check(await rows(page).filter({ hasText: '/deploy-docs' }).getByText('project', { exact: true }).isVisible(), `${label}: a project command says so`)
      check(await rows(page).filter({ hasText: '/compact' }).getByText('Summarise the conversation so far').isVisible(), `${label}: each with what it does`)
      check((await rows(page).first().getAttribute('aria-selected')) === 'true', `${label}: the first row picked`)
      await layout(page, `${label} with the list open`)
      await page.screenshot({ path: path.join(shots, `menus-slash-${w}-${scheme}.png`) })

      // typing narrows it, the arrows move, Enter puts the name in
      await page.keyboard.type('rev', { delay: 15 })
      await until(async () => ((await rows(page).first().innerText()) ?? '').includes('/review'))
      check((await rows(page).first().innerText()).includes('/review'), `${label}: /review first for "rev"`)
      await page.keyboard.press('Enter')
      check(await until(async () => (await box(page).inputValue()) === '/review '), `${label}: Enter puts /review in (${await box(page).inputValue()})`)
      check(!(await shown(page)), `${label}: and closes the list`)
      check(messages().length === 0, `${label}: nothing sent`)

      // the arrows wrap, and Tab picks too
      await type(page, '/')
      await until(async () => (await rows(page).count()) === CLAUDE.length)
      await page.keyboard.press('ArrowUp')
      check((await rows(page).last().getAttribute('aria-selected')) === 'true', `${label}: ↑ from the top goes to the last row`)
      await page.keyboard.press('ArrowDown')
      check((await rows(page).first().getAttribute('aria-selected')) === 'true', `${label}: ↓ from the last goes back to the top`)
      await page.keyboard.type('comp', { delay: 15 })
      await until(async () => (await rows(page).count()) === 1)
      await page.keyboard.press('Tab')
      check(await until(async () => (await box(page).inputValue()) === '/compact '), `${label}: Tab picks (${await box(page).inputValue()})`)
      // the list opens again from the machine
      check((asked.get('11') ?? 0) >= 2, `${label}: commands read each time the list opens (${asked.get('11')})`)

      // Esc closes the list and leaves the text
      await type(page, '/mo')
      await list(page).waitFor()
      await page.keyboard.press('Escape')
      check(await until(async () => !(await shown(page))), `${label}: Esc closes the list`)
      check((await box(page).inputValue()) === '/mo', `${label}: and keeps what's typed`)

      // a bare /model opens the model chip's menu instead of the agent's picker
      await type(page, '/mod')
      await until(async () => (await rows(page).first().innerText()).includes('/model'))
      await page.keyboard.press('Enter')
      const menu = page.getByRole('menu')
      check(await until(async () => (await menu.count()) > 0 && (await menu.getByText('Model', { exact: true }).isVisible())), `${label}: /model opens the model menu`)
      check((await box(page).inputValue()) === '', `${label}: and empties the box`)
      if (w > 600) await page.screenshot({ path: path.join(shots, `menus-model-${scheme}.png`) })
      await page.keyboard.press('Escape')
      await until(async () => (await menu.count()) === 0)

      // so does sending it, and /effort opens the effort menu
      await type(page, '/effort ')
      check(!(await shown(page)), `${label}: a space closes the list`)
      // on a phone Enter is a new line, so the button sends
      if (w < 600) await page.getByRole('button', { name: /^(Send|Queue follow-up)$/ }).click()
      else await page.keyboard.press('Enter')
      check(await until(async () => (await menu.count()) > 0 && (await menu.getByText('Reasoning effort', { exact: true }).isVisible())), `${label}: /effort opens the effort menu`)
      check((await box(page).inputValue()) === '', `${label}: the box is empty again`)
      await page.keyboard.press('Escape')
      await until(async () => (await menu.count()) === 0)

      // /resume opens Past conversations
      await type(page, '/resu')
      await until(async () => (await rows(page).first().innerText()).includes('/resume'))
      await page.keyboard.press('Enter')
      const past = page.getByRole('dialog', { name: 'Past conversations' })
      check(await until(async () => (await past.count()) > 0), `${label}: /resume opens Past conversations`)
      await page.keyboard.press('Escape')
      await until(async () => (await past.count()) === 0)
      check(messages().length === 0, `${label}: none of those went to the agent (${JSON.stringify(messages())})`)

      // a command that takes nothing runs as soon as it's picked
      await type(page, '/cle')
      await until(async () => (await rows(page).first().innerText()).includes('/clear'))
      await rows(page).first().click()
      check(await until(() => messages().includes('/clear')), `${label}: /clear sent at once (${JSON.stringify(state.sends)})`)
      check((await box(page).inputValue()) === '', `${label}: and the box empties`)

      // `@` lists the folder's files and folders
      await type(page, 'look at @tot')
      await list(page).waitFor()
      check(await until(async () => await list(page).getByText('Files in this folder').isVisible()), `${label}: the files list's heading`)
      check((await rows(page).first().innerText()).includes('src/checkout/total.ts'), `${label}: total.ts first for "tot"`)
      if (w > 600) await page.screenshot({ path: path.join(shots, `menus-files-${scheme}.png`) })
      await rows(page).first().click()
      check(await until(async () => (await box(page).inputValue()) === 'look at @src/checkout/total.ts '), `${label}: a click puts the path in (${await box(page).inputValue()})`)
      check(!(await shown(page)), `${label}: and closes the list`)
      // a folder keeps it open inside the folder
      await type(page, '@chec')
      await until(async () => (await rows(page).filter({ hasText: /^src\/checkout\/$/ }).count()) === 1)
      await rows(page).filter({ hasText: /^src\/checkout\/$/ }).click()
      check(await until(async () => (await box(page).inputValue()) === '@src/checkout/'), `${label}: the folder goes in (${await box(page).inputValue()})`)
      check(await until(async () => (await shown(page)) && (await rows(page).filter({ hasText: 'checkout.test.ts' }).count()) === 1), `${label}: and the list shows what's inside`)
      await layout(page, `${label} with the files list`)
      await box(page).fill('')

      // Codex: `/` is "Commands" and `$` lists its skills
      const codex = streams.get('local:%12')!
      change('local:%12', { state: { screen: { ...(codex.state.screen as object), prompt: null } } })
      await page.goto(`${base}/next/m/local/p/12`)
      await page.getByText('The passkey routes are in.').waitFor()
      await box(page).waitFor()
      await type(page, '/')
      await list(page).waitFor()
      check(await list(page).getByText('Commands', { exact: true }).isVisible(), `${label}: Codex's list is "Commands"`)
      check(await until(async () => (await rows(page).filter({ hasText: '$review-pr' }).count()) === 0 && (await rows(page).count()) === 2), `${label}: without the skills`)
      await type(page, 'use $rev')
      await list(page).waitFor()
      check(await list(page).getByText('Skills', { exact: true }).isVisible(), `${label}: $ lists the skills`)
      check(await until(async () => (await rows(page).first().innerText()).includes('$review-pr')), `${label}: $review-pr first`)
      await page.keyboard.press('Enter')
      check(await until(async () => (await box(page).inputValue()) === 'use $review-pr '), `${label}: Enter puts the skill in (${await box(page).inputValue()})`)
      if (w > 600) await page.screenshot({ path: path.join(shots, `menus-skills-${scheme}.png`) })
      await ctx.close()
    }
} catch (e) {
  await capture(browser, shots, 'composer-menus', problems)
  throw e
} finally {
  await done()
}
