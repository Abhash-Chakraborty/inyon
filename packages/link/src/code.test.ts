import { expect, test } from 'bun:test'
import { formatShortId, newShortCode, parseShortCode, publishShortCode, resolveShortCode, shortIdIdentity, shortSecret } from './code.ts'
import { newIdentity } from './identity.ts'

/** A pkarr relay in memory: PUT stores the body, GET returns it. */
function memoryRelay() {
  const store = new Map<string, Uint8Array>()
  const fetcher = (async (url: string, init?: RequestInit) => {
    const key = new URL(url).pathname
    if (init?.method === 'PUT') {
      store.set(key, new Uint8Array(init.body as ArrayBuffer))
      return new Response(null, { status: 204 })
    }
    const v = store.get(key)
    return v ? new Response(v as Uint8Array<ArrayBuffer>) : new Response(null, { status: 404 })
  }) as unknown as typeof fetch
  return { store, fetcher }
}

test('IDs and codes look the way the terminal prints them', () => {
  for (let i = 0; i < 200; i++) {
    const c = newShortCode()
    expect(c.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    expect(c.code).toMatch(/^\d{6}$/)
    expect(parseShortCode(`${formatShortId(c.id)} ${c.code}`)).toEqual(c)
  }
})

test('typing an ID loosely still reads it, and junk is refused', () => {
  expect(parseShortCode('k7q4-mx2t 493 812')).toEqual({ id: 'K7Q4MX2T', code: '493812' })
  // O for 0, I and L for 1
  expect(parseShortCode('K7Q4 MXOI 493812')).toEqual({ id: 'K7Q4MX01', code: '493812' })
  expect(parseShortCode('K7Q4MX2T493812')).toEqual({ id: 'K7Q4MX2T', code: '493812' })
  expect(parseShortCode('K7Q4-MX2T')).toBeUndefined()
  expect(parseShortCode('K7Q4-MX2T 49381')).toBeUndefined()
  expect(parseShortCode('tether://pair?m=x')).toBeUndefined()
})

test('the phone finds the machine from the ID alone, and the code travels as the secret', async () => {
  const relay = memoryRelay()
  const machine = newIdentity()
  const c = newShortCode()
  await publishShortCode(c, { machine: machine.id, name: 'build-box', urls: ['wss://a.example'], relays: [] }, ['https://relay.test'], relay.fetcher)
  const info = await resolveShortCode(c, ['https://relay.test'], relay.fetcher)
  expect(info).toEqual({ id: machine.id, secret: shortSecret(c), name: 'build-box', urls: ['wss://a.example'], relays: [] })
  // a different ID is a different key, so it finds nothing
  expect(await resolveShortCode({ ...c, id: c.id === '00000000' ? '11111111' : '00000000' }, ['https://relay.test'], relay.fetcher)).toBeUndefined()
})

test("a record signed by another key isn't accepted for an ID", async () => {
  const relay = memoryRelay()
  const c = newShortCode()
  const other = newShortCode()
  await publishShortCode(other, { machine: newIdentity().id, name: 'x', urls: [], relays: [] }, ['https://relay.test'], relay.fetcher)
  // copy the other ID's record to where this ID's record would be
  relay.store.set(`/${shortIdIdentity(c.id).id}`, relay.store.get(`/${shortIdIdentity(other.id).id}`)!)
  expect(await resolveShortCode(c, ['https://relay.test'], relay.fetcher)).toBeUndefined()
})
