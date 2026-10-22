import { expect, test } from 'bun:test'
import { checkName, companionCodeMessage, formatCompanionCode, plainHost, plainHttpIp, plainRefusal, setupCodeMessage } from './hub.ts'

const url = 'http://127.0.0.1:4777'

const plain = (hub: string) => plainHost(new URL(hub))

test('plain http is for this machine and the VPN ranges', () => {
  for (const h of ['localhost', '127.0.0.1', '127.8.0.1', '100.64.0.1', '100.127.255.255', '[::1]', '[fd7a:115c:a1e0::1]', '[fd7a:115c:a1e0:ab12::5]', '[::ffff:100.100.1.1]']) {
    expect(plain(`http://${h}:4777`)).toBe('ok')
  }
})

test('a LAN address or a public one is refused, and a name is looked up', () => {
  // a LAN can be listened to, and answered by anyone on it
  for (const h of ['10.0.0.1', '192.168.1.20', '172.16.0.1', '8.8.8.8', '100.128.0.1', '100.63.255.255', '[fd00::1]', '[fe80::1]', '[fd7a:115c:a1e1::1]', '[2001:db8::1]', '[::ffff:192.168.1.2]']) {
    expect(plain(`http://${h}:4777`)).toBe('refused')
  }
  for (const h of ['hub.local', 'hub.lan', 'hub', 'hub.tail1234.ts.net', '10.0.0.1.attacker.com']) expect(plain(`http://${h}:4777`)).toBe('look up')
})

test('a name passes only when every address it has is allowed', async () => {
  // the addresses it was judged by, to connect to and nothing else
  const local = await checkName('localhost')
  expect(local && 'addrs' in local && local.addrs.length > 0 && local.addrs.every((a) => a === '::1' || a.startsWith('127.'))).toBe(true)
  expect(await checkName('192.168.1.2')).toEqual({ why: expect.stringContaining('Refusing to send the token over plain http to 192.168.1.2') })
  expect(await checkName('nothing.invalid')).toBeNull()
  expect(plainHttpIp('100.100.1.1')).toBe(true)
  expect(plainHttpIp('192.168.1.2')).toBe(false)
  expect(plainRefusal('192.168.1.2')).toContain('INYON_ALLOW_INSECURE=1')
})

test('setup code: shown while the hub waits for its first password', () => {
  expect(setupCodeMessage('e8ff64a5', { setup: true }, url)).toBe(`Setup code: e8ff64a5\nOpen ${url} in a browser and enter it to choose a password.`)
})

test('setup code: a hub with a password points at reset-password', () => {
  expect(setupCodeMessage('e8ff64a5', { setup: false }, url)).toContain('inyon hub reset-password')
  expect(setupCodeMessage(undefined, { setup: false }, url)).toContain('no setup code')
})

test('setup code: the file without a running hub, and neither', () => {
  expect(setupCodeMessage('e8ff64a5', undefined, url)).toMatch(/^Setup code: e8ff64a5\n.*start it/)
  expect(setupCodeMessage(undefined, undefined, url)).toContain('has not started yet')
})

test('companion code: shown in two halves, with where to type it and for how long', () => {
  expect(formatCompanionCode('K7M2QX')).toBe('K7M-2QX')
  expect(formatCompanionCode('odd')).toBe('odd')
  expect(companionCodeMessage('K7M2QX', 'http://100.97.0.1:8787')).toBe(
    "Companion code: K7M-2QX\nType it into the companion app (Legato: Settings > Connections > Inyon) with this hub's address, http://100.97.0.1:8787. It works once, for 5 minutes.",
  )
  // behind a proxy the loopback address would reach nothing from the app's computer
  expect(companionCodeMessage('K7M2QX', 'http://127.0.0.1:4777')).toContain('with the address you open this hub at.')
})
