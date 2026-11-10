// bun apps/app/e2e/menus.ts — right-click menus, layers and the back button in the built app
// (apps/app/dist) behind the stand-in hub (hub.ts), at phone and desktop sizes in light and dark:
// copy items say so, a text box gets Cut, Copy, Paste and Select all, a link Open and Copy link,
// selected text puts Copy first, Shift and data-native-menu keep the browser's menu, a right click
// elsewhere opens that thing's menu, the page menu has Back and Reload, menus stay on the screen
// as it changes size, a long press buzzes, and back (and Esc with the focus anywhere) closes a
// picker, then its sheet, a menu, Quick access and the selection before going back a page.
// Screenshots go to $SHOTS (default: a temp folder). CHROME=/path/to/chrome picks the browser.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from 'playwright'
import { base, check, finish, launch, layout, open, resetChats, SIZES, until } from './hub.ts'
import { capture } from './failure.ts'

const shots = process.env.SHOTS ?? path.join(tmpdir(), 'inyon-app-shots')
mkdirSync(shots, { recursive: true })
const browser = await launch()
const done = finish(browser)

const menu = (page: Page) => page.locator('.menu').first()
const items = (page: Page) => page.locator('.menu').first().locator('.menu-item .menu-words').evaluateAll((els) => els.map((e) => e.firstChild?.textContent?.trim() ?? e.textContent?.trim() ?? ''))
const keys = (page: Page) => page.locator('.menu').first().locator('.menu-keys').allTextContents()
const gone = (page: Page) => until(async () => (await page.locator('.menu').count()) === 0, 3000)
const toast = (page: Page, text: string) => until(async () => (await page.locator('.toast', { hasText: text }).count()) > 0, 4000)
const path_ = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search

/** The menu sits wholly inside the window. */
async function onScreen(page: Page, h: number, w: number) {
  const b = (await menu(page).boundingBox())!
  return b.y >= 0 && b.y + b.height <= h && b.x >= 0 && b.x + b.width <= w
}

