import { beforeEach, expect, test } from 'bun:test'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent } from '@testing-library/react'
import { MachinesTable, NeedsYouCard, SessionCard, activityLabel } from './Overview.tsx'
import { ContextMenuHost } from './ui/ContextMenu.tsx'
import { ActionSheets } from './menus.tsx'
import { useStore } from '../lib/store.ts'
import { allPanes } from '../lib/overview.ts'
import { api } from '../test/fakes.ts'
import { agentPane, host } from '../test/fixtures.ts'
import { flush, renderSettled as render } from '../test/render.tsx'

const asking = () => host('box', { panes: [agentPane('%1', 'codex', { title: 'Migrate auth', agent: { kind: 'codex', pid: 1, state: 'waiting', waitingFor: 'Run the tests?', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] } })] })

beforeEach(() => useStore.setState({ hosts: [asking()], hostsLoaded: true, toasts: [] }))

// "needs you" stayed on a question long after it was answered at the keyboard
test('recent activity says needs you only while the session is still on that question', () => {
  const ev = (id: number, pane = '%1', kind: 'waiting' | 'done' = 'waiting') => ({ id, at: id, host: 'box', pane, kind, title: 'Migrate auth', body: '' })
  const [newer, older] = [ev(2), ev(1)]
  const feed = [newer, older]
  const waiting = [asking()]
  expect(activityLabel(newer, feed, waiting)).toBe('needs you')
  expect(activityLabel(older, feed, waiting)).toBe('answered')
  const moved = [host('box', { panes: [agentPane('%1', 'codex', { agent: { kind: 'codex', pid: 1, state: 'working' } })] })]
  expect(activityLabel(newer, feed, moved)).toBe('answered')
  expect(activityLabel(ev(3, '%7'), feed, waiting)).toBe('asked')
  expect(activityLabel(ev(4, '%1', 'done'), feed, waiting)).toBe('finished')
})

test('an answer reads Sending…, then Sent', async () => {
  let release!: () => void
  api.answer.mockImplementationOnce(() => new Promise<any>((r) => (release = () => r({}))))
  const r = allPanes(useStore.getState().hosts)[0]!
  await render(
    <MemoryRouter>
      <NeedsYouCard r={r} />
    </MemoryRouter>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Yes' }))
  expect(screen.getByRole('button', { name: 'Sending…' })).toBeTruthy()
  expect(api.answer).toHaveBeenCalledWith('box', '%1', 1)
  release()
  await flush()
  expect(screen.getByText('Sent')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'No' })).toBeNull()
})

test('a session card and a machine offer the same actions on a right-click as in their menus', async () => {
  const working = host('box', { panes: [agentPane('%1', 'claude', { title: 'Fix login', agent: { kind: 'claude', pid: 1, state: 'idle', sessionId: '0b7c2f8e-1d2a-4c1e-9a55-3f2e6d1c9b10' } })] })
  useStore.setState({ hosts: [working] })
  const r = allPanes(useStore.getState().hosts)[0]!
  await render(
    <MemoryRouter>
      <SessionCard r={r} />
      <MachinesTable hosts={[working]} />
      <ActionSheets />
      <ContextMenuHost />
    </MemoryRouter>,
  )
  const items = () => screen.getAllByRole('menuitem').map((b) => b.textContent)
  fireEvent.contextMenu(screen.getByText('Fix login'), { clientX: 10, clientY: 10 })
  expect(items()).toEqual(['Open', 'Open terminal', 'Open in new tab', 'Rename…', 'Past conversations…', 'Copy session ID', 'End session…'])
  // the same list as the card's ⋯ button
  fireEvent.keyDown(window, { key: 'Escape' })
  await userEvent.click(screen.getByRole('button', { name: 'Actions for Fix login' }))
  expect(items()).toEqual(['Open', 'Open terminal', 'Open in new tab', 'Rename…', 'Past conversations…', 'Copy session ID', 'End session…'])
  await userEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }))
  expect(screen.getByRole('dialog', { name: 'Rename session' })).toBeTruthy()

  fireEvent.contextMenu(screen.getAllByText('box')[0]!, { clientX: 10, clientY: 10 })
  expect(items()).toEqual(['Open', 'New session', 'Open in new tab', 'Edit…', 'Remove…'])
})
