import type { GitState, PrState, PullRequest } from './api.ts'

/**
 * What the Working tree shows about pull requests, from the git status and what gh said on the
 * session's machine: the branch's pull request, an offer to open one, a note on what gh needs
 * first, or nothing.
 */
export type PrView =
  | { kind: 'none' }
  | { kind: 'pr'; pr: PullRequest }
  | { kind: 'open'; base?: string }
  | { kind: 'notice'; text: string; command?: string }

/** Names a default branch usually has, for when git and gh can't say which it is. */
const USUAL_DEFAULTS = ['main', 'master', 'trunk']

export function prView(s: GitState | undefined, st: PrState | undefined): PrView {
  if (!s?.repo || !st) return { kind: 'none' }
  // an answer about another branch (the one checked out before) says nothing about this one
  if (st.branch !== undefined && st.branch !== s.branch) return { kind: 'none' }
  if (st.pr) return { kind: 'pr', pr: st.pr }
  if (st.gh === 'not-github') return { kind: 'none' }
  const branch = s.branch
  const isDefault = st.base ? branch === st.base : USUAL_DEFAULTS.includes(branch ?? '')
  // pushed: the branch has an upstream and nothing left to push
  const pushed = !!s.upstream && (s.ahead ?? 0) === 0
  if (!branch || branch === 'detached' || isDefault || !s.remote || !pushed) return { kind: 'none' }
  if (st.gh === 'missing') return { kind: 'notice', text: 'To open a pull request from here, install the GitHub CLI on this machine (cli.github.com), then run', command: 'gh auth login' }
  if (st.gh === 'signed-out') return { kind: 'notice', text: 'To open a pull request from here, sign gh in to GitHub on this machine:', command: 'gh auth login' }
  if (st.gh === 'error') return { kind: 'notice', text: st.message || "gh couldn't read the pull request." }
  return { kind: 'open', base: st.base }
}

export type ChecksTone = 'failing' | 'running' | 'passing' | 'none'

/** The checks in one line: what failed, what's still running, what passed. */
export function checksSummary(pr: PullRequest): { tone: ChecksTone; text: string } {
  const { passed, skipped, failed, running } = pr.checks
  if (!passed && !skipped && !failed.length && !running.length) return { tone: 'none', text: 'No checks' }
  const tone: ChecksTone = failed.length ? 'failing' : running.length ? 'running' : 'passing'
  // skipped checks only count when nothing else ran
  const parts = [failed.length && `${failed.length} failing`, running.length && `${running.length} running`, passed && `${passed} passing`, !passed && tone === 'passing' && `${skipped} skipped`]
  return { tone, text: parts.filter(Boolean).join(' · ') }
}

/** How the pull request's state reads on its chip. */
export function prStateLabel(pr: PullRequest): string {
  if (pr.state === 'merged') return 'Merged'
  if (pr.state === 'closed') return 'Closed'
  return pr.draft ? 'Draft' : 'Open'
}

/** What "Send failing checks to the agent" puts in the message box (not sent). */
export function failingPrompt(pr: PullRequest): string {
  const names = pr.checks.failed.map((c) => c.name)
  const where = `pull request #${pr.number} (${pr.url})`
  if (names.length === 1) return `The check "${names[0]}" failed on ${where}. Find out why with gh pr checks ${pr.number} and fix it.`
  return `These checks failed on ${where}:\n${names.map((n) => `- ${n}`).join('\n')}\n\nFind out why with gh pr checks ${pr.number} and fix them.`
}
