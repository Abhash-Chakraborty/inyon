import { afterEach, expect, test } from 'bun:test'
import { forgetHub, hubHostId, hubOriginOf, hubTicket, listHubs, tellApart, normalizeHubCode, parseHubLink, splitHostId, unreachable } from './hubs.ts'

afterEach(() => localStorage.removeItem('inyon.hubs.v1'))

const link = 'inyon://hub?u=https%3A%2F%2Fhub.example&c=K7Q4MX2T%3A493812&n=studio'

test('a hub link from the QR, as the app or the camera gets it', () => {
  expect(parseHubLink(link)).toEqual({
    url: 'https://hub.example',
    code: 'K7Q4MX2T:493812',
    name: 'studio',
  })
  expect(parseHubLink(`https://inyon.abhashchakraborty.tech/#hub?u=http%3A%2F%2Fbox%3A4777&c=K7Q4MX2T%3A493812`)).toEqual({
    url: 'http://box:4777',
    code: 'K7Q4MX2T:493812',
    name: undefined,
  })
  // a machine's pairing link is not a hub's
  expect(parseHubLink('inyon://pair?m=abc&s=secret')).toBeUndefined()
  expect(parseHubLink('inyon://hub?u=ftp%3A%2F%2Fx&c=K7Q4MX2T%3A493812')).toBeUndefined()
})

test('a typed code in any of its spellings', () => {
  expect(normalizeHubCode('k7q4-mx2t 493812')).toBe('K7Q4MX2T:493812')
  expect(normalizeHubCode('K7Q4MX2T:493812')).toBe('K7Q4MX2T:493812')
  expect(normalizeHubCode('K7Q4MX2T 49381')).toBeUndefined()
})

test('a typed address becomes an origin', () => {
  expect(hubOriginOf('box:4777')).toBe('http://box:4777')
  expect(hubOriginOf('hub.example.com')).toBe('https://hub.example.com')
  expect(hubOriginOf('https://hub.example.com/')).toBe('https://hub.example.com')
  expect(hubOriginOf('http://100.97.188.112')).toBe('http://100.97.188.112')
  expect(hubOriginOf('127.0.0.1:4777')).toBe('http://127.0.0.1:4777')
  expect(hubOriginOf('100.97.188.112')).toBe('http://100.97.188.112')
  expect(hubOriginOf('abhash-arm')).toBe('http://abhash-arm')
  expect(hubOriginOf('https://hub.example.com/somewhere')).toBeUndefined()
  expect(hubOriginOf('')).toBeUndefined()
})

test("a hub's machine carries the hub's id, and loses it on the way back", () => {
  localStorage.setItem(
    'inyon.hubs.v1',
    JSON.stringify([
      {
        id: 'h1',
        name: 'studio',
        url: 'https://hub.example',
        token: 't',
        pairedAt: 1,
      },
    ]),
  )
  const id = hubHostId('h1', 'laptop')
  expect(id).toBe('hub:h1/laptop')
  expect(splitHostId(id)).toMatchObject({ hub: { id: 'h1' }, id: 'laptop' })
  expect(splitHostId('laptop')).toEqual({ id: 'laptop' })
  // a hub that was forgotten leaves the id as it is, so nothing is sent anywhere
  forgetHub('h1')
  expect(listHubs()).toEqual([])
  expect(splitHostId(id)).toEqual({ id })
})

test('when nothing comes back from the hub the message says what to check', () => {
  const failed = new TypeError('Failed to fetch')
  // the test page is plain http, like the app's own shell: a plain hub is reachable in principle
  expect(unreachable('http://abhash-arm', failed)).toContain("opens in this phone's browser")
  expect(unreachable('https://hub.example', failed)).toContain("Couldn't reach https://hub.example")
  const slow = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
  expect(unreachable('http://abhash-arm', slow)).toContain("didn't answer in time")
})

test("each connection refreshes the hub's name and version, which were only read at pairing", async () => {
  const hub = { id: 'h1', name: 'abhash-arm', url: 'http://box:4777', token: 't', version: '0.13.3', pairedAt: 1 }
  localStorage.setItem('inyon.hubs.v1', JSON.stringify([hub]))
  const real = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ ticket: 'tk', hub: { id: 'h1', name: 'studio', version: '0.14.1' } })) as unknown as typeof fetch
  try {
    expect(await hubTicket(hub)).toBe('tk')
    expect(listHubs()[0]).toMatchObject({ id: 'h1', name: 'studio', version: '0.14.1', token: 't' })
    // another hub's answer (a stale address now pointing elsewhere) changes nothing
    globalThis.fetch = (async () => Response.json({ ticket: 'tk', hub: { id: 'other', name: 'x', version: '9.9.9' } })) as unknown as typeof fetch
    await hubTicket(listHubs()[0]!)
    expect(listHubs()[0]).toMatchObject({ name: 'studio', version: '0.14.1' })
  } finally {
    globalThis.fetch = real
  }
})

test('machines that share a name are told apart by their hub', () => {
  localStorage.setItem('inyon.hubs.v1', JSON.stringify([{ id: 'h2', name: 'abhash-arm', url: 'http://100.97.188.112:47321', token: 't', pairedAt: 1 }]))
  const m = (id: string, name: string) => ({ config: { id, name } })
  expect(tellApart([m('local', 'abhash-arm'), m(hubHostId('h2', 'local'), 'abhash-arm'), m('db', 'db')]).map((h) => h.config.name)).toEqual(['abhash-arm', 'abhash-arm · 100.97.188.112:47321', 'db'])
  // on a phone both come through hubs, in whichever order they answer: the one paired first keeps its name
  localStorage.setItem('inyon.hubs.v1', JSON.stringify([
    { id: 'h1', name: 'abhash-arm', url: 'https://abhash-arm', token: 't', pairedAt: 1 },
    { id: 'h2', name: 'abhash-arm', url: 'http://100.97.188.112:47321', token: 't', pairedAt: 2 },
  ]))
  const both = [m(hubHostId('h1', 'local'), 'abhash-arm'), m(hubHostId('h2', 'local'), 'abhash-arm')]
  expect(tellApart(both).map((h) => h.config.name)).toEqual(['abhash-arm', 'abhash-arm · 100.97.188.112:47321'])
  expect(tellApart(both.reverse()).map((h) => h.config.name)).toEqual(['abhash-arm · 100.97.188.112:47321', 'abhash-arm'])
  // a name nobody shares stays as it is
  expect(tellApart([m(hubHostId('h2', 'local'), 'abhash-arm')])[0]!.config.name).toBe('abhash-arm')
})
