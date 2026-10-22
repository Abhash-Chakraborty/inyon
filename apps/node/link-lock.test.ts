import { afterAll, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { ENGINE } from './engine-under-test.ts'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'

// `inyon forget` and `inyon pair` run as processes of their own beside the link: these tests race
// two Bun processes (the link and the command) over the same ~/.inyon/node. Everything that touches
// the node's folder runs in a child with HOME pointed at a throwaway one: Bun reads the home once,
// so this process must never import link.ts itself.
const home = mkdtempSync(path.join(os.tmpdir(), 'inyon-lock-'))
const node = path.join(home, '.inyon', 'node')
mkdirSync(node, { recursive: true })
afterAll(() => rmSync(home, { recursive: true, force: true }))

const KEY = '09'.repeat(32)
const linkFile = path.join(import.meta.dir, 'link.ts')
const env = { ...process.env, HOME: home, USERPROFILE: home }

const script = (body: string) => `
  import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
  import path from 'node:path'
  import os from 'node:os'
  import * as link from ${JSON.stringify(linkFile)}
  if (os.homedir() !== ${JSON.stringify(home)}) throw new Error('not the test home: ' + os.homedir())
  const node = ${JSON.stringify(node)}
  const KEY = ${JSON.stringify(KEY)}
  const addPhone = () => link.withNodeFiles(() => writeFileSync(path.join(node, 'phones.json'), JSON.stringify({ [KEY]: { name: 'Pixel 9', pairedAt: 1 } })))
  ${body}
`

/** Runs `body` as the command side and returns what it prints (JSON). */
async function command(body: string) {
  const p = Bun.spawn([process.execPath, '-e', script(body)], { env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code !== 0) throw new Error(err)
  return JSON.parse(out.trim().split('\n').pop() || 'null')
}

/** The running link, in a process of its own, doing `body` until the test drops a stop file. */
function runningLink(body: string) {
  rmSync(path.join(node, 'stop'), { force: true })
  return Bun.spawn([process.execPath, '-e', script(`const until = Date.now() + 60_000; while (Date.now() < until && !existsSync(path.join(node, 'stop'))) { ${body} }`)], { env, stdout: 'ignore', stderr: 'inherit' })
}

const stopLink = async (p: ReturnType<typeof Bun.spawn>) => {
  writeFileSync(path.join(node, 'stop'), '')
  await p.exited
}

test('a phone forgotten by another process while the link writes stays forgotten', async () => {
  await command('addPhone(); console.log(1)')
  const p = runningLink(`
    try { link.check(new Uint8Array(32).fill(9), {}) } catch {}
    link.markSeen(KEY, 0)
  `)
  await Bun.sleep(500)
  const back = await command(`
    let back = 0
    for (let i = 0; i < 200; i++) {
      addPhone()
      Bun.sleepSync(1)
      link.forgetPhone(KEY)
      Bun.sleepSync(2)
      if (link.listPhones()[KEY]) back++
    }
    console.log(back)
  `)
  await stopLink(p)
  expect(back).toBe(0)
}, 60_000)

test('a new pairing made by another process survives wrong guesses', async () => {
  await command('link.newPairing(); console.log(1)')
  const p = runningLink(`try { link.check(new Uint8Array(32).fill(5), { name: 'Guesser', pair: 'ABCDEFGH:000000' }) } catch {}`)
  await Bun.sleep(500)
  const lost = await command(`
    let lost = 0
    for (let i = 0; i < 150; i++) {
      // two at once: the first is still taking guesses when the second is written
      link.newPairing()
      const { secret } = link.newPairing()
      Bun.sleepSync(2)
      if (JSON.parse(readFileSync(path.join(node, 'pairing.json'), 'utf8')).secret !== secret) lost++
    }
    console.log(lost)
  `)
  await stopLink(p)
  expect(lost).toBe(0)
}, 60_000)

test('a replayed message 1 writes nothing, and a proven phone is seen once a minute', async () => {
  const r = await command(`
    addPhone()
    const file = path.join(node, 'phones.json')
    const before = readFileSync(file, 'utf8')
    for (let i = 0; i < 3; i++) link.check(new Uint8Array(32).fill(9), {})
    const replayed = readFileSync(file, 'utf8') === before
    link.markSeen(KEY)
    const seen = readFileSync(file, 'utf8')
    link.markSeen(KEY)
    const again = readFileSync(file, 'utf8') === seen
    link.forgetPhone(KEY)
    link.markSeen(KEY, 0)
    console.log(JSON.stringify({ replayed, lastSeen: JSON.parse(seen)[KEY].lastSeen, again, gone: !link.listPhones()[KEY] }))
  `)
  expect(r).toMatchObject({ replayed: true, again: true, gone: true })
  expect(r.lastSeen).toBeGreaterThan(0)
})

test('a wrong guess that cannot be counted ends the code', async () => {
  const r = await command(`
    const { short } = link.newPairing()
    // something in the way of pairing.json's temporary file, as a full disk would be
    mkdirSync(path.join(node, 'pairing.json.' + process.pid + '.tmp'))
    let said = ''
    try { link.check(new Uint8Array(32).fill(6), { pair: short.id + ':000000' }) } catch (e) { said = e.message }
    rmSync(path.join(node, 'pairing.json.' + process.pid + '.tmp'), { recursive: true })
    console.log(JSON.stringify({ said, left: existsSync(path.join(node, 'pairing.json')) }))
  `)
  expect(r.said).toStartWith("That code doesn't match")
  expect(r.left).toBe(false)
})

test('three processes counting at once lose no count', async () => {
  const count = path.join(node, 'count.json')
  rmSync(count, { force: true })
  const kids = [0, 1, 2].map(() =>
    command(`
      for (let i = 0; i < 100; i++) link.withNodeFiles(() => {
        const n = existsSync(path.join(node, 'count.json')) ? JSON.parse(readFileSync(path.join(node, 'count.json'), 'utf8')) : 0
        writeFileSync(path.join(node, 'count.json'), JSON.stringify(n + 1))
      })
      console.log(1)
    `),
  )
  await Promise.all(kids)
  expect(JSON.parse(readFileSync(count, 'utf8'))).toBe(300)
})

test('a held lock is waited for, the phone is told busy in time, and it is free the moment its holder dies whatever its date', async () => {
  const lock = path.join(node, 'files.lock')
  const held = path.join(node, 'held')
  rmSync(held, { force: true })
  const holder = runningLink(`link.withNodeFiles(() => { writeFileSync(path.join(node, 'held'), ''); Bun.sleepSync(60_000) })`)
  while (!existsSync(held)) await Bun.sleep(5)
  utimesSync(lock, new Date(Date.now() + 3600_000), new Date(Date.now() + 3600_000))
  const busy = await command(`
    const t = Date.now()
    let said = ''
    try { link.check(new Uint8Array(32).fill(4), {}) } catch (e) { said = e.message }
    console.log(JSON.stringify({ said, took: Date.now() - t }))
  `)
  expect(busy.said).toContain('busy saving its files')
  expect(busy.took).toBeLessThan(2500)
  holder.kill('SIGKILL')
  await holder.exited
  const free = await command('const t = Date.now(); link.forgetPhone(KEY); console.log(Date.now() - t)')
  expect(free).toBeLessThan(1000)
}, 15_000)

test('the engine under test waits for a lock this engine holds, and goes on once it is let go', async () => {
  await command('addPhone(); console.log(1)')
  const held = path.join(node, 'held')
  rmSync(held, { force: true })
  const holder = runningLink(`link.withNodeFiles(() => { writeFileSync(path.join(node, 'held'), ''); Bun.sleepSync(800) }); process.exit(0)`)
  while (!existsSync(held)) await Bun.sleep(5)
  const t = Date.now()
  const f = Bun.spawn([...ENGINE, 'forget', 'Pixel 9'], { env, stdout: 'pipe', stderr: 'pipe' })
  expect(await f.exited).toBe(0)
  const took = Date.now() - t
  await holder.exited
  expect(took).toBeGreaterThan(500)
  expect(JSON.parse(readFileSync(path.join(node, 'phones.json'), 'utf8'))[KEY]).toBeUndefined()
}, 15_000)

test('a dangling symlink in place of the lock is replaced, not spun on', async () => {
  const lock = path.join(node, 'files.lock')
  rmSync(lock, { force: true })
  symlinkSync(path.join(node, 'nowhere', 'x'), lock)
  const took = await command('const t = Date.now(); link.forgetPhone(KEY); console.log(Date.now() - t)')
  expect(took).toBeLessThan(1000)
  expect(lstatSync(lock).isFile()).toBe(true)
  expect(existsSync(path.join(node, 'nowhere'))).toBe(false)
})

test('a damaged identity stops the link and stays as it is', async () => {
  const file = path.join(node, 'identity.json')
  for (const bad of ['{"seed":"ab"}', `{"seed":"${'zz'.repeat(32)}"}`, 'not json']) {
    writeFileSync(file, bad)
    const said = await command(`try { link.identity(); console.log('""') } catch (e) { console.log(JSON.stringify(e.message)) }`)
    expect(said).toContain("isn't a valid identity")
    expect(readFileSync(file, 'utf8')).toBe(bad)
  }
  rmSync(file)
  const made = await command('console.log(JSON.stringify(link.identity().id))')
  expect(await command('console.log(JSON.stringify(link.identity().id))')).toBe(made)
})

test('a publish the relays refuse is tried again soon until one takes it', async () => {
  const r = await command(`
    const { newIdentity } = await import('@inyon/link')
    const id = newIdentity()
    let puts = 0
    const refusing = (answers) => async () => new Response('', { status: answers[Math.min(puts++, answers.length - 1)] })
    const seq = await link.publishUntilTaken(['http://pkarr.test'], id, { urls: ['wss://a.test'], relays: [] }, 5, 20, () => true, refusing([429, 429, 200]))
    const tookIt = puts
    // a newer record took over: the old one stops trying
    puts = 0
    let asked = 0
    const stopped = await link.publishUntilTaken(['http://pkarr.test'], id, { urls: ['wss://a.test'], relays: [] }, undefined, 20, () => asked++ < 3, refusing([429]))
    console.log(JSON.stringify({ seq, tookIt, stopped: stopped ?? null, puts }))
  `)
  expect(r.seq).toBeGreaterThan(5)
  expect(r.tookIt).toBe(3)
  expect(r.stopped).toBeNull()
  expect(r.puts).toBe(2)
})
