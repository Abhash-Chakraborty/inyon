// bun apps/app/e2e/panel.ts — the session's side panel in the built app (apps/app/dist) behind the
// stand-in hub (hub.ts), at phone and desktop sizes in light and dark. From 1180px the panel sits
// beside the chat with Changes (this chat's edits with comments on diff lines, and git's working
// tree with Commit all and Push), Files and the file viewer, Activity (queued messages, subagents,
// background tasks, monitors, artifacts, Stop and their sheets), Preview and Usage, and the header
// shows and hides it, remembered across a reload. On a phone the header's Activity button opens
// the same bodies in a sheet. With the React app built (apps/web/dist) it draws the same screens
// there for comparison. Screenshots go to $SHOTS (default: a temp folder). CHROME picks the browser.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from 'playwright'
import { base, check, finish, hasReact, launch, layout, open, resetChats, SIZES, state, streams, until } from './hub.ts'

const shots = process.env.SHOTS ?? path.join(tmpdir(), 'inyon-app-shots')
mkdirSync(shots, { recursive: true })
const browser = await launch()
const done = finish(browser)

const ROOT = '/home/sam/code/storefront'
const seen = { commits: [] as string[], pushes: 0, stops: [] as unknown[], outputs: 0 }
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })
const hunk = { oldStart: 12, oldLines: 3, newStart: 12, newLines: 3, lines: [' import { applyDiscount } from "./discount"', '-export function total(cart: Cart) {', '+export async function total(cart: Cart) {', ' '] }
state.routes.push((req, url) => {
  const p = url.pathname
  const pane = '/api/hosts/local/panes/11'
  if (p === `${pane}/git`)
    return json({ repo: true, root: ROOT, remote: true, branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, files: [{ path: 'src/checkout/total.ts', status: 'M', add: 2, del: 2 }, { path: 'notes/race.md', status: '?', add: 0, del: 0 }] })
  if (p === `${pane}/git/diff`) return json({ path: url.searchParams.get('path'), binary: false, hunks: url.searchParams.get('path') === 'notes/race.md' ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+# The race'] }] : [hunk] })
  if (p === `${pane}/git/commit` && req.method === 'POST') return req.json().then((b: { message: string }) => (seen.commits.push(b.message), json({ commit: 'abc1234' })))
  if (p === `${pane}/git/push` && req.method === 'POST') return (seen.pushes++, json({ ok: true }))
  if (p === `${pane}/dir`) {
    const at = url.searchParams.get('path') ?? ''
    const entries = at === 'src' ? [{ name: 'checkout', dir: true, size: 0, mtime: 0 }, { name: 'index.ts', dir: false, size: 812, mtime: 0 }] : [{ name: 'src', dir: true, size: 0, mtime: 0 }, { name: '.gitignore', dir: false, size: 40, mtime: 0 }, { name: 'README.md', dir: false, size: 2048, mtime: 0 }, { name: 'package.json', dir: false, size: 1300, mtime: 0 }]
    return json({ cwd: ROOT, path: at, entries })
  }
  if (p === `${pane}/file`) {
    const f = url.searchParams.get('path')
    if (f === 'README.md') return json({ kind: 'text', path: f, text: '# Storefront\n\nThe shop, its **cart** and checkout.\n', size: 2048, truncated: false })
    return json({ kind: 'text', path: f, text: 'export { total } from "./checkout/total"\n', size: 812, truncated: false })
  }
  if (p === '/api/hosts/local/tasks/stop') return req.json().then((b) => (seen.stops.push(b), json({ stopped: true, detail: '' })))
  if (p === '/api/hosts/local/task-output') return (seen.outputs++, json({ path: '/tmp/out', output: 'vite v6 dev server\n  ➜  Local: http://localhost:5173/\n' }))
  if (p === '/api/hosts/local/subagents') return json([{ agentId: 'a1', toolUseId: 'sa1', description: 'Find every caller of total()', path: '/tmp/sa1.jsonl' }])
  if (p === '/api/hosts/local/transcript')
    return json([
      { kind: 'user', seq: 1, uuid: 'su1', ts: new Date().toISOString(), text: 'Find every caller of total()', images: 0 },
      { kind: 'assistant', seq: 2, uuid: 'sa2', ts: new Date().toISOString(), msgId: 'm1', block: { type: 'text', text: 'Two callers: cart.ts and summary.ts. Both await it already.' } },
    ])
  return undefined
})

/** The storefront chat with running work, an artifact, a written file and a dev server mentioned. */
function seed() {
  resetChats()
  const s = streams.get('local:%11')!
  const ts = new Date(Date.now() - 120_000).toISOString()
  s.items.push(
    { kind: 'assistant', seq: 2000, uuid: 'w1', ts, msgId: 'mw', block: { type: 'tool_use', id: 'tw', name: 'Write', input: { file_path: `${ROOT}/notes/race.md`, content: '# The race\n\ntotal() read the cart too early.' } } },
    { kind: 'tool_result', seq: 2001, uuid: 'w2', ts, toolUseId: 'tw', isError: false, text: 'File created', meta: { created: true } },
    { kind: 'assistant', seq: 2002, uuid: 'w3', ts, msgId: 'mw2', block: { type: 'text', text: 'The dev server is up on http://localhost:5173/ if you want to look.' } },
  )
  const info = s.state.info as Record<string, unknown>
  Object.assign(info, {
    transcriptPath: '/tmp/session.jsonl',
    queue: ['Then update the changelog'],
    tasks: [
      { id: 'b1', type: 'shell', description: 'Dev server', command: 'bun run dev', status: 'running', outputFile: '/tmp/out', startedAt: new Date(Date.now() - 300_000).toISOString() },
      { id: 'b2', type: 'monitor', description: 'Watch CI', status: 'completed', startedAt: new Date(Date.now() - 900_000).toISOString() },
    ],
    subagents: [{ toolUseId: 'sa1', type: 'Explore', description: 'Find every caller of total()', status: 'done', startedAt: new Date(Date.now() - 200_000).toISOString() }],
    artifacts: [{ url: 'https://claude.ai/public/artifacts/abc', title: 'Checkout flow', updatedAt: new Date(Date.now() - 600_000).toISOString() }],
    gitBranch: 'main',
    sessionId: '6f1c2a90-session',
  })
}

const panel = (page: Page) => page.locator('aside[aria-label="Side panel"]')
const tab = (page: Page, name: string) => panel(page).getByRole('tab', { name })
const box = (page: Page) => page.locator('#composer-input')

for (const [w, h] of SIZES)
  for (const scheme of ['light', 'dark'] as const) {
    const tag = `${w}-${scheme}`
    const phone = w < 600
    seed()
    const { page } = await open(browser, w, h, scheme)
    try {
      await page.goto(`${base}/next/m/local/p/11`)
      await page.getByText('All 20 runs pass now.').first().waitFor()
      if (!phone) {
        // ---- beside the chat, on its Changes tab ----
        check(await panel(page).isVisible(), `${tag}: the side panel is beside the chat`)
        const names = await panel(page).getByRole('tab').allTextContents()
        check(names.map((n) => n.replace(/\d+$/, '')).join(',') === 'Changes,Files,Activity,Preview,Usage', `${tag}: the tabs read Changes, Files, Activity, Preview, Usage (${names})`)
        check((await tab(page, 'Changes').textContent())?.includes('2'), `${tag}: Changes counts the two files this chat edited`)
        check((await tab(page, 'Activity').textContent())?.includes('1'), `${tag}: Activity counts the one task running`)
        check(await panel(page).getByText('total.ts').first().isVisible(), `${tag}: the edited file is listed`)
        check(await panel(page).getByText('Created').isVisible() || (await panel(page).getByText('race.md').count()) > 0, `${tag}: the written file is listed`)
        await page.screenshot({ path: path.join(shots, `panel-changes-${tag}.png`) })
        // a comment on a diff line goes into the message box with the others
        await panel(page).getByText('race.md').first().click()
        await panel(page).getByRole('button', { name: /^Comment on line 1$/ }).click()
        const sheet = page.getByRole('dialog')
        check(await sheet.getByText('race.md, line 1').isVisible(), `${tag}: the comment sheet names the file and line`)
        await sheet.getByLabel('Comment').fill('Say which callers were affected')
        await page.screenshot({ path: path.join(shots, `panel-comment-${tag}.png`) })
        await sheet.getByRole('button', { name: 'Save comment' }).click()
        check(await panel(page).getByText('1 comment').waitFor({ timeout: 3000 }).then(() => true, () => false), `${tag}: the comment waits under the diff`)
        check(await panel(page).getByRole('button', { name: /^Comment on line 1$/ }).evaluate((b) => b.classList.contains('diff-no-on')), `${tag}: its line is marked`)
        await panel(page).getByRole('button', { name: 'Add to message' }).click()
        check(await until(async () => /Comments on your changes:[\s\S]*notes\/race\.md:1[\s\S]*Say which callers/.test(await box(page).inputValue())), `${tag}: Add to message puts the comments in the box`)
        check(!(await panel(page).getByText('1 comment').count()), `${tag}: the comments leave the bar once added`)
        await box(page).fill('')

        // ---- the working tree ----
        await panel(page).getByRole('radio', { name: 'Working tree' }).click()
        await panel(page).getByText('main', { exact: true }).waitFor()
        check(await panel(page).getByTitle('1 commits not pushed').isVisible(), `${tag}: the tree shows the commit not pushed`)
        check(await panel(page).getByRole('button', { name: 'Comment on removed line 13' }).waitFor({ timeout: 3000 }).then(() => true, () => false), `${tag}: the tree's diff numbers a removed line in the old file`)
        check(await panel(page).getByText('U', { exact: true }).isVisible(), `${tag}: a file git doesn't track reads U`)
        await page.screenshot({ path: path.join(shots, `panel-tree-${tag}.png`) })
        await panel(page).getByLabel('Commit message').fill('Wait for the discount in total()')
        await panel(page).getByRole('button', { name: 'Commit all' }).click()
        check(await page.getByText('Committed abc1234').waitFor({ timeout: 3000 }).then(() => true, () => false), `${tag}: Commit all says what it committed`)
        check(seen.commits.at(-1) === 'Wait for the discount in total()', `${tag}: the commit carries its message`)
        await panel(page).getByRole('button', { name: 'Push' }).click()
        check(await page.getByText('Pushed', { exact: true }).waitFor({ timeout: 3000 }).then(() => true, () => false), `${tag}: Push says it pushed`)
        // the choice of view is remembered
        check((await page.evaluate(() => localStorage.getItem('inyon.changes'))) === 'tree', `${tag}: the tree is remembered as the Changes view`)
        await panel(page).getByRole('radio', { name: 'This chat' }).click()

        // ---- files ----
        await tab(page, 'Files').click()
        await panel(page).getByText('README.md').waitFor()
        check(await panel(page).getByText('2 KB').isVisible(), `${tag}: files show their size`)
        await panel(page).getByRole('button', { name: /^src$/ }).first().click()
        await panel(page).getByText('index.ts').waitFor()
        check(await panel(page).getByRole('button', { name: 'storefront' }).isVisible(), `${tag}: the breadcrumbs lead back to the folder`)
        await page.screenshot({ path: path.join(shots, `panel-files-${tag}.png`) })
        await panel(page).getByText('index.ts').click()
        await panel(page).getByText('export { total }').waitFor()
        await panel(page).getByRole('button', { name: 'Mention' }).click()
        check(await until(async () => (await box(page).inputValue()) === '@src/index.ts'), `${tag}: Mention puts @path in the box`)
        await box(page).fill('')
        await panel(page).getByRole('button', { name: 'Back to the folder' }).click()
        await panel(page).getByRole('button', { name: 'storefront' }).click()
        await panel(page).getByText('README.md').click()
        check(await panel(page).getByRole('heading', { name: 'Storefront' }).waitFor({ timeout: 3000 }).then(() => true, () => false), `${tag}: Markdown is drawn`)
        await panel(page).getByRole('button', { name: 'Source' }).click()
        check(await panel(page).getByText('# Storefront').isVisible(), `${tag}: Source shows the Markdown as written`)
        await page.screenshot({ path: path.join(shots, `panel-file-${tag}.png`) })
        // the right-click menu
        await panel(page).getByRole('button', { name: 'Back to the folder' }).click()
        await panel(page).getByText('package.json').click({ button: 'right' })
        check(await page.getByRole('menuitem', { name: 'Mention in message' }).isVisible(), `${tag}: a file's menu offers Mention in message`)
        check(await page.getByRole('menuitem', { name: 'Copy path' }).isVisible(), `${tag}: and Copy path`)
        await page.keyboard.press('Escape')

        // ---- activity ----
        await tab(page, 'Activity').click()
        for (const g of ['Queued messages', 'Subagents', 'Background tasks', 'Monitors', 'Artifacts']) check(await panel(page).getByRole('heading', { name: g }).isVisible(), `${tag}: Activity has ${g}`)
        check(await panel(page).getByText(/^Running · 5m/).isVisible(), `${tag}: a running task says for how long`)
        await page.screenshot({ path: path.join(shots, `panel-activity-${tag}.png`) })
        await panel(page).getByRole('button', { name: 'Stop' }).click()
        check(await page.getByText('Task stopped').waitFor({ timeout: 3000 }).then(() => true, () => false), `${tag}: Stop says the task stopped`)
        check(JSON.stringify(seen.stops.at(-1)) === '{"id":"b1","path":"/tmp/out"}', `${tag}: Stop names the task and its output (${JSON.stringify(seen.stops.at(-1))})`)
        await panel(page).getByRole('button', { name: /Dev server/ }).click()
        const out = page.getByRole('dialog')
        check(await out.getByText('bun run dev').isVisible(), `${tag}: the task sheet shows its command`)
        check(await out.getByText('vite v6 dev server').waitFor({ timeout: 3000 }).then(() => true, () => false), `${tag}: and its output`)
        check(await out.getByText('Live · refreshes every 3 seconds').isVisible(), `${tag}: a running task's output stays live`)
        const before = seen.outputs
        check(await until(() => seen.outputs > before, 5000), `${tag}: and is read again while open`)
        await page.screenshot({ path: path.join(shots, `panel-task-${tag}.png`) })
        await page.keyboard.press('Escape')
        await out.waitFor({ state: 'hidden' })
        await panel(page).getByRole('button', { name: /Find every caller/ }).click()
        check(await page.getByRole('dialog').getByText('Two callers: cart.ts and summary.ts.').waitFor({ timeout: 3000 }).then(() => true, () => false), `${tag}: a subagent's sheet shows its own conversation`)
        await page.keyboard.press('Escape')
        await page.getByRole('dialog').waitFor({ state: 'hidden' })

        // ---- preview ----
        await tab(page, 'Preview').click()
        check(await panel(page).getByText('Preview a dev server').isVisible(), `${tag}: Preview starts empty`)
        await panel(page).getByRole('button', { name: '127.0.0.1:5173' }).click()
        check(await panel(page).locator('iframe[title="Preview"]').getAttribute('src') === 'http://127.0.0.1:5173', `${tag}: a suggestion from the chat opens in the frame`)
        await panel(page).getByLabel('Preview address').fill(base)
        await panel(page).getByLabel('Preview address').press('Enter')
        check(await panel(page).getByText('Not shown here').isVisible(), `${tag}: Inyon's own address is refused`)
        await page.waitForTimeout(400)
        await page.screenshot({ path: path.join(shots, `panel-preview-${tag}.png`) })
        await panel(page).getByLabel('Preview address').fill('')
        await panel(page).getByLabel('Preview address').press('Enter')

        // ---- usage ----
        await tab(page, 'Usage').click()
        check(await panel(page).getByText('Context window').isVisible(), `${tag}: Usage shows the context window`)
        check(await panel(page).getByText('61k / 1M').isVisible(), `${tag}: with what's used of it`)
        check(await panel(page).getByText(ROOT).isVisible(), `${tag}: and the session's folder`)
        await page.screenshot({ path: path.join(shots, `panel-usage-${tag}.png`) })
        await layout(page, `${tag} panel`)

        // ---- the keyboard along the tabs ----
        await tab(page, 'Usage').focus()
        await page.keyboard.press('Home')
        check(await tab(page, 'Changes').evaluate((t) => t === document.activeElement && t.getAttribute('aria-selected') === 'true'), `${tag}: Home goes to the first tab`)
        await page.keyboard.press('ArrowLeft')
        check(await tab(page, 'Usage').evaluate((t) => t === document.activeElement), `${tag}: Left from the first wraps to the last`)

        // ---- hidden, and remembered ----
        await page.getByRole('button', { name: 'Hide side panel' }).click()
        check(await until(async () => !(await panel(page).count())), `${tag}: Hide side panel takes it away`)
        await page.reload()
        await page.getByText('All 20 runs pass now.').first().waitFor()
        await page.waitForTimeout(500)
        check(!(await panel(page).count()), `${tag}: it stays hidden after a reload`)
        await page.getByRole('button', { name: 'Show side panel' }).click()
        check(await panel(page).waitFor({ timeout: 3000 }).then(() => true, () => false), `${tag}: Show side panel brings it back`)
        check(!(await page.getByRole('button', { name: 'Running tasks, subagents and changes' }).isVisible()), `${tag}: the Activity button is for narrow screens`)
      } else {
        // ---- the phone: the Activity button and its sheet ----
        check(!(await panel(page).count()), `${tag}: no side panel on a phone`)
        check(!(await page.getByRole('button', { name: /side panel/ }).isVisible()), `${tag}: nor its toggle`)
        const act = page.getByRole('button', { name: 'Running tasks, subagents and changes' })
        check((await act.textContent())?.includes('1'), `${tag}: the Activity button counts what's running`)
        await act.click()
        const sheet = page.getByRole('dialog')
        await sheet.getByRole('heading', { name: 'Subagents' }).waitFor()
        check(await sheet.getByRole('radio', { name: 'Running' }).getAttribute('aria-checked') === 'true', `${tag}: the sheet opens on Running`)
        await page.screenshot({ path: path.join(shots, `panel-sheet-${tag}.png`) })
        await sheet.getByRole('radio', { name: 'Changes' }).click()
        check(await sheet.getByText('total.ts').first().waitFor({ timeout: 3000 }).then(() => true, () => false), `${tag}: Changes lists the edits`)
        await page.screenshot({ path: path.join(shots, `panel-sheet-changes-${tag}.png`) })
        await sheet.getByRole('radio', { name: 'Files' }).click()
        await sheet.getByText('package.json').click()
        await sheet.getByRole('button', { name: 'Mention' }).click()
        check(await until(async () => !(await page.getByRole('dialog').count())), `${tag}: Mention closes the sheet`)
        check(await until(async () => (await box(page).inputValue()) === '@package.json'), `${tag}: and puts @path in the box`)
        await layout(page, `${tag} sheet`)
      }
    } catch (e) {
      check(false, `${tag}: ${(e as Error).message.split('\n')[0]}`)
      await page.screenshot({ path: path.join(shots, `panel-failed-${tag}.png`) }).catch(() => {})
    } finally {
      await page.context().close()
    }
  }

// the web app's panel at the same moments, for comparison
if (hasReact)
  for (const [w, h] of SIZES)
    for (const scheme of ['light', 'dark'] as const) {
      const tag = `${w}-${scheme}`
      seed()
      const { page } = await open(browser, w, h, scheme)
      try {
        await page.goto(`${base}/m/local/p/11`)
        await page.getByText('All 20 runs pass now.').first().waitFor({ timeout: 10000 })
        await page.waitForTimeout(800)
        // the stand-in hub's build differs from the page's, so the web app offers a reload
        const later = page.getByRole('button', { name: 'Not now' })
        if (await later.isVisible()) await later.click()
        if (w >= 1180) {
          await page.screenshot({ path: path.join(shots, `react-panel-changes-${tag}.png`) })
          for (const t of ['Activity', 'Usage']) {
            await page.getByRole('tab', { name: t }).click()
            await page.waitForTimeout(400)
            await page.screenshot({ path: path.join(shots, `react-panel-${t.toLowerCase()}-${tag}.png`) })
          }
        } else {
          await page.getByRole('button', { name: 'Running tasks, subagents and changes' }).click()
          await page.waitForTimeout(600)
          await page.screenshot({ path: path.join(shots, `react-panel-sheet-${tag}.png`) })
        }
      } catch (e) {
        console.error(`react ${tag}: ${(e as Error).message.split('\n')[0]}`)
        await page.screenshot({ path: path.join(shots, `react-failed-${tag}.png`) }).catch(() => {})
      } finally {
        await page.context().close()
      }
    }

await done()
