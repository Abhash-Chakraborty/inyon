import { expect, test } from 'bun:test'
import { privateHost, setupCodeMessage } from './hub.ts'

const url = 'http://127.0.0.1:4777'

const isPrivate = (hub: string) => privateHost(new URL(hub))

test('plain http is for private addresses: loopback, LAN and VPN ranges, local names', () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.1', '192.168.1.20', '172.16.0.1', '172.31.255.255', '100.64.0.1', '100.127.255.255', '[::1]', '[fd7a:115c:a1e0::1]', '[fe80::1]', 'hub.ts.net', 'hub.local', 'hub.lan', 'hub.internal', 'hub']) {
    expect(isPrivate(`http://${h}:4777`)).toBe(true)
  }
})

test('a public address, or a name that only starts like a private one, is not', () => {
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '10.0.0.1.attacker.com', '192.168.1.20.example.net', '127.0.0.1.nip.io', '[2001:db8::1]']) {
    expect(isPrivate(`http://${h}:4777`)).toBe(false)
  }
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
