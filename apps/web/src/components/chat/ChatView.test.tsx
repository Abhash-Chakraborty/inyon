import { describe, expect, spyOn, test } from 'bun:test'
import { act, render, screen } from '@testing-library/react'
import type { ChatItem, SendState } from '@tether/protocol'
import { ChatView } from './ChatView.tsx'
import { GoalRow } from './Messages.tsx'
import { buildRows } from '../../lib/chat.ts'
import { patchChat, useStore } from '../../lib/store.ts'
import { emit } from '../../test/fakes.ts'
import { chatInfo, host, item } from '../../test/fixtures.ts'
import { flush } from '../../test/render.tsx'

const goalRow = (i: ChatItem) => {
  const [row] = buildRows([i])
  if (row.type !== 'goal') throw new Error('not a goal row')
  return <GoalRow row={row} />
}

describe('GoalRow', () => {
  test('set, met and cleared', () => {
    const { rerender } = render(goalRow(item.goal('all tests pass')))
    expect(screen.getByText('Goal set')).toBeTruthy()
    expect(screen.getByText('all tests pass')).toBeTruthy()
    rerender(goalRow(item.goal('all tests pass', { met: true, reason: '42 passed' })))
    expect(screen.getByText('Goal met')).toBeTruthy()
    expect(screen.getByText('42 passed')).toBeTruthy()
    rerender(goalRow(item.goal('all tests pass', { cleared: true })))
    expect(screen.getByText('Goal cleared')).toBeTruthy()
  })

  test('met wins over cleared, and a reason only shows once met', () => {
    const { rerender } = render(goalRow(item.goal('x', { met: true, cleared: true })))
    expect(screen.getByText('Goal met')).toBeTruthy()
    rerender(goalRow(item.goal('x', { reason: 'not yet' })))
    expect(screen.queryByText('not yet')).toBeNull()
  })
})

/** A conversation with every kind of row, many times over. */
function longConversation(turns: number): ChatItem[] {
  const items: ChatItem[] = []
  for (let t = 0; t < turns; t++) {
    items.push(
      item.user(`Question ${t}: look at /home/me/code/app.ts please`),
      item.thinking('Let me look.'),
      item.tool(`b${t}`, 'Bash', { command: 'ls -la', description: 'List files' }),
      item.result(`b${t}`, 'total 0'),
      item.tool(`e${t}`, 'Edit', { file_path: '/home/me/code/app.ts', old_string: 'a', new_string: 'b' }),
      { ...item.result(`e${t}`, 'ok'), meta: { filePath: '/home/me/code/app.ts', patch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } } as ChatItem,
      item.tool(`r${t}`, 'Read', { file_path: '/home/me/code/app.ts' }),
      item.text(`Answer ${t}:\n\n\`\`\`ts\nconst x = ${t}\n\`\`\`\n\n| a | b |\n|---|---|\n| 1 | 2 |`),
      item.end(1500),
    )
    if (t % 10 === 0) items.push(item.command('compact', '', 'Compacted'), item.notice('compact', 'Conversation compacted'))
    if (t % 15 === 0) items.push(item.goal('tests pass'), item.text('working on the goal'), item.notice('task', 'Background job finished'), item.notice('interrupted', 'Interrupted'))
    if (t % 20 === 0) {
      items.push(
        item.tool(`todo${t}`, 'TodoWrite', { todos: [{ content: 'Write tests', status: 'completed', activeForm: 'Writing tests' }] }),
        item.tool(`ask${t}`, 'AskUserQuestion', { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }),
        item.tool(`plan${t}`, 'ExitPlanMode', { plan: '1. Do it' }),
        item.goal('tests pass', { met: true, reason: 'green' }),
        item.user('ls', { shell: true }),
      )
    }
  }
  return items
}

