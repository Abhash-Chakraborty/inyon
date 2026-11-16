import { describe, expect, test } from 'bun:test'
import type { GitFile, GitState } from './api.ts'
import { canStage, commitPlan, discardAsk, discardPaths, groups } from './worktree.ts'
import { splitRows } from '../components/chat/Diff.tsx'

const f = (path: string, status: GitFile['status'], staged?: boolean, unstaged?: boolean, from?: string): GitFile => ({ path, status, add: 1, del: 0, staged, unstaged, from })
const state = (files: GitFile[]): GitState => ({ repo: true, branch: 'main', files })

describe('staging', () => {
  test('a file staged and changed again is in both lists; an older hub has only changes', () => {
    const files = [f('a.ts', 'M', true, false), f('b.ts', 'M', true, true), f('c.md', '?', false, true)]
    const g = groups(files)
    expect(g.staged.map((x) => x.path)).toEqual(['a.ts', 'b.ts'])
    expect(g.changes.map((x) => x.path)).toEqual(['b.ts', 'c.md'])
    const old = [f('a.ts', 'M'), f('c.md', '?')]
    expect(canStage(state(old))).toBe(false)
    expect(groups(old)).toEqual({ staged: [], changes: old })
    expect(canStage(state(files))).toBe(true)
  })

  test('commit takes the staged files when there are any, and says how many', () => {
    expect(commitPlan(state([f('a.ts', 'M', false, true)]))).toEqual({ label: 'Commit all', title: 'Commit every change shown here', staged: false })
    expect(commitPlan(state([f('a.ts', 'M', true, false), f('b.ts', 'M', false, true)]))).toEqual({ label: 'Commit 1 staged', title: 'Commit the staged file only', staged: true })
    expect(commitPlan(state([f('a.ts', 'M', true), f('b.ts', 'A', true)])).label).toBe('Commit 2 staged')
    // an older hub decides for itself, as it always did
    expect(commitPlan(state([f('a.ts', 'M')]))).toEqual({ label: 'Commit all', title: 'Commit every change shown here' })
  })
})

describe('discard', () => {
  test('says what happens to each kind of file', () => {
    expect(discardAsk(f('src/a b.ts', 'M', false, true))).toEqual({ title: 'Discard your changes to a b.ts?', body: "This can't be undone." })
    expect(discardAsk(f('notes.md', '?', false, true)).body).toBe("It's a new file, so it's deleted. This can't be undone.")
    expect(discardAsk(f('x.ts', 'A', true, false)).body).toBe("It's a new file, so it's deleted. This can't be undone.")
    expect(discardAsk(f('new.ts', 'R', true, false, 'old.ts')).body).toBe("It goes back to old.ts. This can't be undone.")
    expect(discardAsk(f('gone.txt', 'D', false, true)).body).toBe("The file comes back as it was in the last commit. This can't be undone.")
  })

  test('a renamed file names both its paths', () => {
    expect(discardPaths(f('new.ts', 'R', true, false, 'old.ts'))).toEqual(['new.ts', 'old.ts'])
    expect(discardPaths(f('-x.ts', 'M'))).toEqual(['-x.ts'])
  })
})

describe('side by side', () => {
  test('removed lines sit next to the added lines that replace them', () => {
    const { rows, hidden } = splitRows([
      { oldStart: 1, oldLines: 4, newStart: 1, newLines: 3, lines: [' keep', '-a', '-b', '+A', ' mid', '-gone', '\\ No newline at end of file'] },
      { oldStart: 10, oldLines: 0, newStart: 9, newLines: 1, lines: ['+new'] },
    ])
    expect(hidden).toBe(0)
    expect(rows).toEqual([
      { left: { no: 1, kind: 'same', text: 'keep' }, right: { no: 1, kind: 'same', text: 'keep' } },
      { left: { no: 2, kind: 'del', text: 'a' }, right: { no: 2, kind: 'add', text: 'A' } },
      { left: { no: 3, kind: 'del', text: 'b' }, right: undefined },
      { left: { no: 4, kind: 'same', text: 'mid' }, right: { no: 3, kind: 'same', text: 'mid' } },
      { left: { no: 5, kind: 'del', text: 'gone' }, right: undefined },
      { gap: true },
      { left: undefined, right: { no: 9, kind: 'add', text: 'new' } },
    ])
  })

  test('an added run followed by a removed one starts a new pair', () => {
    const { rows } = splitRows([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+x', '-y'] }])
    expect(rows).toEqual([
      { left: undefined, right: { no: 1, kind: 'add', text: 'x' } },
      { left: { no: 1, kind: 'del', text: 'y' }, right: undefined },
    ])
  })

  test('long diffs stop at the limit and count the rest', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `+${i}`)
    const { rows, hidden } = splitRows([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 10, lines }], 4)
    expect(rows).toHaveLength(4)
    expect(hidden).toBe(6)
  })
})
