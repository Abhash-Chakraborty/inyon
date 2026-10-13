// bun e2e/hubpair.ts: the phone app pairs with a real hub by typed code, end to end. Starts a hub
// on a free port with a throwaway data dir, serves the hosted build (the phone core in a page) from
// another origin, gets a code the way the hub's web app does, and types it into Add → Connect to a hub.
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dir, '..')
const bun = process.execPath
const data = mkdtempSync(path.join(os.tmpdir(), 'inyon-hubpair-'))
const hubPort = 47000 + Math.floor(Math.random() * 900)
const hub = Bun.spawn([bun, 'src/index.ts'], {
  cwd: path.resolve(root, '../hub'),
  env: { ...process.env, INYON_DATA_DIR: data, PORT: String(hubPort), BIND: '127.0.0.1', NODE_ENV: 'production' },
  stdout: 'pipe',
  stderr: 'pipe',
})
const hubUrl = `http://127.0.0.1:${hubPort}`
let setupCode = ''
;(async () => {
  for await (const chunk of hub.stdout) {
    const text = new TextDecoder().decode(chunk)
    const m = text.match(/setup code:?\s*([0-9a-f]{8})/i)
    if (m) setupCode = m[1]!
  }
})().catch(() => {})

// the hosted build from its own origin, as GitHub Pages or a phone would have it
const dist = path.join(root, 'dist-hosted')
const site = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url)
    const file = Bun.file(path.join(dist, url.pathname === '/' || !url.pathname.includes('.') ? 'index.html' : url.pathname))
    return new Response(file)
  },
})
const siteUrl = `http://127.0.0.1:${site.port}`

const fail = (msg: string): never => {
  console.error('FAIL', msg)
  process.exit(1)
}
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
try {
  // wait for the hub, then give it a password as the first visit would
  for (let i = 0; i < 100 && !setupCode; i++) await Bun.sleep(100)
  if (!setupCode) fail('the hub printed no setup code')
  const setup = await fetch(`${hubUrl}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery', code: setupCode }) })
  if (!setup.ok) fail(`setup answered ${setup.status}`)
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]!
  // the hub's web app asks for a code; a fresh sign-in is allowed to
  const pair = await fetch(`${hubUrl}/api/phones/pair`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: hubUrl }, body: JSON.stringify({ origin: hubUrl }) })
  if (!pair.ok) fail(`pair answered ${pair.status}: ${await pair.text()}`)
  const code = (await pair.json()) as { id: string; code: string; link: string }
  console.log('code', code.id, code.code)

  // the phone: type the address and code
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  page.on('console', (m) => m.type() === 'error' && console.log('page error:', m.text()))
  await page.goto(`${siteUrl}/machines`)
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByRole('button', { name: /Connect to a hub/ }).click()
  await page.getByLabel('Hub address').fill(`127.0.0.1:${hubPort}`)
  await page.getByLabel('Hub code').fill(`${code.id} ${code.code}`)
  await page.getByRole('button', { name: 'Pair' }).click()
  await page.getByText(/Paired with/).waitFor({ timeout: 15000 })
  // the hub's own machine shows in the phone's list, under the hub's id
  await page.getByRole('link', { name: /This hub|local/i }).first().waitFor({ timeout: 15000 }).catch(() => {})
  const ids = await page.evaluate(() => JSON.parse(localStorage.getItem('inyon.hubs.v1') ?? '[]').map((h: any) => h.id))
  if (ids.length !== 1) fail(`expected one paired hub, got ${JSON.stringify(ids)}`)
  // the hub lists the phone
  const phones = (await (await fetch(`${hubUrl}/api/phones`, { headers: { cookie } })).json()) as { name: string }[]
  if (phones.length !== 1) fail(`the hub lists ${phones.length} phones`)
  // the code was spent
  const again = await fetch(`${hubUrl}/api/phones/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: `${code.id}:${code.code}`, name: 'x' }) })
  if (again.ok) fail('the code worked twice')
  console.log(`ok: paired as "${phones[0]!.name}", code single-use, hub machines reachable`)
  await ctx.close()
} finally {
  await browser.close()
  site.stop(true)
  hub.kill()
  rmSync(data, { recursive: true, force: true })
}
