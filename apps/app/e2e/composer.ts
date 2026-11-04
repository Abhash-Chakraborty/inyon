// bun apps/app/e2e/composer.ts — the message box's files, in the built app (apps/app/dist) behind
// the stand-in hub (hub.ts), at phone and desktop sizes in light and dark: a long paste becomes a
// "Pasted text" file, a screenshot pasted with Ctrl+V and an image pasted with nothing focused
// become thumbnails, short text pasted on the page lands in the box, a dropped file attaches,
// Attach files opens the picker, uploads show progress and ride out a dropped connection, a
// refused one offers a retry, × stops one going, the files stay when you leave and come back, and
// Send lists where they were saved. Then Copy and the terminal's Paste on a plain-HTTP address.
// With the React app built (apps/web/dist) it draws the same box there for comparison.
// Screenshots go to $SHOTS (default: a temp folder). CHROME=/path/to/chrome picks the browser.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from 'playwright'
import { base, check, finish, hasReact, launch, layout, open, plainBase, resetChats, SIZES, state, until } from './hub.ts'

const shots = process.env.SHOTS ?? path.join(tmpdir(), 'inyon-app-shots')
mkdirSync(shots, { recursive: true })
const browser = await launch()
const done = finish(browser)

const LONG = Array.from({ length: 52 }, (_, i) => `line ${i + 1}: the checkout total read before the discount settled`).join('\n')
const box = (page: Page) => page.locator('#composer-input')

/** A clipboard event the way a browser fires one, with text and files, on the box or the page. */
async function paste(page: Page, where: 'box' | 'page', text: string, files: { name: string; type: string; image?: boolean; body?: string }[] = []) {
  await page.evaluate(
    async ({ where, text, files }) => {
      const dt = new DataTransfer()
      if (text) dt.setData('text/plain', text)
      for (const f of files) {
        let blob: Blob = new Blob([f.body ?? 'x'], { type: f.type })
        if (f.image) {
          const c = document.createElement('canvas')
          c.width = c.height = 64
          const g = c.getContext('2d')!
          g.fillStyle = '#5f5d58'
          g.fillRect(0, 0, 64, 64)
          g.fillStyle = '#e9e8e4'
          g.fillRect(12, 12, 40, 24)
          blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
        }
        dt.items.add(new File([blob], f.name, { type: f.type }))
      }
      if (where === 'page') (document.activeElement as HTMLElement | null)?.blur()
      const target = where === 'box' ? document.getElementById('composer-input')! : document.body
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    },
    { where, text, files },
  )
}

/** Files dragged over the box and dropped there. */
async function drop(page: Page, files: { name: string; type: string; body: string }[], letGo = true) {
  return page.evaluate(
    async ({ files, letGo }) => {
      const dt = new DataTransfer()
      for (const f of files) dt.items.add(new File([f.body], f.name, { type: f.type }))
      const zone = document.getElementById('composer-zone')!.querySelector('.composer-box')!
      zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      // the box redraws on the next frame
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const lit = !!document.querySelector('.composer-drag')
      if (letGo) zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      return lit
    },
    { files, letGo },
  )
}

const chips = (page: Page) => page.locator('.attach')
const doneChips = (page: Page) => page.locator('.attach[data-status=done]').count()

