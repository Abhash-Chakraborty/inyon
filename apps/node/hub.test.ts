import { expect, test } from 'bun:test'
import { reachAdvice, setupCodeMessage } from './hub.ts'

const env = '/home/me/.inyon/hub.env'

test('Tailscale with HTTPS: tailscale serve', () => {
  expect(reachAdvice([{ kind: 'tailscale', ip: '100.101.102.103', name: 'box.tail1234.ts.net', https: 'box.tail1234.ts.net' }], 4777, env)).toEqual([
    'To open it from your phone:',
    '  Tailscale: run `tailscale serve --bg 4777`, then open https://box.tail1234.ts.net',
  ])
})

test('NetBird: its address over plain http, and expose for HTTPS', () => {
  expect(reachAdvice([{ kind: 'netbird', ip: '100.71.4.20', name: 'box.netbird.selfhosted', expose: true }], 4777, env)).toEqual([
    'To open it from your phone:',
    `  NetBird: add BIND=100.71.4.20 and INYON_ALLOW_HTTP=1 to ${env}, run \`inyon hub install\` again, then open http://box.netbird.selfhosted:4777`,
    `  NetBird, public HTTPS: run \`netbird expose 4777\` and add the address it prints to INYON_ALLOWED_HOSTS in ${env}`,
    "Over plain http the browser won't install the app or show notifications; HTTPS lets it.",
  ])
})

test('ZeroTier has no name: the address it is', () => {
  expect(reachAdvice([{ kind: 'zerotier', ip: '10.147.17.5' }], 5000, env)[1]).toContain('open http://10.147.17.5:5000')
})

test('no private network: HTTPS or BIND, as before', () => {
  expect(reachAdvice([], 4777, env)).toEqual([`It answers on this machine only. To open it from your phone, put it behind HTTPS (Caddy, a tunnel) or set BIND in ${env}.`])
})

const url = 'http://127.0.0.1:4777'

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
