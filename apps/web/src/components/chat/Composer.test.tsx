import { describe, expect, test } from 'bun:test'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Composer } from './Composer.tsx'
import { useStore } from '../../lib/store.ts'
import { api, emit, socket } from '../../test/fakes.ts'
import { chatInfo, fresh, host } from '../../test/fixtures.ts'
import { flush, renderSettled as render } from '../../test/render.tsx'

// drafts outlive the component (per pane, in module state), so each test uses its own pane
let n = 0
const nextPane = () => `%${++n}`
const box = () => screen.getByRole('textbox') as HTMLTextAreaElement
const sendButton = () => screen.getByLabelText(/^(Send|Queue follow-up|Run command|Stop)$/) as HTMLButtonElement
const draft = (pane: string, text: string, at: number, source: 'app' | 'terminal' = 'terminal') => act(() => emit({ t: 'chat.draft', key: `box:${pane}`, text, source, at }))

describe('Composer keeps what you type while live data flows', () => {
  test('screen, info and machine refreshes do not touch the text', async () => {
    const user = userEvent.setup()
    const pane = nextPane()
    const key = `box:${pane}`
    const { rerender } = await render(<Composer host="box" pane={pane} agent="claude" working={false} />)
    await user.type(box(), 'Fix the')
    act(() => {
      emit({ t: 'chat.screen', key, screen: { working: true, width: 80, activity: 'Thinking…' } })
      emit({ t: 'chat.info', key, info: chatInfo() })
      emit({ t: 'overview', hosts: [host('box')] })
      emit({ t: 'overview', hosts: fresh([host('box')]) })
    })
    rerender(<Composer host="box" pane={pane} agent="claude" working controls={<span>new controls</span>} />)
    await user.type(box(), ' login bug')
    expect(box().value).toBe('Fix the login bug')
  })

  test("another device's draft does not replace what you're typing", async () => {
    const user = userEvent.setup()
    const pane = nextPane()
    await render(<Composer host="box" pane={pane} agent="claude" working={false} />)
    await user.type(box(), 'mine')
    draft(pane, 'theirs', 1)
    await user.type(box(), ' still')
    expect(box().value).toBe('mine still')
  })

  test("the terminal's draft is adopted when you aren't editing", async () => {
    const pane = nextPane()
    await render(<Composer host="box" pane={pane} agent="claude" working={false} />)
    draft(pane, 'typed in tmux', 1)
    expect(box().value).toBe('typed in tmux')
    expect(screen.getByText('From the terminal')).toBeTruthy()
  })

  test('typing is shared with the hub after a pause, once', async () => {
    const user = userEvent.setup()
    const pane = nextPane()
    await render(<Composer host="box" pane={pane} agent="claude" working={false} />)
    // earlier tests' timers still push their drafts (on purpose: leaving the page keeps it)
    const mine = () => socket.send.mock.calls.filter(([m]) => (m as { pane?: string }).pane === pane)
    await user.type(box(), 'hello')
    expect(mine()).toEqual([])
    await act(() => Bun.sleep(500))
    expect(mine()).toEqual([[{ t: 'draft', host: 'box', pane, text: 'hello' }]])
    // the hub saying back the same text changes nothing
    draft(pane, 'hello', 2, 'app')
    await user.type(box(), '!')
    expect(box().value).toBe('hello!')
  })

  test('the text comes back after leaving the page and returning', async () => {
    const user = userEvent.setup()
    const pane = nextPane()
    const { unmount } = await render(<Composer host="box" pane={pane} agent="claude" working={false} />)
    await user.type(box(), 'half a thought')
    unmount()
    await render(<Composer host="box" pane={pane} agent="claude" working={false} />)
    expect(box().value).toBe('half a thought')
  })
})

describe('Composer send button', () => {
  test('Send, Queue follow-up, Run command and Stop', async () => {
    const user = userEvent.setup()
    const pane = nextPane()
    const { rerender } = await render(<Composer host="box" pane={pane} agent="claude" working={false} />)
    expect(sendButton().getAttribute('aria-label')).toBe('Send')
    expect(sendButton().disabled).toBe(true)
    await user.type(box(), 'hi')
    expect(sendButton().disabled).toBe(false)
    rerender(<Composer host="box" pane={pane} agent="claude" working />)
    expect(sendButton().getAttribute('aria-label')).toBe('Queue follow-up')
    await user.clear(box())
    expect(sendButton().getAttribute('aria-label')).toBe('Stop')
    await user.type(box(), '!ls -la')
    expect(sendButton().getAttribute('aria-label')).toBe('Run command')
    expect(screen.getByText(/Shell command/)).toBeTruthy()
  })

  test("agents without shell commands send '!' text as a message", async () => {
    const user = userEvent.setup()
    await render(<Composer host="box" pane={nextPane()} agent="gemini" working={false} />)
    await user.type(box(), '!ls')
    expect(sendButton().getAttribute('aria-label')).toBe('Send')
  })

  test('sending clears the box, shows a pending bubble and posts the text', async () => {
    const user = userEvent.setup()
    const pane = nextPane()
    await render(<Composer host="box" pane={pane} agent="claude" working={false} />)
    await user.type(box(), '  ship it  ')
    await user.click(sendButton())
    await flush()
    expect(box().value).toBe('')
    const [p] = useStore.getState().chats[`box:${pane}`].pending
    expect(p).toMatchObject({ text: 'ship it', status: 'sent' })
    expect(api.send.mock.calls).toEqual([['box', pane, 'ship it', p.id]])
  })

  test('a failed send keeps the bubble with the reason', async () => {
    const user = userEvent.setup()
    const pane = nextPane()
    api.send.mockImplementation(async () => {
      throw new Error('pane is gone')
    })
    await render(<Composer host="box" pane={pane} agent="claude" working={false} />)
    await user.type(box(), 'hello{Enter}')
    await flush()
    expect(useStore.getState().chats[`box:${pane}`].pending[0]).toMatchObject({ status: 'failed', error: 'pane is gone' })
  })

  test('disabled while the machine is unreachable', async () => {
    const user = userEvent.setup()
    await render(<Composer host="box" pane={nextPane()} agent="claude" working={false} disabled />)
    await user.type(box(), 'hi')
    expect(box().value).toBe('')
    expect(sendButton().disabled).toBe(true)
  })
})

describe('the phone app hands over keyboard images', () => {
  test('a pasteFile event becomes an attachment, and stops when the composer goes', async () => {
    const listeners: Record<string, ((e: unknown) => void)[]> = {}
    ;(window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        TetherDevice: {
          addListener: (e: string, f: (e: unknown) => void) => {
            ;(listeners[e] ||= []).push(f)
            return Promise.resolve({ remove: () => (listeners[e] = listeners[e]!.filter((x) => x !== f)) })
          },
        },
      },
    }
    try {
      const { unmount } = await render(<Composer host="box" pane={nextPane()} agent="claude" working={false} />)
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      act(() => listeners.pasteFile!.forEach((f) => f({ name: 'sticker.png', type: 'image/png', data: png })))
      await flush()
      expect(screen.getByLabelText('Remove sticker.png')).toBeTruthy()
      const [, , file] = api.upload.mock.calls.at(-1) as [string, string, File]
      expect([file.name, file.type, file.size]).toEqual(['sticker.png', 'image/png', 70])
      unmount()
      await flush()
      expect(listeners.pasteFile).toEqual([])
    } finally {
      delete (window as any).Capacitor
    }
  })
})
