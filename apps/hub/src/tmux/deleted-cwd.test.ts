import { expect, test } from 'bun:test'
import { pickCodexRollout } from '../agents/codex.ts'
import { procCwds } from './tmux.ts'

test("an agent whose folder was deleted is still matched to its chat", () => {
  // what readlink /proc/<pid>/cwd prints once the worktree the agent runs in is removed
  const cwds = procCwds(['4242 /home/u/wt/review (deleted)', '4243 /home/u/my (deleted) notes'])
  expect(cwds.get(4242)).toBe('/home/u/wt/review')
  // only the mark Linux adds at the end comes off
  expect(cwds.get(4243)).toBe('/home/u/my (deleted) notes')

  const proc = { pid: 4242, cwd: cwds.get(4242), startedAt: 1000 }
  const rows = [{ path: '/s/rollout-a.jsonl', id: 'a', cwd: '/home/u/wt/review', created: 1010, mtime: 2000 }]
  expect(pickCodexRollout(rows, proc, [proc], new Map())).toBe('/s/rollout-a.jsonl')
})
