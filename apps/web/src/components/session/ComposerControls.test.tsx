import { describe, expect, mock, test } from 'bun:test'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AGENTS, type ChatInfo } from '@tether/protocol'
import { ComposerControls } from './ComposerControls.tsx'
import type { SessionModel } from './useSession.ts'
import { chatInfo } from '../../test/fixtures.ts'
import { flush, renderSettled as render } from '../../test/render.tsx'

const actions = { setGoal: mock((_t: string) => {}), clearGoal: mock(() => {}), setModel() {}, setEffort() {}, setMode() {} }

/** What useSession gives the controls; rebuilt on every refresh, as useSession does. */
const session = (goal?: ChatInfo['goal']) =>
  ({ agent: 'claude', def: AGENTS.claude, info: chatInfo({ goal }), efforts: [], actions }) as unknown as SessionModel

const active = { condition: 'tests pass', met: false, ts: '' }
const box = () => screen.getByPlaceholderText('All tests pass and the PR is open') as HTMLTextAreaElement

describe('GoalSheet keeps what you type while live data flows', () => {
  test('typing survives refreshes, even one that changes the goal under it', async () => {
    const user = userEvent.setup()
    const { rerender } = await render(<ComposerControls s={session(active)} />)
    await user.click(screen.getByTitle('Goal: tests pass'))
    expect(box().value).toBe('tests pass')
    await user.clear(box())
    await user.type(box(), 'lint')
    rerender(<ComposerControls s={session(active)} />)
    rerender(<ComposerControls s={session({ ...active, met: true, reason: 'all green' })} />)
    await user.type(box(), ' is clean')
    expect(box().value).toBe('lint is clean')
  })

  test('reopening shows the current goal', async () => {
    const user = userEvent.setup()
    const { rerender } = await render(<ComposerControls s={session(active)} />)
    await user.click(screen.getByTitle('Goal: tests pass'))
    await user.type(box(), ' and more')
    await user.click(screen.getByText('Cancel'))
    rerender(<ComposerControls s={session({ ...active, condition: 'docs updated' })} />)
    await user.click(screen.getByTitle('Goal: docs updated'))
    await flush()
    expect(box().value).toBe('docs updated')
  })

  test('set and turn off', async () => {
    const user = userEvent.setup()
    actions.setGoal.mockClear()
    const { rerender } = await render(<ComposerControls s={session()} />)
    await user.click(screen.getByTitle('Set a goal'))
    expect(box().value).toBe('')
    await user.type(box(), '  ship it  ')
    await user.click(screen.getByText('Set goal'))
    expect(actions.setGoal.mock.calls).toEqual([['ship it']])

    rerender(<ComposerControls s={session(active)} />)
    await user.click(screen.getByTitle('Goal: tests pass'))
    await user.click(screen.getByText('Turn off'))
    expect(actions.clearGoal).toHaveBeenCalledTimes(1)
  })
})
