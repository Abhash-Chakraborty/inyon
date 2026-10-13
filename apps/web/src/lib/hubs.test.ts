import { afterEach, expect, test } from 'bun:test'
import { forgetHub, hubHostId, hubOriginOf, listHubs, normalizeHubCode, parseHubLink, splitHostId } from './hubs.ts'

afterEach(() => localStorage.removeItem('inyon.hubs.v1'))

const link = 'inyon://hub?u=https%3A%2F%2Fhub.example&c=K7Q4MX2T%3A493812&n=studio'

test('a hub link from the QR, as the app or the camera gets it', () => {
  expect(parseHubLink(link)).toEqual({ url: 'https://hub.example', code: 'K7Q4MX2T:493812', name: 'studio' })
  expect(parseHubLink(`https://inyon.abhashchakraborty.tech/#hub?u=http%3A%2F%2Fbox%3A4777&c=K7Q4MX2T%3A493812`)).toEqual({ url: 'http://box:4777', code: 'K7Q4MX2T:493812', name: undefined })
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
  localStorage.setItem('inyon.hubs.v1', JSON.stringify([{ id: 'h1', name: 'studio', url: 'https://hub.example', token: 't', pairedAt: 1 }]))
  const id = hubHostId('h1', 'laptop')
  expect(id).toBe('hub:h1/laptop')
  expect(splitHostId(id)).toMatchObject({ hub: { id: 'h1' }, id: 'laptop' })
  expect(splitHostId('laptop')).toEqual({ id: 'laptop' })
  // a hub that was forgotten leaves the id as it is, so nothing is sent anywhere
  forgetHub('h1')
  expect(listHubs()).toEqual([])
  expect(splitHostId(id)).toEqual({ id })
})
