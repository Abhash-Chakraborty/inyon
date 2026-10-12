import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { act, render, screen } from '@testing-library/react'
import type { ChatItem, SendState } from '@inyon/protocol'
import { ChatView } from './ChatView.tsx'
import { GoalRow } from './Messages.tsx'
import { buildRows } from '../../lib/chat.ts'
import { patchChat, useStore } from '../../lib/store.ts'
import { api } from '../../lib/api.ts'
import { socket } from '../../lib/socket.ts'
import { emit } from '../../test/fakes.ts'
import { chatInfo, host, item } from '../../test/fixtures.ts'
import { flush } from '../../test/render.tsx'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())

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

  test('a message that failed because the connection dropped goes out again once it is back', async () => {
    useStore.setState({ connected: false, hosts: [host('box')] })
    const send = spyOn(api, 'send').mockResolvedValue({ ok: true } as any)
    render(view())
    load(longConversation(1))
    act(() => patchChat('box:%1', () => ({ pending: [
      { id: 'lost', text: 'run the tests', status: 'failed', at: Date.now(), error: 'Network error', retryable: true },
      { id: 'refused', text: 'nope', status: 'failed', at: Date.now(), error: 'pane is gone' },
    ] })))
    await flush()
    expect(send).not.toHaveBeenCalled()
    act(() => useStore.setState({ connected: true }))
    await flush()
    expect(send.mock.calls.map((c) => c[3])).toEqual(['lost'])
    expect(useStore.getState().chats['box:%1'].pending.find((p) => p.id === 'lost')?.status).toBe('sent')
    send.mockRestore()
  })

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

  test('scrolling up near the top loads earlier messages by itself', async () => {
    useStore.setState({ connected: true, hosts: [host('box')] })
    const sent = spyOn(socket, 'send').mockImplementation(() => {})
    const { container } = render(view())
    load(longConversation(10))
    await flush()
    const el = container.querySelector('.overflow-y-auto') as HTMLElement
    let top = 4000
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 5000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 800 })
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v) => void (top = v) })
    const scrollTo = (y: number) => act(() => {
      top = y
      el.dispatchEvent(new Event('scroll'))
    })
    scrollTo(4200)
    // the reader wheels up: far from the top nothing is fetched, near it the earlier page is
    act(() => void el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })))
    scrollTo(2500)
    expect(sent.mock.calls.some(([m]) => m.t === 'chat.more')).toBe(false)
    scrollTo(300)
    expect(sent.mock.calls.filter(([m]) => m.t === 'chat.more')).toHaveLength(1)
    expect(screen.getByText('Loading earlier messages…')).toBeTruthy()
    // only one request at a time, and an empty answer still ends the wait
    scrollTo(100)
    expect(sent.mock.calls.filter(([m]) => m.t === 'chat.more')).toHaveLength(1)
    act(() => emit({ t: 'chat.more', key: 'box:%1', items: [], hasMore: true }))
    await flush()
    expect(screen.queryByText('Loading earlier messages…')).toBeNull()
    expect(screen.getByText('Earlier messages')).toBeTruthy()
    sent.mockRestore()
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

describe('a long question card', () => {
  // happy-dom has no layout, so this checks the shape that keeps the answers on screen (the
  // browser check is a Playwright run on phone sizes): every box from the chat column down to
  // the card may shrink, the question scrolls on its own, and the answers sit outside it
  test('fits the chat column, with the question scrolling and the answers outside it', async () => {
    useStore.setState({ connected: true, hosts: [host('box')] })
    const body = ['Allow reading these files?', ...Array.from({ length: 22 }, (_, i) => `• file-${i}: read it to answer the question.`), '', 'Do you want to proceed?']
    render(<ChatView host="box" pane="%1" agent="claude" onTerminal={() => {}} />)
    act(() => {
      emit({ t: 'chat.reset', key: 'box:%1', info: chatInfo(), items: [], hasMore: false })
      emit({ t: 'chat.screen', key: 'box:%1', screen: { working: false, width: 80, prompt: { body, options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: 'No', selected: false }], multi: false } } })
    })
    await flush()
    const title = screen.getByText('Allow reading these files?')
    const card = title.closest('.animate-slide-up') as HTMLElement
    const scroller = title.closest('.overflow-y-auto') as HTMLElement
    expect(card.contains(scroller)).toBe(true)
    expect(scroller.textContent).toContain('file-21')

    const yes = screen.getByText('Yes').closest('button')!
    const cancel = screen.getByText('Cancel')
    expect(scroller.contains(yes)).toBe(false)
    expect(scroller.contains(cancel)).toBe(false)
    // Cancel never scrolls away; the choices scroll only when they alone don't fit
    expect(cancel.closest('.overflow-y-auto')).toBeNull()

    const column = card.closest('.flex-1.flex-col') as HTMLElement
    for (let el: HTMLElement | null = card; el && el !== column; el = el.parentElement) {
      expect(el.className).toContain('min-h-0')
      expect(el.className).toContain('flex-col')
    }
  })
})
