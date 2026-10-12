import { afterAll, beforeAll, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { deliver, followEvents, forgetPushes, noticeFor, readEntries, setEntries } from './push.ts'
import { nodeDir } from './paths.ts'

const home = mkdtempSync(path.join(os.tmpdir(), 'inyon-push-'))
const realHome = process.env.HOME
beforeAll(() => {
  process.env.HOME = home
  mkdirSync(nodeDir(), { recursive: true })
})
afterAll(() => {
  process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

const phoneA = 'a'.repeat(64)
const phoneB = 'b'.repeat(64)
const reg = (n: number, done = true) => ({
  subscription: { endpoint: `https://push.example.net/${n}`, keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } },
  vapid: { privateJwk: { kty: 'EC', crv: 'P-256', d: 'd', x: 'x', y: 'y' }, subject: 'https://example.com/' },
  done,
})
const line = (pane: string, data: object) => JSON.stringify({ pane, ts: 1, data })

test('Claude asking to run something needs you; finishing is done', () => {
  expect(noticeFor(line('%3', { hook_event_name: 'PermissionRequest', tool_name: 'Bash' }))).toEqual({ kind: 'waiting', pane: '%3', agent: 'Claude', body: 'Claude wants to use Bash' })
  expect(noticeFor(line('%3', { hook_event_name: 'Stop' }))).toEqual({ kind: 'done', pane: '%3', agent: 'Claude', body: 'Claude finished' })
  expect(noticeFor(line('%3', { hook_event_name: 'Stop', last_assistant_message: 'Fixed the  test.\nAll green.' }))?.body).toBe('Fixed the test. All green.')
})

test('reminders, a stop hook running again, other panes and junk are no notice', () => {
  expect(noticeFor(line('%3', { hook_event_name: 'Notification', message: 'Claude is waiting for your input' }))).toBeUndefined()
  expect(noticeFor(line('%3', { hook_event_name: 'Stop', stop_hook_active: true }))).toBeUndefined()
  expect(noticeFor(line('', { hook_event_name: 'Stop' }))).toBeUndefined()
  expect(noticeFor('not json')).toBeUndefined()
})

test('set replaces only what that phone gave, and checks it', () => {
  writeFileSync(path.join(nodeDir(), 'phones.json'), JSON.stringify({ [phoneA]: { name: 'Pixel', pairedAt: 1 }, [phoneB]: { name: 'iPhone', pairedAt: 1 } }))
  setEntries({ phone: phoneA, host: 'laptop', registrations: [reg(1)] })
  setEntries({ phone: phoneB, host: 'my-laptop', registrations: [reg(2, false)] })
  setEntries({ phone: phoneA, host: 'laptop', registrations: [reg(3)] })
  expect(readEntries().map((e) => [e.phone[0], e.host, e.subscription.endpoint.slice(-1)])).toEqual([['b', 'my-laptop', '2'], ['a', 'laptop', '3']])
  expect(() => setEntries({ phone: 'nope', host: 'x', registrations: [] })).toThrow('bad phone key')
  expect(() => setEntries({ phone: phoneA, host: 'x', registrations: [{ ...reg(4), subscription: { endpoint: 'http://insecure', keys: {} } }] })).toThrow('bad endpoint')
  expect(statSync(path.join(nodeDir(), 'push.json')).mode & 0o777).toBe(0o600)
})

test("each browser gets its own tag and link; finished notices only where wanted; gone ones are dropped", async () => {
  const sent: { endpoint: string; payload: any }[] = []
  const send = (async (s: { endpoint: string }, payload: unknown) => {
    sent.push({ endpoint: s.endpoint, payload })
    return { ok: !s.endpoint.endsWith('/3'), status: s.endpoint.endsWith('/3') ? 410 : 201, gone: s.endpoint.endsWith('/3') }
  }) as any
  expect(await deliver({ kind: 'waiting', pane: '%7', title: 'Fix the login', body: 'Claude wants to use Bash' }, { send })).toBe(1)
  expect(sent.map((s) => [s.endpoint.slice(-1), s.payload.tag, s.payload.href])).toEqual([
    ['2', 'my-laptop:%7', '/m/my-laptop/p/7'],
    ['3', 'laptop:%7', '/m/laptop/p/7'],
  ])
  // the browser behind /3 unsubscribed
  expect(readEntries().map((e) => e.subscription.endpoint.slice(-1))).toEqual(['2'])
  sent.length = 0
  // the iPhone asked for needs-you only
  expect(await deliver({ kind: 'done', pane: '%7', title: 'Fix the login', body: 'Claude finished' }, { send })).toBe(0)
  expect(sent).toEqual([])
})

test('a forgotten phone gets nothing, and forget removes what it gave', async () => {
  writeFileSync(path.join(nodeDir(), 'phones.json'), JSON.stringify({ [phoneA]: { name: 'Pixel', pairedAt: 1 } }))
  const send = (async () => ({ ok: true, status: 201, gone: false })) as any
  expect(await deliver({ kind: 'waiting', pane: '%1', title: 't', body: 'b' }, { send })).toBe(0)
  forgetPushes(phoneB)
  expect(readEntries()).toEqual([])
})

test('follows the hook log from its end, across the 2 MB move', async () => {
  const log = path.join(home, 'events.jsonl')
  writeFileSync(log, 'old line\n')
  const seen: string[] = []
  const stop = followEvents((l) => seen.push(l), log, 20)
  const tick = () => Bun.sleep(60)
  appendFileSync(log, 'one\ntw')
  await tick()
  appendFileSync(log, 'o\n')
  await tick()
  renameSync(log, `${log}.old`)
  writeFileSync(log, 'three\n')
  await tick()
  stop()
  expect(seen).toEqual(['one', 'two', 'three'])
})
