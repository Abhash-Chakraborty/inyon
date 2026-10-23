import { beforeEach, expect, test } from 'bun:test'
import { kv } from '../platform/store.ts'
import { pushAll } from './hub-push.ts'
import { pushRoutes } from './routes.ts'
import { addRegistration, MAX_REGISTRATIONS, payloadFor, registrations, validRegistration } from './registrations.ts'

const jwk = { kty: 'EC', crv: 'P-256', d: 'd', x: 'x', y: 'y' }
const browser = (n: number, done = true) => ({
  subscription: { endpoint: `https://push.example.net/${n}`, keys: { p256dh: 'p', auth: 'a' } },
  vapid: { privateJwk: jwk, subject: 'https://example.com/' },
  done,
})

beforeEach(() => {
  for (const k of kv.keys('push/')) kv.del(k)
})

test('a registration keeps only what it needs and refuses the wrong shape', () => {
  const r = validRegistration({ ...browser(1), vapid: { privateJwk: { ...jwk, extra: 1 }, subject: 'mailto:me@example.com' }, extra: true })
  expect(r.vapid.privateJwk).toEqual(jwk as any)
  expect(r.done).toBe(true)
  expect(() => validRegistration({ ...browser(1), subscription: { endpoint: 'http://push.example.net/1', keys: { p256dh: 'p', auth: 'a' } } })).toThrow('endpoint')
  expect(() => validRegistration({ ...browser(1), vapid: { privateJwk: { ...jwk, crv: 'P-384' }, subject: 'https://example.com/' } })).toThrow('VAPID key')
  expect(() => validRegistration({ ...browser(1), vapid: { privateJwk: jwk, subject: 'example.com' } })).toThrow('subject')
})

test("a session's notice and a machine's share the open app's tags and links", () => {
  expect(payloadFor({ host: 'laptop', pane: '%12', kind: 'waiting', title: 'Fix login', body: 'Allow Bash?' })).toEqual({ title: 'Fix login', body: 'Allow Bash?', kind: 'waiting', tag: 'laptop:%12', href: '/m/laptop/p/12' })
  expect(payloadFor({ host: 'my box', pane: '', kind: 'offline', title: 'my box is offline', body: '' })).toMatchObject({ tag: 'machine:my box', href: '/machines/my%20box' })
})

test("a hub sends to every browser, skips finished notices for those that don't want them, drops gone ones", async () => {
  addRegistration(validRegistration(browser(1)))
  addRegistration(validRegistration(browser(2, false)))
  addRegistration(validRegistration(browser(3)))
  const to: string[] = []
  const send = async (r: { subscription: { endpoint: string } }) => {
    to.push(r.subscription.endpoint.slice(-1))
    const gone = r.subscription.endpoint.endsWith('/3')
    return { ok: !gone, status: gone ? 410 : 201, gone }
  }
  expect(await pushAll(payloadFor({ host: 'h', pane: '%1', kind: 'done', title: 't', body: 'b' }), send)).toBe(1)
  expect(to.sort()).toEqual(['1', '3'])
  expect(registrations().map((r) => r.subscription.endpoint.slice(-1))).toEqual(expect.arrayContaining(['1', '2']))
  expect(registrations()).toHaveLength(2)
  to.length = 0
  expect(await pushAll(payloadFor({ host: 'h', pane: '%1', kind: 'waiting', title: 't', body: 'b' }), send, 'https://push.example.net/2')).toBe(1)
  expect(to).toEqual(['2'])
})

test("in the web app a new subscription replaces the browser's last one; a hub keeps every browser's", async () => {
  const post = (routes: ReturnType<typeof pushRoutes>, n: number) =>
    (routes['/api/push'] as any).POST(Object.assign(new Request('http://x/api/push', { method: 'POST', body: JSON.stringify(browser(n)) }), { params: {} }))
  const page = pushRoutes(async () => 0, { only: true })
  await post(page, 1)
  await post(page, 2)
  expect(registrations().map((r) => r.subscription.endpoint.slice(-1))).toEqual(['2'])
  const hub = pushRoutes(async () => 0)
  await post(hub, 3)
  expect(registrations()).toHaveLength(2)
})

test('a hub sends to at most twenty browsers, dropping the one that registered longest ago', () => {
  for (let n = 1; n <= MAX_REGISTRATIONS + 2; n++) addRegistration({ ...validRegistration(browser(n)), at: 1000 + n })
  const left = registrations().map((r) => Number(r.subscription.endpoint.split('/').pop())).sort((a, b) => a - b)
  expect(MAX_REGISTRATIONS).toBe(20)
  expect(left).toEqual(Array.from({ length: 20 }, (_, i) => i + 3))
  // a browser registering again moves to the end of the queue instead of taking a second place
  addRegistration({ ...validRegistration(browser(3)), at: 5000 })
  addRegistration({ ...validRegistration(browser(99)), at: 5001 })
  expect(registrations().map((r) => r.subscription.endpoint.split('/').pop())).toContain('3')
  expect(registrations().map((r) => r.subscription.endpoint.split('/').pop())).not.toContain('4')
})
