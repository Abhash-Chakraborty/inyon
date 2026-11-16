import { describe, expect, test } from 'bun:test'
import { branchProblem, defaultBranch, folderSlug, keepReason, removeOption, slug, worktreeFolder } from './worktrees.ts'

describe('worktree names', () => {
  test('a slug is the first words in lowercase, as the hub makes it', () => {
    expect(slug('Fix the login test on Safari')).toBe('fix-the-login-test')
    expect(slug('  README: typo!! ')).toBe('readme-typo')
    expect(slug('Übersetze die Hilfe')).toBe('bersetze-die-hilfe')
    expect(slug('İstanbul')).toBe('stanbul')
    expect(slug('日本語')).toBe('')
    expect(slug('internationalisation localisation everything')).toBe('internationalisation')
    expect(slug('a'.repeat(40))).toBe('a'.repeat(32))
  })

  test('the suggested branch comes from the first message, or the agent and the time', () => {
    const at = new Date(2026, 10, 15, 14, 32)
    expect(defaultBranch('Fix the login test', 'claude', at)).toBe('inyon/fix-the-login-test')
    expect(defaultBranch('', 'claude', at)).toBe('inyon/claude-1115-1432')
    expect(defaultBranch(undefined, 'Claude YOLO', new Date(2026, 0, 2, 3, 4))).toBe('inyon/claude-yolo-0102-0304')
    expect(defaultBranch(undefined, '日本', at)).toBe('inyon/session-1115-1432')
  })

  test("branch names follow git's rules", () => {
    for (const ok of ['inyon/fix-login', 'main', 'feature/a.b', 'v1.2', 'émoji-ok']) expect(branchProblem(ok)).toBeUndefined()
    for (const bad of ['', '@', 'HEAD', '-x', '/x', 'x/', 'a//b', 'x.', 'a..b', 'a@{b', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a\tb', '.x', 'a/.b', 'x.lock'])
      expect(branchProblem(bad)).toBeString()
    expect(branchProblem('a b')).toBe("A branch name can't contain spaces")
    expect(branchProblem('a:b')).toBe("A branch name can't contain :")
    expect(branchProblem('')).toBe('Type a branch name')
  })

  test('the folder goes next to the repo, named after the branch', () => {
    expect(folderSlug('inyon/fix-login')).toBe('fix-login')
    expect(folderSlug("a$b;c'd")).toBe('a-b-c-d')
    expect(folderSlug('inyon/')).toBe('worktree')
    expect(worktreeFolder('/home/me/code/api', 'inyon/fix-login')).toBe('../.inyon-worktrees/api-fix-login')
    expect(worktreeFolder('C:/demo/billing-api', 'feat/x')).toBe('../.inyon-worktrees/billing-api-feat-x')
  })
})

describe('ending a worktree session', () => {
  const clean = { exists: true, branch: 'inyon/x', changes: 0, unpushed: 0, sessions: 0 }

  test('a clean worktree can go, and the switch starts on', () => {
    expect(keepReason(clean)).toBeUndefined()
    expect(removeOption(clean)).toMatchObject({ on: true, disabled: false })
  })

  test('changes, commits of its own, other sessions or doubt keep it, and say why', () => {
    expect(keepReason({ ...clean, changes: 3 })).toBe('It has 3 uncommitted changes')
    expect(keepReason({ ...clean, changes: 1 })).toBe('It has 1 uncommitted change')
    expect(keepReason({ ...clean, unpushed: 2 })).toBe('It has 2 commits that no other branch or remote has')
    expect(keepReason({ ...clean, sessions: 1 })).toBe('1 other session is still working in it')
    expect(keepReason({ ...clean, exists: false })).toBe('The worktree folder is already gone')
    expect(keepReason({ exists: true, sessions: 0, changes: 0 })).toBe("Git couldn't say whether it's clean")
    expect(removeOption({ ...clean, changes: 3 })).toEqual({ on: false, disabled: true, note: 'It has 3 uncommitted changes, so it stays.' })
  })
})
