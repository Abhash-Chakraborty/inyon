import { expect, test } from 'bun:test'
import { setupCodeMessage } from './hub.ts'

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
