// cold load of the built app on a throttled "phone": first paint, first content, main chunk parse, overview painted
import path from 'node:path'
import { chromium } from 'playwright'
import { PHONE, open, serve, settle } from '../readme/stage.ts'
const { base, stop } = serve(path.resolve('dist'))
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
for (const throttle of [1, 4]) {
  const times: number[] = []
  const paints: Record<string, number> = {}
  for (let i = 0; i < 3; i++) {
    const { ctx, page } = await open(browser, base, PHONE, 'light', 1)
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 1.5e6 / 8 * 10, uploadThroughput: 750e3 / 8 })
    const t0 = Date.now()
    await page.goto(base + '/')
    await page.getByRole('main').getByText('Fix flaky checkout test').first().waitFor()
    times.push(Date.now() - t0)
    const p = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)])))
    Object.assign(paints, p)
    await ctx.close()
  }
  console.log(`cpu x${throttle}: overview visible ${times.join('/')} ms; paints`, paints)
}
await browser.close(); stop()
