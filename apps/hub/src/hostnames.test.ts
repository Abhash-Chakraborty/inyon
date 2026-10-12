import { expect, test } from 'bun:test'
import os from 'node:os'
import { allowedHosts } from './hostnames.ts'

test('answers to addresses and private names, not to public domains', () => {
  const ok = allowedHosts({}, '127.0.0.1')
  for (const h of ['127.0.0.1:4777', 'localhost:4777', '[::1]:4777', '100.97.1.2:4777', '[fd7a:115c:a1e0::1]', 'my-server:4777', 'box.tail1234.ts.net', 'box.netbird.cloud', 'nas.local', `${os.hostname()}:4777`])
    expect(ok(h)).toBe(true)
  for (const h of ['evil.example', 'evil.example:4777', 'localhost.evil.example', 'ts.net.evil.example', 'abc/def', '', null]) expect(ok(h)).toBe(false)
})

test('names you configure are allowed, and * turns the check off', () => {
  const ok = allowedHosts({ INYON_ALLOWED_HOSTS: 'Inyon.Example.com, other.example', INYON_ALLOWED_ORIGINS: 'https://proxy.example:8443' }, '0.0.0.0')
  expect(ok('inyon.example.com')).toBe(true)
  expect(ok('INYON.example.com:443')).toBe(true)
  expect(ok('proxy.example:8443')).toBe(true)
  expect(ok('evil.example')).toBe(false)
  expect(allowedHosts({ INYON_ALLOWED_HOSTS: '*' })('evil.example')).toBe(true)
  expect(allowedHosts({}, 'hub.example.org')('hub.example.org:4777')).toBe(true)
})
