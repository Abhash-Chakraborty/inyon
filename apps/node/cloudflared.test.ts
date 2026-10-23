import { expect, test } from 'bun:test'
import { CLOUDFLARED, cloudflaredAsset, lanAddress, tunnelAddressReader } from './link.ts'

test('every platform downloads a pinned cloudflared with a checksum', () => {
  const cases: [string, string, string][] = [
    ['linux', 'x64', 'cloudflared-linux-amd64'],
    ['linux', 'arm64', 'cloudflared-linux-arm64'],
    ['linux', 'arm', 'cloudflared-linux-arm'],
    ['darwin', 'x64', 'cloudflared-darwin-amd64.tgz'],
    ['darwin', 'arm64', 'cloudflared-darwin-arm64.tgz'],
    ['win32', 'x64', 'cloudflared-windows-amd64.exe'],
    ['win32', 'arm64', 'cloudflared-windows-amd64.exe'],
  ]
  for (const [platform, cpu, asset] of cases) {
    expect(cloudflaredAsset(platform, cpu)).toBe(asset)
    const pin = CLOUDFLARED.assets[asset]!
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/)
    if (asset.endsWith('.tgz')) expect(pin.inner).toMatch(/^[0-9a-f]{64}$/)
  }
  expect(CLOUDFLARED.version).toMatch(/^\d{4}\.\d+\.\d+$/)
})

test("only the first address cloudflared prints is taken, until it's started again", () => {
  const enc = new TextEncoder()
  const read = tunnelAddressReader()
  expect(read(enc.encode('INF Requesting new quick Tunnel on trycloudflare.com...\n'))).toBeUndefined()
  expect(read(enc.encode('INF |  https://quiet-river-12'))).toBeUndefined()
  expect(read(enc.encode('34.trycloudflare.com   |\n'))).toBe('wss://quiet-river-1234.trycloudflare.com/link')
  // later lines naming another address (a request it logged, say) change nothing
  expect(read(enc.encode('ERR request to https://someone-elses.trycloudflare.com failed\n'))).toBeUndefined()
  expect(read(enc.encode('INF |  https://quiet-river-9999.trycloudflare.com |\n'))).toBeUndefined()
  expect(tunnelAddressReader()(enc.encode('INF |  https://new-one.trycloudflare.com |\n'))).toBe('wss://new-one.trycloudflare.com/link')
})

test('--lan publishes private addresses, never a public one', () => {
  for (const ip of ['192.168.1.20', '10.0.0.5', '172.16.4.1', '172.31.255.1', '169.254.10.2', '100.70.1.2']) expect(lanAddress(ip)).toBe(true)
  for (const ip of ['203.0.113.7', '8.8.8.8', '172.32.0.1', '100.128.0.1', '127.0.0.1', 'fe80::1']) expect(lanAddress(ip)).toBe(false)
})
