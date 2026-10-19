import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// the Site workflow's shape: the deploy queued after a release must not be cancelled by a run that skips
const workflow = Bun.YAML.parse(readFileSync(new URL('../../../.github/workflows/pages.yml', import.meta.url), 'utf8')) as any
const { deploy } = workflow.jobs

test('only the deploy job waits its turn, so a skipped run never cancels a queued deploy', () => {
  // 0.19.0's post-Android deploy was cancelled by a skipped workflow_run holding the run-level group
  expect(workflow.concurrency).toBeUndefined()
  expect(deploy.concurrency).toEqual({ group: 'pages', 'cancel-in-progress': false })
  expect(deploy.if).toContain("github.event.workflow_run.conclusion == 'success'")
  expect(deploy.if).toContain("startsWith(github.event.workflow_run.head_branch, 'v')")
})

test('a release and the Android job that follows it both start a deploy', () => {
  expect(workflow.on.workflow_run.workflows).toEqual(['inyon', 'Android'])
  expect(workflow.on.workflow_run.types).toEqual(['completed'])
  expect(workflow.on).toHaveProperty('workflow_dispatch')
})