try {
  for (const [w, h] of SIZES)
    for (const scheme of ['light', 'dark'] as const) {
      const label = `composer ${w}x${h} ${scheme}`
      resetChats()
      Object.assign(state, { sends: [], calls: [], failChunks: 0, chunkDelay: 0, refuseStart: undefined })
      state.saved.clear()
      const { ctx, page } = await open(browser, w, h, scheme)
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
      await page.goto(`${base}/next/m/local/p/11`)
      await page.getByText('All 20 runs pass now.').waitFor()
      check(await page.getByRole('button', { name: 'Attach files' }).isVisible(), `${label}: Attach files`)
      check((await page.getByRole('button', { name: 'Take a photo' }).isVisible()) === (w < 600), `${label}: Take a photo on touch screens only`)

      // a long paste into the box goes as a text file, with the real Ctrl+V
      await box(page).click()
      await page.evaluate((t) => navigator.clipboard.writeText(t), LONG)
      await page.keyboard.press('ControlOrMeta+V')
      await page.locator('.attach-name').filter({ hasText: 'Pasted text' }).waitFor()
      check((await box(page).inputValue()) === '', `${label}: the long paste stays out of the box`)
      await until(async () => (await page.locator('.attach-detail').filter({ hasText: '52 lines' }).count()) === 1)
      check(await page.locator('.attach-detail').filter({ hasText: '52 lines' }).isVisible(), `${label}: "Pasted text · 52 lines"`)
      const pasted = [...state.saved.values()].find((f) => /^pasted-\d{6}\.txt$/.test(f.name))
      check(pasted && new TextDecoder().decode(pasted.bytes) === LONG && pasted.pane === '11', `${label}: the paste arrives whole as pasted-HHMMSS.txt for pane 11 (${[...state.saved.values()].map((f) => f.name)})`)

      // a short paste in the box is the browser's: it types into the box
      await page.evaluate(() => navigator.clipboard.writeText('the discount'))
      await page.keyboard.press('ControlOrMeta+V')
      await until(async () => (await box(page).inputValue()) === 'the discount')
      check((await box(page).inputValue()) === 'the discount', `${label}: a short paste types into the box`)

      // a screenshot with Ctrl+V, from a real clipboard
      await page.evaluate(async () => {
        const c = document.createElement('canvas')
        c.width = c.height = 48
        c.getContext('2d')!.fillRect(0, 0, 48, 48)
        const png = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      })
      await box(page).focus()
      await page.keyboard.press('ControlOrMeta+V')
      await page.locator('.attach-thumb img').first().waitFor()
      const shotName = await page.locator('.attach-thumb img').first().getAttribute('alt')
      check(/^pasted-\d+-0\.png$/.test(shotName ?? ''), `${label}: a screenshot gets a name of its own (${shotName})`)

      // text and an image pasted with nothing focused land in the box
      await paste(page, 'page', 'and keep the old path')
      check((await box(page).inputValue()) === 'the discount and keep the old path', `${label}: text pasted on the page joins the draft (${await box(page).inputValue()})`)
      check(await page.evaluate(() => document.activeElement?.id === 'composer-input'), `${label}: the box has focus after a page paste`)
      await paste(page, 'page', '', [{ name: 'checkout-diagram.png', type: 'image/png', image: true }])
      await page.locator('.attach-thumb img[alt="checkout-diagram.png"]').waitFor()

      // typing with nothing focused starts in the box (keyboards only)
      if (w >= 600) {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.keyboard.type('!')
        check((await box(page).inputValue()).endsWith('path!'), `${label}: a key with nothing focused types into the box`)
        await page.keyboard.press('Backspace')
      }

      // a file dropped on the box; the box lights up while it's over it
      state.chunkDelay = 250
      const lit = await drop(page, [{ name: 'spec.md', type: 'text/markdown', body: '# Spec\n'.repeat(30000) }])
      check(lit, `${label}: the box lights up while a file is over it`)
      await page.locator('.attach-name').filter({ hasText: 'spec.md' }).waitFor()
      // its progress, a chunk at a time
      const seen = await until(async () => /^\d+%$/.test((await page.locator('.attach').filter({ hasText: 'spec.md' }).locator('.attach-detail').textContent()) ?? ''), 4000)
      check(seen, `${label}: the chip shows how far the upload got`)
      check((await page.locator('.composer-note').textContent()) === 'Uploading…', `${label}: "Uploading…" by the button`)
      check(await page.getByRole('button', { name: /^(Send|Queue follow-up)$/ }).isDisabled(), `${label}: sending waits for the upload`)
      if (w === 1440 && scheme === 'light') await page.screenshot({ path: path.join(shots, `composer-${w}-${scheme}-uploading.png`) })
      // the connection drops mid-file: it says so, then carries on from what arrived
      state.failChunks = 2
      const waiting = await until(async () => (await page.locator('.attach-detail').filter({ hasText: 'Reconnecting…' }).count()) > 0, 6000)
      check(waiting, `${label}: "Reconnecting…" while the machine can't be reached`)
      state.chunkDelay = 0
      await until(async () => (await doneChips(page)) === 4, 30000)
      const spec = [...state.saved.values()].find((f) => f.name === 'spec.md')
      check(spec?.bytes.length === '# Spec\n'.length * 30000, `${label}: the dropped file arrives whole after the drop (${spec?.bytes.length})`)
      check(state.calls.includes('status'), `${label}: after a lost chunk it asks how much arrived (${state.calls.filter((c) => !c.startsWith('put')).join(',')})`)

      // Attach files opens the picker
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Attach files' }).click()])
      check(chooser.isMultiple(), `${label}: the picker takes several files`)
      await chooser.setFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('ship it') }])
      await page.locator('.attach-name').filter({ hasText: 'notes.txt' }).waitFor()

      // a refused upload: the red ring tries again
      state.refuseStart = { status: 400, error: 'The machine said no' }
      await drop(page, [{ name: 'trace.log', type: 'text/plain', body: 'boom' }])
      const ring = page.getByRole('button', { name: 'Retry trace.log' })
      await ring.waitFor()
      check((await ring.getAttribute('title')) === 'The machine said no · tap to try again', `${label}: why it failed, on the ring`)
      check((await page.locator('.composer-note').textContent()) === 'Upload failed', `${label}: "Upload failed" holds the message`)
      check(await page.getByRole('button', { name: /^(Send|Queue follow-up)$/ }).isDisabled(), `${label}: a failed file holds the message`)
      await layout(page, label)
      await page.screenshot({ path: path.join(shots, `composer-${w}-${scheme}.png`) })
      await ring.click()
      await until(async () => (await page.getByRole('button', { name: 'Retry trace.log' }).count()) === 0 && (await doneChips(page)) === 6, 8000)
      check(!(await page.getByRole('button', { name: 'Retry trace.log' }).count()), `${label}: the retry uploads it`)

      // × on one still going stops it, and what arrived is deleted
      state.chunkDelay = 400
      await drop(page, [{ name: 'big.bin', type: 'application/octet-stream', body: 'z'.repeat(400_000) }])
      await until(() => state.calls.some((c) => c === 'put 65536'), 6000)
      await page.getByRole('button', { name: 'Remove big.bin' }).click()
      check(await until(() => state.calls.includes('delete'), 4000), `${label}: removing one mid-upload deletes it on the machine`)
      state.chunkDelay = 0
      check(!(await page.getByRole('button', { name: 'Remove big.bin' }).count()), `${label}: × takes it off`)

      // the files stay with the session when you leave and come back
      await page.evaluate(() => {
        history.pushState(null, '', '/next/m/local/p/12')
        dispatchEvent(new PopStateEvent('popstate'))
      })
      await page.getByText('Would you like to run the following command?').waitFor()
      await page.goBack()
      await page.getByText('All 20 runs pass now.').waitFor()
      check((await chips(page).count()) === 6, `${label}: the six files are still there (${await chips(page).count()})`)

      // Send: the text, then where each file was saved
      const paths = [...state.saved.keys()].filter((p) => !p.endsWith('big.bin'))
      await page.getByRole('button', { name: /^(Send|Queue follow-up)$/ }).click()
      await until(() => state.sends.length > 0)
      const text = String(state.sends[0]?.text ?? '')
      const [said, list] = text.split('\n\nAttached files:\n')
      check(said === 'the discount and keep the old path', `${label}: the message comes first (${JSON.stringify(said)})`)
      check(list?.split('\n').length === 6 && paths.every((p) => list.includes(p)), `${label}: every saved path follows (${JSON.stringify(list)})`)
      check((await chips(page).count()) === 0 && (await box(page).inputValue()) === '', `${label}: the box and its files empty after sending`)
      // the record picks the message up before the next size starts over
      await page.waitForTimeout(600)
      await ctx.close()
    }

  // ---- Copy and Paste on a plain-HTTP hub address ----
  {
    const { ctx, page } = await open(browser, 1440, 900, 'light')
    await ctx.addInitScript(() => {
      const w = window as unknown as { copied: string[] }
      w.copied = []
      const exec = document.execCommand.bind(document)
      document.execCommand = (cmd: string, ...rest: unknown[]) => {
        const a = document.activeElement as HTMLTextAreaElement | null
        if (cmd === 'copy' && a?.tagName === 'TEXTAREA') w.copied.push(a.value.slice(a.selectionStart, a.selectionEnd))
        return exec(cmd, ...(rest as [boolean, string]))
      }
    })
    await page.goto(`${plainBase}/next/m/local/p/11`)
    await page.getByText('All 20 runs pass now.').waitFor()
    check(await page.evaluate(() => !isSecureContext && !('clipboard' in navigator && navigator.clipboard)), 'plain http: no navigator.clipboard here')
    await page.getByRole('button', { name: 'Copy code' }).first().click()
    const copied = await page.evaluate(() => (window as unknown as { copied: string[] }).copied)
    check(copied[0]?.startsWith('export async function total(cart: Cart) {'), `plain http: Copy falls back to the page's own copy (${JSON.stringify(copied)})`)
    check(await page.getByRole('button', { name: 'Copy code' }).first().locator('.icon').evaluate((el) => !!el.closest('button')?.querySelector('.fade-in')), 'plain http: the tick shows it copied')
    // the app still works after: no handler left half-done
    await box(page).fill('still here')
    check((await page.getByRole('button', { name: 'Queue follow-up' }).isEnabled()), 'plain http: the box still works after copying')
    // the terminal's Paste says why it can't
    await page.goto(`${plainBase}/next/m/local/p/11?view=terminal`)
    await page.getByRole('toolbar', { name: 'Keys' }).waitFor()
    await page.getByRole('button', { name: 'Paste' }).click()
    await page.getByText("Couldn't read the clipboard").waitFor()
    check(await page.getByText('Long-press in the terminal and paste from the keyboard instead.').isVisible(), 'plain http: the terminal Paste explains itself')
    await page.screenshot({ path: path.join(shots, 'composer-plain-http-paste.png') })
    await ctx.close()
  }

  // ---- the React app's box, for comparison ----
  if (hasReact)
    for (const [w, h] of SIZES)
      for (const scheme of ['light', 'dark'] as const) {
        resetChats()
        Object.assign(state, { calls: [], failChunks: 0, chunkDelay: 0, refuseStart: { status: 400, error: 'The machine said no' } })
        const { ctx, page } = await open(browser, w, h, scheme)
        await ctx.addInitScript(() => {
          try {
            localStorage.setItem('inyon.intro.seen', '1')
          } catch {}
        })
        await page.goto(`${base}/m/local/p/11`)
        await page.getByText('All 20 runs pass now.').waitFor({ timeout: 15000 }).catch(() => {})
        const ta = page.getByRole('textbox', { name: /^Message/ })
        await ta.click().catch(() => {})
        const dt = async (files: { name: string; type: string; image?: boolean }[], text = '') =>
          page.evaluate(
            async ({ files, text }) => {
              const d = new DataTransfer()
              if (text) d.setData('text/plain', text)
              for (const f of files) {
                let blob: Blob = new Blob(['x'], { type: f.type })
                if (f.image) {
                  const c = document.createElement('canvas')
                  c.width = c.height = 64
                  const g = c.getContext('2d')!
                  g.fillStyle = '#5f5d58'
                  g.fillRect(0, 0, 64, 64)
                  g.fillStyle = '#e9e8e4'
                  g.fillRect(12, 12, 40, 24)
                  blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
                }
                d.items.add(new File([blob], f.name, { type: f.type }))
              }
              document.querySelector('textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }))
            },
            { files, text },
          )
        await dt([{ name: 'trace.log', type: 'text/plain' }])
        await dt([], LONG)
        await dt([{ name: 'checkout-diagram.png', type: 'image/png', image: true }])
        await page.waitForTimeout(1500)
        await page.screenshot({ path: path.join(shots, `react-composer-${w}-${scheme}.png`) })
        await ctx.close()
      }
} catch (e) {
  check(false, `stopped: ${(e as Error).stack ?? e}`)
} finally {
  await done()
}
