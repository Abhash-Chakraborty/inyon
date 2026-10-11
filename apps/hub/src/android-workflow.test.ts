import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// the Android workflow's shape: an APK reaches people only after the checks on it have run
const workflow = Bun.YAML.parse(readFileSync(new URL('../../../.github/workflows/android.yml', import.meta.url), 'utf8')) as any
const { apk, smoke, publish } = workflow.jobs
const releases = (job: any) => (job.steps ?? []).some((s: any) => /gh release (create|upload)/.test(s.run ?? ''))

test('the APK is published by its own job, after the smoke and SSH plugin checks', () => {
  expect(releases(apk)).toBe(false)
  expect(Object.entries(workflow.jobs).filter(([, job]) => releases(job)).map(([name]) => name)).toEqual(['publish'])
  expect(publish.needs).toEqual(expect.arrayContaining(['apk', 'smoke', 'ssh-plugin']))
  expect(publish.permissions).toEqual({ contents: 'write' })
  expect(workflow.permissions).toEqual({ contents: 'read' })
})

test('a crash blocks publishing, an emulator that never boots does not', () => {
  // the job runs even when smoke failed, and decides from what smoke saw
  expect(publish.if).toContain('!cancelled()')
  expect(publish.if).toContain("needs.ssh-plugin.result == 'success'")
  expect(publish.if).toContain("needs.smoke.outputs.crashed != 'yes'")
  expect(smoke.outputs.crashed).toBe('${{ steps.verdict.outputs.crashed }}')
  const verdict = smoke.steps.find((s: any) => s.id === 'verdict').run as string
  expect(verdict).toMatch(/none\).*::warning::/)
  expect(verdict).toMatch(/\*\) echo "crashed=yes" >> "\$GITHUB_OUTPUT".*exit 1/)
})

test('pushes to main and v* tags still publish', () => {
  expect(workflow.on.push.branches).toEqual(['main'])
  expect(workflow.on.push.tags).toEqual(['v*'])
  expect(publish.if).toContain("github.event_name == 'push'")
  const run = publish.steps.find((s: any) => s.name === 'Publish').run as string
  expect(run).toContain('gh release create android-latest')
  expect(run).toContain('gh release upload "$GITHUB_REF_NAME"')
})
