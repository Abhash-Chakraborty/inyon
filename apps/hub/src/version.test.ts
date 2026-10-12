import { expect, test } from 'bun:test'
import { VERSION } from '@inyon/protocol'

const root = new URL('../../../', import.meta.url)

test('the app, the hub and inyon carry the version in package.json', async () => {
  const pkg = await Bun.file(new URL('package.json', root)).json()
  const node = await Bun.file(new URL('apps/node/link.ts', root)).text()
  expect(VERSION).toBe(pkg.version)
  expect(node).toContain(`export const VERSION = '${pkg.version}'`)
})
