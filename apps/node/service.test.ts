import { expect, test } from 'bun:test'
import { run } from './service.ts'

test("a program that isn't installed is a failed step, not a crash", () => {
  // a container or minimal server has no systemctl; setup must fall back instead of dying
  const r = run(['inyon-no-such-program-here', '--user', 'show-environment'])
  expect(r.ok).toBe(false)
  expect(r.out).toContain("isn't available here")
  expect(run(['true']).ok).toBe(true)
})
