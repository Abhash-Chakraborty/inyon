import { expect, test } from 'bun:test'
import { newerRelease, newestRelease, parseRelease } from '@inyon/protocol'

test('release numbers compare as numbers, not as text', () => {
  expect(newerRelease('0.6.10', '0.6.9')).toBe(true)
  expect(newerRelease('0.6.9', '0.6.10')).toBe(false)
  expect(newerRelease('v1.0.0', '0.99.99')).toBe(true)
  expect(newerRelease('0.6.3', '0.6.3')).toBe(false)
})

test('prereleases never count as an update', () => {
  expect(parseRelease('0.7.0-rc.1')).toBeUndefined()
  expect(newerRelease('0.7.0-rc.1', '0.6.3')).toBe(false)
  expect(newestRelease(['v0.6.4', 'v0.7.0-rc.1', 'v0.6.10', 'android-latest', ''], '0.6.3')).toBe('0.6.10')
  expect(newestRelease(['v0.6.2', 'v0.6.3'], '0.6.3')).toBeUndefined()
})

test('a build from main counts as the release it was built on', () => {
  // the Android app's versionName between releases
  expect(newerRelease('0.6.3', '0.6.3-build.41')).toBe(false)
  expect(newerRelease('0.6.4', '0.6.3-build.41')).toBe(true)
})
