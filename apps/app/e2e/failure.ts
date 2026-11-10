// What was on screen when a suite's step failed: every open page's address, its place in the
// tab's history, its first lines and a screenshot in $SHOTS (CI keeps that folder), so a step that
// only times out on a runner can be read afterwards. The checks that had already failed go first.
import path from 'node:path'
import type { Browser } from 'playwright'

/** The most any one look at a page may take: a renderer that stopped answering mustn't hold the error back. */
const WAIT_MS = 5000

/** `p`, or `otherwise` when it fails or takes longer than WAIT_MS. */
function within<T>(p: Promise<T>, otherwise: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const late = new Promise<T>((done) => (timer = setTimeout(() => done(otherwise), WAIT_MS)))
  return Promise.race([p.catch(() => otherwise), late]).finally(() => clearTimeout(timer))
}

export async function capture(browser: Browser, shots: string, suite: string, problems: string[] = []) {
  // a check that failed earlier often explains the step that threw, and the throw skips the suite's own list
  if (problems.length) console.error(`failure: ${suite}, ${problems.length} checks had failed before this:\n- ${problems.join('\n- ')}`)
  let n = 0
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      n++
      const at = await within(page.evaluate(() => `${history.length} entries, state ${JSON.stringify(history.state)}, ${innerWidth}x${innerHeight}`), 'the page did not answer')
      const text = await within(page.evaluate(() => document.body.innerText.replace(/\n+/g, ' / ').slice(0, 500)), '')
      console.error(`failure: ${suite}, page ${n} at ${page.url()} (${at})\n  ${text}`)
      await within(page.screenshot({ path: path.join(shots, `failure-${suite}-${n}.png`), timeout: WAIT_MS }).then(() => undefined), undefined)
    }
  }
}
