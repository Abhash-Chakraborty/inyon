import { expect, test } from 'bun:test'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { ConversationSearch } from '@inyon/protocol'
import { QuickSwitch } from './QuickSwitch.tsx'
import { useStore } from '../lib/store.ts'
import { SETTLE_MS } from '../lib/conversationSearch.ts'
import { agentPane, host } from '../test/fixtures.ts'
import { api } from '../test/fakes.ts'
import { renderSettled as render } from '../test/render.tsx'

const now = Date.now()
const answer: ConversationSearch = {
  query: 'oauth',
  machines: [
    {
      host: 'laptop',
      name: 'Laptop',
      hits: [
        { agent: 'claude', id: '00000000-0000-4000-8000-000000000001', cwd: '/home/me/app', title: 'Auth work', at: now - 3600_000, snippet: 'We fixed the OAuth token refresh in auth.ts' },
        { agent: 'codex', id: '00000000-0000-4000-8000-000000000002', title: 'No folder known', at: now - 7200_000, snippet: 'oauth' },
      ],
    },
    { host: 'server', name: 'Server', hits: [], error: 'Took too long to answer' },
    { host: 'old', name: 'Old box', hits: [], skipped: 'Offline' },
  ],
}

function Where() {
  const loc = useLocation()
  return <div data-testid="where">{loc.pathname + loc.search}</div>
}

const palette = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <QuickSwitch open onClose={() => {}} />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
const box = () => screen.getByRole('textbox') as HTMLInputElement
const type = (text: string) => act(() => void fireEvent.change(box(), { target: { value: text } }))
const key = (k: string) => act(() => void fireEvent.keyDown(box(), { key: k }))
const settle = () => act(() => new Promise((r) => setTimeout(r, SETTLE_MS + 50)))

test('sessions offer to search past conversations for the same words, which then come grouped by machine', async () => {
  useStore.setState({ hosts: [host('laptop', { config: { id: 'laptop', kind: 'ssh', name: 'Laptop' }, panes: [agentPane('%1', 'claude')] })] })
  api.searchConversations.mockImplementation(async () => answer)
  await palette()
  await type('oauth')
  expect(api.searchConversations).not.toHaveBeenCalled()
  // past the sessions (none match), Enter on the offer switches over and searches
  await key('Enter')
  expect(screen.getByRole('radio', { name: 'Conversations' }).getAttribute('aria-checked')).toBe('true')
  await settle()
  expect(api.searchConversations.mock.calls.map((c) => c[0])).toEqual(['oauth'])

  const laptop = screen.getByRole('region', { name: 'Laptop' })
  expect(within(laptop).getByText('Auth work')).toBeTruthy()
  expect(within(laptop).getByText('1h ago')).toBeTruthy()
  // the words are marked in the snippet, in the case they were written
  expect([...laptop.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['OAuth', 'oauth'])
  expect(within(laptop).getByText('~/app')).toBeTruthy()
  expect(within(screen.getByRole('region', { name: 'Server' })).getByText("Couldn't search here: Took too long to answer")).toBeTruthy()
  expect(screen.getByText('Not searched (offline): Old box')).toBeTruthy()
})

test('picking a conversation offers to resume it in a new session in its folder, and Enter does', async () => {
  useStore.setState({ hosts: [] })
  api.searchConversations.mockImplementation(async () => answer)
  api.launch.mockImplementation(async () => ({ pane: '%9' }))
  await palette()
  await act(() => void fireEvent.click(screen.getByRole('radio', { name: 'Conversations' })))
  await type('oauth')
  await settle()
  await key('Enter')
  const row = screen.getByText('Auth work').closest('[data-active]') as HTMLElement
  expect(within(row).getByRole('button', { name: /Open the folder/ })).toBeTruthy()
  await key('Enter')
  expect(api.launch.mock.calls).toEqual([['laptop', { agent: 'claude', cwd: '/home/me/app', resume: '00000000-0000-4000-8000-000000000001' }]])
  expect(screen.getByTestId('where').textContent).toBe('/m/laptop/p/9')
})

test('open the folder starts a terminal there; a conversation with no folder says why it cannot resume', async () => {
  useStore.setState({ hosts: [] })
  api.searchConversations.mockImplementation(async () => answer)
  api.launch.mockImplementation(async () => ({ pane: '%3' }))
  await palette()
  await act(() => void fireEvent.click(screen.getByRole('radio', { name: 'Conversations' })))
  await type('oauth')
  await settle()
  await act(() => void fireEvent.click(screen.getByText('No folder known')))
  expect(screen.getByText(/doesn't say which folder it ran in/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Resume in a new session/ })).toBeNull()
  await act(() => void fireEvent.click(screen.getByText('Auth work')))
  await act(() => void fireEvent.click(screen.getByRole('button', { name: /Open the folder/ })))
  expect(api.launch.mock.calls).toEqual([['laptop', { agent: 'shell', cwd: '/home/me/app' }]])
  expect(screen.getByTestId('where').textContent).toBe('/m/laptop/p/3?view=terminal')
})

test('too few characters are not searched, and a failed search says why', async () => {
  useStore.setState({ hosts: [] })
  api.searchConversations.mockImplementation(async () => {
    throw new Error('Not signed in')
  })
  await palette()
  await act(() => void fireEvent.click(screen.getByRole('radio', { name: 'Conversations' })))
  expect(screen.getByText('Find a past conversation on any machine by what was said in it.')).toBeTruthy()
  await type('oa')
  await settle()
  expect(screen.getByText('Type at least 3 characters.')).toBeTruthy()
  expect(api.searchConversations).not.toHaveBeenCalled()
  await type('oauth')
  await settle()
  expect(screen.getByText("Couldn't search: Not signed in")).toBeTruthy()
})
