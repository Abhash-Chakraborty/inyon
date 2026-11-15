import type { GitFile, GitState } from './api.ts'

/**
 * The working tree's state as the Changes tab shows it: which files are staged, what Commit will
 * take, and what Discard says before it throws changes away.
 */

/** The hub reports what's staged (from 0.27); an older hub doesn't, and gets none of the staging controls. */
export const canStage = (s: GitState | undefined) => !!s?.files.some((f) => f.staged !== undefined)

/**
 * The two lists: staged files, and files with changes not staged yet. A file staged and then
 * changed again is in both. From an older hub everything is a change.
 */
export function groups(files: GitFile[]): { staged: GitFile[]; changes: GitFile[] } {
  return {
    staged: files.filter((f) => f.staged),
    changes: files.filter((f) => f.unstaged ?? true),
  }
}

/** What the commit button says and does: only the staged files when there are any, else everything. */
export function commitPlan(s: GitState): { label: string; title: string; staged?: boolean } {
  if (!canStage(s)) return { label: 'Commit all', title: 'Commit every change shown here' }
  const n = s.files.filter((f) => f.staged).length
  if (!n) return { label: 'Commit all', title: 'Commit every change shown here', staged: false }
  return { label: `Commit ${n} staged`, title: n === 1 ? 'Commit the staged file only' : `Commit the ${n} staged files only`, staged: true }
}

/** The paths a discard names: a renamed file goes back to where it was, so both. */
export const discardPaths = (f: GitFile) => (f.from ? [f.path, f.from] : [f.path])

const nameOf = (p: string) => p.split('/').pop() || p

/** What the confirm sheet asks before a discard. */
export function discardAsk(f: GitFile): { title: string; body: string } {
  const what =
    f.status === '?' || f.status === 'A'
      ? "It's a new file, so it's deleted. "
      : f.status === 'R' && f.from
        ? `It goes back to ${f.from}. `
        : f.status === 'D'
          ? 'The file comes back as it was in the last commit. '
          : ''
  return { title: `Discard your changes to ${nameOf(f.path)}?`, body: `${what}This can't be undone.` }
}

/** The screen is wide enough for a diff side by side. */
export const SPLIT_MIN = 900