describe('ChatView', () => {
  const view = () => <ChatView host="box" pane="%1" agent="claude" onTerminal={() => {}} />
  const load = (items: ChatItem[], info = chatInfo()) => act(() => emit({ t: 'chat.reset', key: 'box:%1', info, items, hasMore: true }))

  test('renders a long conversation without throwing', async () => {
    useStore.setState({ connected: true, hosts: [host('box')] })
    render(view())
    load(longConversation(60))
    await flush()
    expect(screen.getByText(/^Question 0:/)).toBeTruthy()
    expect(screen.getByText(/^Answer 59:/)).toBeTruthy()
    expect(screen.getAllByText('Goal met').length).toBeGreaterThan(0)
    expect(screen.getByText('Earlier messages')).toBeTruthy()
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  test('keeps rendering as items stream in and the ledger moves', async () => {
    useStore.setState({ connected: true, hosts: [host('box')] })
    render(view())
    load(longConversation(5))
    const at = Date.now()
    act(() => patchChat('box:%1', () => ({ pending: [{ id: 's1', text: 'next step', status: 'sent', at }] })))
    expect(screen.getByText('next step')).toBeTruthy()
    const sends: SendState[] = [{ id: 's1', text: 'next step', at, state: 'delivered' }]
    act(() => {
      emit({ t: 'chat.info', key: 'box:%1', info: chatInfo({ sends, queue: ['queued thing'] }) })
      emit({ t: 'chat.append', key: 'box:%1', items: [item.user('next step'), item.text('streaming…')] })
      emit({ t: 'chat.screen', key: 'box:%1', screen: { working: true, width: 80, activity: 'Pondering… (3s · esc to interrupt)' } })
    })
    await flush()
    expect(screen.getAllByText('next step')).toHaveLength(1)
    expect(screen.getByText('queued thing')).toBeTruthy()
    expect(screen.getByText('Pondering…')).toBeTruthy()
  })

  test("another device's send shows until it arrives", async () => {
    useStore.setState({ connected: true, hosts: [host('box')] })
    render(view())
    load([item.user('hi')], chatInfo({ sends: [{ id: 'other', text: 'from my laptop', at: Date.now(), state: 'sending' }] }))
    await flush()
    expect(screen.getByText('from my laptop')).toBeTruthy()
    expect(screen.getByText('Sending from another device')).toBeTruthy()
  })

  test('an empty conversation and an ended session', async () => {
    useStore.setState({ connected: true, hosts: [host('box')] })
    render(view())
    load([])
    expect(screen.getByText('New conversation')).toBeTruthy()
    load([], chatInfo({ running: false }))
    expect(screen.getByText('No agent is running in this pane')).toBeTruthy()
  })

  test('catching up shows a quiet progress line, and the result lands in one go', async () => {
    useStore.setState({ connected: true, hosts: [host('box')] })
    render(view())
    load([item.user('before you left')])
    act(() => {
      emit({ t: 'chat.progress', key: 'box:%1', done: 40, total: 100 })
      emit({ t: 'chat.screen', key: 'box:%1', screen: { working: true, width: 80, activity: 'Pondering…' } })
    })
    expect(screen.getByRole('status').textContent).toContain('Catching up on what you missed')
    expect(screen.getByRole('status').textContent).toContain('40%')
    expect(screen.queryByText('Pondering…')).toBeNull()
    load([item.user('before you left'), item.text('done while you were away')])
    await flush()
    expect(screen.queryByText(/Catching up/)).toBeNull()
    expect(screen.getByText('done while you were away')).toBeTruthy()
  })

  test('coming back after a while jumps to the latest message', async () => {
    useStore.setState({ connected: true, hosts: [host('box')] })
    const { container } = render(view())
    load(longConversation(5))
    await flush()
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement
    const to = spyOn(scroller, 'scrollTo')
    // reading back stops following
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    const hidden = (v: boolean) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => v })
      document.dispatchEvent(new Event('visibilitychange'))
    }
    const now = spyOn(Date, 'now')
    const t = Date.now()
    now.mockReturnValue(t)
    hidden(true)
    now.mockReturnValue(t + 60_000)
    hidden(false)
    await new Promise((r) => requestAnimationFrame(r))
    expect(to).not.toHaveBeenCalled()
    hidden(true)
    now.mockReturnValue(t + 60_000 + 3 * 3600_000)
    hidden(false)
    await new Promise((r) => requestAnimationFrame(r))
    expect(to).toHaveBeenCalled()
    now.mockRestore()
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })
})
