import { expect, test } from 'bun:test'
import { CLOUDFLARED, cloudflaredAsset } from './link.ts'

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
