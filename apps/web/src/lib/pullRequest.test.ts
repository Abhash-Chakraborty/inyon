import { describe, expect, test } from 'bun:test'
import type { GitState, PrState, PullRequest } from './api.ts'
import { checksSummary, failingPrompt, prStateLabel, prView } from './pullRequest.ts'

const pushed: GitState = { repo: true, remote: true, branch: 'fix/cart', upstream: 'origin/fix/cart', ahead: 0, behind: 0, files: [] }
const ready: PrState = { gh: 'ready', branch: 'fix/cart', base: 'main', draft: { title: 'Fix the cart', body: '' } }
const pr = (checks: Partial<PullRequest['checks']> = {}, more: Partial<PullRequest> = {}): PullRequest => ({
  number: 42,
  title: 'Fix the cart',
  state: 'open',
  draft: false,
  url: 'https://github.com/o/r/pull/42',
  conflicts: false,
  checks: { passed: 0, skipped: 0, failed: [], running: [], ...checks },
  ...more,
})

describe('what the Working tree shows', () => {
  test('a pushed branch that is not the default one can open a pull request', () => {
    expect(prView(pushed, ready)).toEqual({ kind: 'open', base: 'main' })
  })

  test('nothing to offer before the push, on the default branch, detached, or with no remote', () => {
    expect(prView({ ...pushed, ahead: 2 }, ready).kind).toBe('none')
    expect(prView({ ...pushed, upstream: undefined }, ready).kind).toBe('none')
    expect(prView({ ...pushed, branch: 'main' }, ready).kind).toBe('none')
    expect(prView({ ...pushed, branch: 'detached' }, ready).kind).toBe('none')
    expect(prView({ ...pushed, remote: false }, ready).kind).toBe('none')
    expect(prView(pushed, undefined).kind).toBe('none')
    // when nobody knows the default branch, the usual names count as it
    expect(prView({ ...pushed, branch: 'master' }, { gh: 'missing', branch: 'master' }).kind).toBe('none')
  })

  test('a branch with a pull request shows it, pushed or not', () => {
    expect(prView({ ...pushed, ahead: 1 }, { ...ready, pr: pr() })).toEqual({ kind: 'pr', pr: pr() })
  })

  test('gh missing or signed out says what to run; a remote that is not GitHub shows nothing', () => {
    const missing = prView(pushed, { gh: 'missing', branch: 'fix/cart', base: 'main' })
    expect(missing).toEqual({ kind: 'notice', text: expect.stringContaining('install the GitHub CLI'), command: 'gh auth login' })
    expect(prView(pushed, { gh: 'signed-out' })).toEqual({ kind: 'notice', text: expect.stringContaining('sign gh in'), command: 'gh auth login' })
    expect(prView(pushed, { gh: 'error', message: 'HTTP 502' })).toEqual({ kind: 'notice', text: 'HTTP 502' })
    expect(prView(pushed, { gh: 'not-github' }).kind).toBe('none')
  })
})

describe('checks', () => {
  test('in one line, failing first', () => {
    expect(checksSummary(pr({ passed: 3, failed: [{ name: 'CI / check' }], running: [{ name: 'docs' }, { name: 'apk' }] }))).toEqual({ tone: 'failing', text: '1 failing · 2 running · 3 passing' })
    expect(checksSummary(pr({ passed: 3, running: [{ name: 'docs' }] }))).toEqual({ tone: 'running', text: '1 running · 3 passing' })
    expect(checksSummary(pr({ passed: 3, skipped: 2 }))).toEqual({ tone: 'passing', text: '3 passing' })
    expect(checksSummary(pr({ skipped: 2 }))).toEqual({ tone: 'passing', text: '2 skipped' })
    expect(checksSummary(pr())).toEqual({ tone: 'none', text: 'No checks' })
  })

  test('the state chip', () => {
    expect(prStateLabel(pr())).toBe('Open')
    expect(prStateLabel(pr({}, { draft: true }))).toBe('Draft')
    expect(prStateLabel(pr({}, { state: 'merged', draft: true }))).toBe('Merged')
    expect(prStateLabel(pr({}, { state: 'closed' }))).toBe('Closed')
  })

  test('the message for the agent names the failing checks and the link', () => {
    expect(failingPrompt(pr({ failed: [{ name: 'Android / apk' }] }))).toBe('The check "Android / apk" failed on pull request #42 (https://github.com/o/r/pull/42). Find out why with gh pr checks 42 and fix it.')
    expect(failingPrompt(pr({ failed: [{ name: 'a' }, { name: 'b' }] }))).toBe('These checks failed on pull request #42 (https://github.com/o/r/pull/42):\n- a\n- b\n\nFind out why with gh pr checks 42 and fix them.')
  })
})
