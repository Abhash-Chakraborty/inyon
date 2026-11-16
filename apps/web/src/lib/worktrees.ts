import type { WorktreeState } from './api.ts'

/**
 * Sessions in a git worktree of their own (New session › In a new worktree). The hub makes the
 * worktree next to the repo, in `<repo's parent>/.inyon-worktrees/<repo>-<name>`, and checks the
 * branch name again; the same rules live in crates/inyon-core/src/features/worktrees.rs.
 */

/** The first words of `text`: lowercase ASCII letters and digits joined by dashes, at most four words and 32 characters. */
export function slug(text: string): string {
  let out = ''
  for (const w of text.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 4).map((w) => w.toLowerCase())) {
    const next = out ? `${out}-${w}` : w
    if (next.length > 32) {
      if (!out) out = w.slice(0, 32)
      break
    }
    out = next
  }
  return out
}

const two = (n: number) => String(n).padStart(2, '0')

/** The branch New session suggests: `inyon/<first words of the message>`, or `inyon/<agent>-<MMDD-HHMM>` without one. */
export function defaultBranch(prompt: string | undefined, agent: string, now: Date): string {
  const words = slug(prompt ?? '')
  if (words) return `inyon/${words}`
  const stamp = `${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`
  return `inyon/${slug(agent) || 'session'}-${stamp}`
}

/** Why git wouldn't take `name` as a branch (`git check-ref-format --branch`), or undefined when it would. */
export function branchProblem(name: string): string | undefined {
  if (!name) return 'Type a branch name'
  if (name.length > 200) return 'That branch name is too long'
  if (name === '@' || name === 'HEAD') return `“${name}” can't be a branch name`
  if (name.startsWith('-')) return "A branch name can't start with -"
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return "A branch name can't start or end with /, or have two in a row"
  if (name.endsWith('.')) return "A branch name can't end with a dot"
  if (name.includes('..')) return "A branch name can't have two dots in a row"
  if (name.includes('@{')) return "A branch name can't contain @{"
  // eslint-disable-next-line no-control-regex
  const bad = name.match(/[\x00-\x1f\x7f ~^:?*[\\]/)?.[0]
  if (bad) return bad === ' ' ? "A branch name can't contain spaces" : bad < ' ' || bad === '\x7f' ? "A branch name can't contain control characters" : `A branch name can't contain ${bad}`
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'No part of a branch name can start with a dot'
    if (part.endsWith('.lock')) return 'No part of a branch name can end with .lock'
  }
  return undefined
}

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`)

/** Why a worktree stays when its session ends, or undefined when nothing would be lost by removing it. */
export function keepReason(s: WorktreeState): string | undefined {
  if (!s.exists) return 'The worktree folder is already gone'
  if (s.sessions > 0) return `${count(s.sessions, 'other session is', 'other sessions are')} still working in it`
  if (s.changes) return `It has ${count(s.changes, 'uncommitted change', 'uncommitted changes')}`
  if (s.unpushed) return `It has ${count(s.unpushed, 'commit', 'commits')} that no other branch or remote has`
  if (s.changes == null || s.unpushed == null) return "Git couldn't say whether it's clean"
  return undefined
}

/** The "Remove the worktree too" row of the end sheet: on and free to change only when it's clean. */
export interface RemoveOption {
  on: boolean
  disabled: boolean
  note: string
}

/** While the check runs, and when it fails, the worktree stays. */
export const CHECKING: RemoveOption = { on: false, disabled: true, note: 'Checking the worktree…' }
export const UNCHECKED: RemoveOption = { on: false, disabled: true, note: "Couldn't check the worktree, so it stays" }

export function removeOption(s: WorktreeState): RemoveOption {
  const why = keepReason(s)
  if (why) return { on: false, disabled: true, note: `${why}, so it stays.` }
  return { on: true, disabled: false, note: 'It has no uncommitted changes. The branch stays unless it’s merged.' }
}

/** The worktree folder's name after the repo's: the branch without `inyon/`, anything but letters, digits, dots, dashes and underscores as a dash. */
export function folderSlug(branch: string): string {
  const b = branch.startsWith('inyon/') ? branch.slice(6) : branch
  const s = b.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48).replace(/[-.]+$/, '')
  return s || 'worktree'
}

/** Where the hub puts the worktree, relative to the repo: `../.inyon-worktrees/<repo>-<name>`. */
export function worktreeFolder(root: string, branch: string): string {
  const repo = root.split(/[\\/]/).filter(Boolean).pop() ?? 'repo'
  return `../.inyon-worktrees/${repo}-${folderSlug(branch)}`
}