try {
  for (const [w, h] of SIZES)
    for (const scheme of ['light', 'dark'] as const) {
      const label = `menus ${w}x${h} ${scheme}`
      const phone = w < 600
      resetChats()
      const { ctx, page } = await open(browser, w, h, scheme)
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
      // the buzzes a long press asks for
      await ctx.addInitScript(() => {
        const w = window as unknown as { buzzes: unknown[] }
        w.buzzes = []
        Object.defineProperty(navigator, 'vibrate', { value: (p: unknown) => (w.buzzes.push(p), true), configurable: true })
      })
      await page.goto(`${base}/next/`)
      await page.locator('.card').nth(3).waitFor()
      await page.goto(`${base}/next/m/local/p/11`)
      await page.getByText('All 20 runs pass now.').waitFor()
      // one message by its words: older ones load in above it as the chat settles
      const bubble = page.locator('.bubble', { hasText: 'Nice. Run the whole suite once more before you commit.' })
      await bubble.waitFor()
      await bubble.scrollIntoViewIfNeeded()

      // ---- copy items say so ----
      await bubble.click({ button: 'right' })
      await menu(page).waitFor()
      check((await items(page)).join('|') === 'Copy message', `${label}: a message's menu (${await items(page)})`)
      await page.locator('.menu .menu-item', { hasText: 'Copy message' }).click()
      check(await toast(page, 'Message copied'), `${label}: "Message copied"`)
      const said = (await bubble.innerText()).trim()
      const got = (await page.evaluate(() => navigator.clipboard.readText())).trim()
      check(got === said, `${label}: the message is on the clipboard (${JSON.stringify(got.slice(0, 60))} vs ${JSON.stringify(said.slice(0, 60))})`)
      // a toast dragged a little and let go springs back; dragged far, it goes
      if (phone) {
        const swipe = (dx: number, up: boolean) =>
          page.locator('.toast').first().evaluate(
            (t, [dx, up]) => {
              const r = t.getBoundingClientRect()
              const at = (type: string, x: number) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: r.x + 20 + x, clientY: r.y + 10 }))
              at('pointerdown', 0)
              at('pointermove', (dx as number) / 2)
              at('pointermove', dx as number)
              if (up) at('pointerup', dx as number)
            },
            [dx, up] as const,
          )
        const moved = () => page.locator('.toast').first().evaluate((t) => t.style.transform)
        await swipe(40, false)
        check(await until(async () => (await moved()) === 'translate(40px, 0px)'), `${label}: a toast follows the finger (${await moved()})`)
        await page.locator('.toast').first().dispatchEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: 60, clientY: 10 })
        check(await until(async () => (await moved()) === ''), `${label}: and let go short of a fling, it goes back (${await moved()})`)
        check((await page.locator('.toast').first().evaluate((t) => t.style.opacity + t.style.transition)) === '', `${label}: with nothing of the drag left on it`)
        await swipe(120, true)
        check(await until(async () => !(await page.locator('.toast', { hasText: 'Message copied' }).count()), 3000), `${label}: a fling sends it away`)
      }
      // the toast out of the way of what's clicked next
      await page.locator('.toast').first().waitFor({ state: 'detached', timeout: 10000 }).catch(() => {})

      // ---- selected text puts Copy first ----
      const at = await bubble.evaluate((el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        let n = walker.nextNode()
        while (n && (n.textContent ?? '').trim().length < 4) n = walker.nextNode()
        const r = document.createRange()
        r.setStart(n!, 0)
        r.setEnd(n!, 4)
        const sel = getSelection()!
        sel.removeAllRanges()
        sel.addRange(r)
        const b = r.getBoundingClientRect()
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
      })
      await page.mouse.click(at.x, at.y, { button: 'right' })
      await menu(page).waitFor()
      check((await items(page)).join('|') === 'Copy|Copy message', `${label}: Copy first while text is selected (${await items(page)})`)
      if (!phone && scheme === 'light') await page.screenshot({ path: path.join(shots, 'menus-copy-first-1440-light.png') })

      // ---- a right click elsewhere opens that thing's menu: here, the text box's ----
      const box = page.locator('textarea').first()
      const boxAt = (await box.boundingBox())!
      await page.mouse.click(boxAt.x + 20, boxAt.y + boxAt.height / 2, { button: 'right' })
      check(await until(async () => (await items(page)).join('|') === 'Cut|Copy|Paste|Select all'), `${label}: a right click on the text box swaps the menu (${await items(page)})`)
      await page.keyboard.press('Escape')
      await gone(page)
      await page.evaluate(() => getSelection()?.removeAllRanges())

      // ---- the text box menu ----
      await box.fill('hello world')
      await box.click({ button: 'right' })
      await menu(page).waitFor()
      check((await items(page)).join('|') === 'Cut|Copy|Paste|Select all', `${label}: the text box menu (${await items(page)})`)
      check((await keys(page)).join('|') === 'Ctrl X|Ctrl C|Ctrl V|Ctrl A', `${label}: with its keys (${await keys(page)})`)
      check(await page.locator('.menu .menu-item', { hasText: 'Cut' }).isDisabled(), `${label}: nothing selected, nothing to cut`)
      // the menu sits over the text box at the bottom of the screen, wholly on it
      check(await onScreen(page, h, w), `${label}: the text box menu is on the screen (${JSON.stringify(await menu(page).boundingBox())})`)
      if (scheme === 'light') await page.screenshot({ path: path.join(shots, `menus-text-box-${w}-light.png`) })
      await page.locator('.menu .menu-item', { hasText: 'Select all' }).click()
      check(await until(() => box.evaluate((t: HTMLTextAreaElement) => t.selectionStart === 0 && t.selectionEnd === 11 && document.activeElement === t)), `${label}: Select all selects the box`)
      await box.click({ button: 'right' })
      await page.locator('.menu .menu-item', { hasText: 'Cut' }).click()
      check(await until(async () => (await box.inputValue()) === ''), `${label}: Cut empties the box`)
      check(await until(async () => (await page.evaluate(() => navigator.clipboard.readText())) === 'hello world'), `${label}: and puts it on the clipboard`)
      await box.click({ button: 'right' })
      await page.locator('.menu .menu-item', { hasText: 'Paste' }).click()
      check(await until(async () => (await box.inputValue()) === 'hello world'), `${label}: Paste types it back (${await box.inputValue()})`)
      // a browser that won't let the page read the clipboard: the keys still work
      await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'readText', { value: () => Promise.reject(new Error('blocked')), configurable: true }))
      await box.click({ button: 'right' })
      await page.locator('.menu .menu-item', { hasText: 'Paste' }).click()
      check(await toast(page, 'Press Ctrl V to paste'), `${label}: "Press Ctrl V to paste"`)
      check(await page.locator('.toast', { hasText: "This browser doesn't let the menu read the clipboard." }).count() > 0, `${label}: and why`)
      await box.fill('')

      // ---- Shift, and data-native-menu, keep the browser's menu ----
      await page.keyboard.down('Shift')
      await bubble.click({ button: 'right' })
      await page.keyboard.up('Shift')
      await page.waitForTimeout(200)
      check((await page.locator('.menu').count()) === 0, `${label}: Shift+right click opens no app menu`)
      await bubble.evaluate((el) => el.setAttribute('data-native-menu', ''))
      await bubble.click({ button: 'right' })
      await page.waitForTimeout(200)
      check((await page.locator('.menu').count()) === 0, `${label}: nor a row marked data-native-menu`)
      await bubble.evaluate((el) => el.removeAttribute('data-native-menu'))

      // ---- a copy that fails says so ----
      await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, 'writeText', { value: () => Promise.reject(new Error('blocked')), configurable: true })
        document.execCommand = () => false
      })
      await bubble.click({ button: 'right' })
      await page.locator('.menu .menu-item', { hasText: 'Copy message' }).click()
      check(await toast(page, 'Could not copy'), `${label}: "Could not copy"`)

      // ---- the Overview: links, the page menu, back through layers ----
      await page.goto(`${base}/next/`)
      await page.locator('.card').nth(3).waitFor()
      await page.waitForTimeout(300)
      // a link's menu
      const link = page.locator(phone ? '.tabbar a' : '.sidebar-foot a', { hasText: 'Machines' })
      await link.click({ button: 'right' })
      await menu(page).waitFor()
      check((await items(page)).join('|') === 'Open link|Open in new tab|Copy link', `${label}: a link's menu (${await items(page)})`)
      await page.locator('.menu .menu-item', { hasText: 'Copy link' }).click()
      check(await toast(page, 'Link copied'), `${label}: "Link copied"`)
      check((await page.evaluate(() => navigator.clipboard.readText())) === `${base}/next/machines`, `${label}: the link in full`)
      await link.click({ button: 'right' })
      await page.locator('.menu .menu-item', { hasText: 'Open link' }).click()
      check(await until(() => path_(page) === '/next/machines'), `${label}: Open link goes there (${page.url()})`)
      await page.goBack()
      check(await until(() => path_(page) === '/next/'), `${label}: and back (${page.url()})`)
      await page.locator('.card').nth(3).waitFor()

      // the page menu: Back and Reload first
      await page.locator('.topbar').click({ button: 'right', position: { x: phone ? 200 : 700, y: 8 } })
      await menu(page).waitFor()
      const pageItems = await items(page)
      // the sidebar's fold is a wide screen's
      check(pageItems.join('|') === (phone ? 'Back|Reload|Search…|New session…' : 'Back|Reload|Search…|New session…|Hide sidebar'), `${label}: the page menu (${pageItems})`)
      if (scheme === 'light') await page.screenshot({ path: path.join(shots, `menus-page-${w}-light.png`) })
      await page.keyboard.press('Escape')
      await gone(page)

      // a long press on a phone buzzes as its menu opens
      if (phone) {
        const card = page.locator('.card').first()
        const b = (await card.boundingBox())!
        const cdp = await ctx.newCDPSession(page)
        const pt = { x: b.x + b.width / 2, y: b.y + 40 }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] })
        await page.waitForTimeout(700)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await menu(page).waitFor()
        const buzzes = await page.evaluate(() => (window as unknown as { buzzes: unknown[] }).buzzes)
        check(JSON.stringify(buzzes).includes('[40]'), `${label}: the long press buzzed (${JSON.stringify(buzzes)})`)
        await page.goBack()
        check(await gone(page), `${label}: back closes the long-press menu`)
        check(path_(page) === '/next/', `${label}: and stays on the Overview (${page.url()})`)
      }

      // back closes a row's menu and stays on the screen
      const card = page.locator('.card').nth(1)
      await card.click({ button: 'right' })
      await menu(page).waitFor()
      // the menu moves to stay on a smaller window
      await page.setViewportSize({ width: w, height: 420 })
      check(await until(() => onScreen(page, 420, w)), `${label}: the menu stays on a shorter window (${JSON.stringify(await menu(page).boundingBox())} ${await menu(page).getAttribute('style')} ${await page.evaluate(() => JSON.stringify([innerHeight, visualViewport?.height]))})`)
      await page.setViewportSize({ width: w, height: h })
      await page.goBack()
      check(await gone(page), `${label}: back closes the menu`)
      check(path_(page) === '/next/', `${label}: and stays on the Overview (${page.url()})`)

      // a sheet with a picker open: back closes the picker, then the sheet, then goes back a page
      await page.locator(phone ? '.tab-new' : '.sidebar-start .nav-item').click()
      const sheet = page.getByRole('dialog', { name: 'New session' })
      await sheet.waitFor()
      await sheet.getByRole('button', { name: 'Machine' }).click()
      const picker = phone ? page.getByRole('dialog', { name: 'Machine' }) : page.locator('.select-list')
      await picker.waitFor()
      if (scheme === 'light') await page.screenshot({ path: path.join(shots, `menus-picker-${w}-light.png`) })
      await page.goBack()
      check(await until(async () => (await picker.count()) === 0), `${label}: back closes the picker`)
      check(await sheet.isVisible(), `${label}: and leaves the sheet`)
      await page.goBack()
      check(await until(async () => (await sheet.count()) === 0), `${label}: back closes the sheet`)
      check(path_(page) === '/next/', `${label}: still on the Overview (${page.url()})`)

      // Esc closes a sheet with the focus outside it
      await page.locator(phone ? '.tab-new' : '.sidebar-start .nav-item').click()
      await sheet.waitFor()
      await page.waitForTimeout(100)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.keyboard.press('Escape')
      check(await until(async () => (await sheet.count()) === 0), `${label}: Esc closes the sheet from anywhere`)

      // Quick access is a layer too
      await page.keyboard.press('Control+k')
      await page.locator('.quick').waitFor()
      await page.goBack()
      check(await until(async () => (await page.locator('.quick').count()) === 0), `${label}: back closes Quick access`)
      check(path_(page) === '/next/', `${label}: on the Overview (${page.url()})`)

      // the selection
      if (!phone) {
        await page.locator('.card').nth(0).locator('.card-link').click({ modifiers: ['Control'] })
        const bar = page.getByRole('toolbar', { name: 'Selected sessions' })
        await bar.waitFor()
        await page.goBack()
        check(await until(async () => (await bar.count()) === 0), `${label}: back lets go of the selection`)
        check(path_(page) === '/next/', `${label}: on the Overview (${page.url()})`)
      }

      // with everything closed, back is the screen's again; a menu closed with Esc leaves nothing
      // for back to stop at
      await card.click({ button: 'right' })
      await menu(page).waitFor()
      await page.keyboard.press('Escape')
      await gone(page)
      await page.goBack()
      check(await until(() => path_(page) === '/next/m/local/p/11'), `${label}: back goes back a page (${page.url()})`)
      await layout(page, label)
      await ctx.close()
    }
} catch (e) {
  await capture(browser, shots, 'menus')
  throw e
} finally {
  await done()
}
