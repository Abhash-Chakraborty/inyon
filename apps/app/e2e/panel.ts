// bun apps/app/e2e/panel.ts — the session's side panel in the built app (apps/app/dist) behind the
// stand-in hub (hub.ts), at phone and desktop sizes in light and dark. From 1180px the panel sits
// beside the chat with Changes (this chat's edits with comments on diff lines, and git's working
// tree with Commit all and Push), Files and the file viewer, Activity (queued messages, subagents,
// background tasks, monitors, artifacts, Stop and their sheets) and Usage, and the header
// shows and hides it, remembered across a reload. Its left edge drags it wider or narrower (never
// under 340px, never leaving the chat under 420px), the sidebar folds to a rail of icons, and both
// are kept. On a phone the header's Activity button opens
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
        check(names.map((n) => n.replace(/\d+$/, '')).join(',') === 'Changes,Files,Activity,Usage', `${tag}: the tabs read Changes, Files, Activity, Preview, Usage (${names})`)
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

        // ---- its left edge drags it wider or narrower ----
        const handle = panel(page).getByRole('separator', { name: 'Resize the side panel' })
        const width = () => panel(page).evaluate((p) => Math.round(p.getBoundingClientRect().width))
        const chat = () => page.locator('.session-body > .session-view').evaluate((c) => Math.round(c.getBoundingClientRect().width))
        const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('inyon.settings.v2') ?? '{}') as { panelWidth?: number; sidebar?: boolean })
        // the handle's box once it has held still: while the panel settles (it slides in, or a width
        // just changed) the handle moves, and a press aimed at where it was misses it
        const still = async () => {
          let b = (await handle.boundingBox())!
          for (let i = 0; i < 40; i++) {
            await page.waitForTimeout(50)
            const n = (await handle.boundingBox())!
            if (n.x === b.x && n.width === b.width) return n
            b = n
          }
          return b
        }
        const drag = async (to: number, during?: () => Promise<void>) => {
          const b = await still()
          await page.mouse.move(b.x + b.width / 2, 400)
          await page.mouse.down()
          // the press took before the pointer moves on
          await until(async () => (await handle.getAttribute('data-dragging')) === 'true', 3000)
          await page.mouse.move(to, 420, { steps: 5 })
          await during?.()
          await page.mouse.up()
        }
        const edge = async () => Math.round((await panel(page).boundingBox())!.x)
        check((await width()) === 420, `${tag}: the panel comes 420px wide (${await width()})`)
        const row = (await width()) + (await chat())
        await drag((await edge()) - 100, async () => {
          check(await page.evaluate(() => document.documentElement.classList.contains('resizing')), `${tag}: nothing is selected while it's dragged`)
          check((await handle.getAttribute('data-dragging')) === 'true', `${tag}: and the handle shows it`)
          check((await saved()).panelWidth !== 520, `${tag}: the width is kept on letting go, not before`)
        })
        check(await until(async () => (await width()) === 520), `${tag}: dragging its edge 100px left makes it 520px (${await width()})`)
        check((await saved()).panelWidth === 520, `${tag}: and the app keeps that (${JSON.stringify(await saved())})`)
        check(!(await page.evaluate(() => document.documentElement.classList.contains('resizing'))), `${tag}: the page selects again afterwards`)
        check((await handle.getAttribute('aria-valuenow')) === '520', `${tag}: the handle says how wide (${await handle.getAttribute('aria-valuenow')})`)
        await page.screenshot({ path: path.join(shots, `panel-wide-${tag}.png`) })
        // a drag begun while the panel is still sliding in (8px to the right of its place) lands on
        // the same width: the edge is the row's, not the moving panel's
        await handle.dblclick()
        check(await until(async () => (await width()) === 420), `${tag}: back at 420px before the next drag (${await width()})`)
        const e0 = await edge()
        await panel(page).evaluate((p) => ((p as HTMLElement).style.transform = 'translateX(8px)'))
        check(await until(async () => (await edge()) === e0 + 8), `${tag}: the panel stands 8px off its place for the next drag (${await edge()} from ${e0})`)
        await drag(e0 - 100)
        await panel(page).evaluate((p) => ((p as HTMLElement).style.transform = ''))
        check(await until(async () => (await width()) === 520), `${tag}: a drag begun mid-slide still makes it 520px (${await width()})`)
        await drag(40)
        check(await until(async () => (await width()) === row - 420), `${tag}: it never leaves the chat under 420px (${await width()} of ${row})`)
        check((await chat()) === 420, `${tag}: the chat keeps 420px (${await chat()})`)
        check((await handle.getAttribute('aria-valuemax')) === String(row - 420), `${tag}: which is the handle's most (${await handle.getAttribute('aria-valuemax')})`)
        await drag(w - 20)
        check(await until(async () => (await width()) === 340), `${tag}: nor goes under 340px itself (${await width()})`)
        await handle.focus()
        await page.keyboard.press('ArrowLeft')
        check(await until(async () => (await width()) === 364), `${tag}: Left on the handle makes it a step wider (${await width()})`)
        await page.keyboard.press('ArrowRight')
        check(await until(async () => (await width()) === 340), `${tag}: Right a step narrower (${await width()})`)
        await page.keyboard.press('ArrowLeft')
        await page.keyboard.press('ArrowLeft')
        check(await until(async () => (await width()) === 388), `${tag}: two steps make 388px (${await width()})`)
        await page.reload()
        await page.getByText('All 20 runs pass now.').first().waitFor()
        check(await until(async () => (await width()) === 388), `${tag}: the width is there after a reload (${await width()})`)
        await handle.dblclick()
        check(await until(async () => (await width()) === 420), `${tag}: a double click puts the usual width back (${await width()})`)
        check((await saved()).panelWidth === 0, `${tag}: and forgets the other`)
        await handle.focus()
        await page.keyboard.press('ArrowLeft')
        await page.keyboard.press('Home')
        check(await until(async () => (await width()) === 420), `${tag}: as does Home (${await width()})`)

        // ---- the sidebar folds to a rail ----
        const side = page.locator('aside[data-sidebar]')
        const sideWidth = () => side.evaluate((s) => Math.round(s.getBoundingClientRect().width))
        check((await side.getAttribute('data-sidebar')) === 'open' && (await sideWidth()) === 264, `${tag}: the sidebar starts open (${await sideWidth()})`)
        const chatBefore = await chat()
        await side.getByRole('button', { name: 'Hide sidebar' }).click()
        check(await until(async () => (await side.getAttribute('data-sidebar')) === 'rail'), `${tag}: Hide sidebar folds it`)
        check((await sideWidth()) === 60, `${tag}: to a 60px rail (${await sideWidth()})`)
        check((await chat()) === chatBefore + 204, `${tag}: and the chat takes the room (${await chat()} from ${chatBefore})`)
        check(!(await side.getByRole('list', { name: 'Sessions' }).count()), `${tag}: the session list waits for it to open`)
        const rail = await side.locator('a, button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
        check(rail.join('|') === 'Show sidebar|Search or jump to…|New session|Overview|Machines|Blueprints|Settings', `${tag}: the rail's icons are named (${rail})`)
        check((await side.locator('a, button').evaluateAll((els) => els.filter((e) => !e.getAttribute('title')).length)) === 0, `${tag}: and each has its tooltip`)
        await page.waitForTimeout(250)
        await page.screenshot({ path: path.join(shots, `panel-rail-${tag}.png`) })
        await layout(page, `${tag} rail`)
        await side.getByRole('button', { name: 'Search or jump to…' }).click()
        check(await page.getByRole('dialog').waitFor({ timeout: 3000 }).then(() => true, () => false), `${tag}: the rail's search opens Quick access`)
        await page.keyboard.press('Escape')
        check(await until(async () => !(await page.getByRole('dialog').count())), `${tag}: and Esc closes it`)
        check((await saved()).sidebar === false, `${tag}: the fold is kept`)
        await page.reload()
        await page.getByText('All 20 runs pass now.').first().waitFor()
        check((await side.getAttribute('data-sidebar')) === 'rail', `${tag}: and there after a reload`)
        await page.locator('.session-head').click({ position: { x: 300, y: 8 } })
        await page.keyboard.press('Control+b')
        check(await until(async () => (await side.getAttribute('data-sidebar')) === 'open'), `${tag}: Ctrl B opens it`)
        check(await side.getByRole('list', { name: 'Sessions' }).first().isVisible(), `${tag}: with its sessions`)
        await box(page).focus()
        await page.keyboard.press('Control+b')
        check(await until(async () => (await side.getAttribute('data-sidebar')) === 'rail'), `${tag}: and folds it, from the message box too`)
        await page.locator('.session-head').click({ button: 'right', position: { x: 300, y: 8 } })
        await page.locator('.menu .menu-item', { hasText: 'Show sidebar' }).click()
        check(await until(async () => (await side.getAttribute('data-sidebar')) === 'open'), `${tag}: Show sidebar in the page menu opens it`)
        await side.getByRole('button', { name: 'Hide sidebar' }).focus()
        check(await side.getByRole('button', { name: 'Hide sidebar' }).evaluate((b) => b.getAttribute('aria-expanded') === 'true'), `${tag}: the fold button says it's open`)
      } else {
        // ---- the phone: the Activity button and its sheet ----
        check(!(await panel(page).count()), `${tag}: no side panel on a phone`)
        check(!(await page.getByRole('button', { name: /side panel/ }).isVisible()), `${tag}: nor its toggle`)
        await page.keyboard.press('Control+b')
        check(await page.evaluate(() => JSON.parse(localStorage.getItem('inyon.settings.v2') ?? '{}').sidebar !== false), `${tag}: Ctrl B folds nothing on a phone`)
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
