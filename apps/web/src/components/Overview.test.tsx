import { beforeEach, expect, test } from 'bun:test'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { NeedsYouCard } from './Overview.tsx'
import { useStore } from '../lib/store.ts'
import { allPanes } from '../lib/overview.ts'
import { api } from '../test/fakes.ts'
import { agentPane, host } from '../test/fixtures.ts'
import { flush, renderSettled as render } from '../test/render.tsx'

const asking = () => host('box', { panes: [agentPane('%1', 'codex', { title: 'Migrate auth', agent: { kind: 'codex', pid: 1, state: 'waiting', waitingFor: 'Run the tests?', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] } })] })

beforeEach(() => useStore.setState({ hosts: [asking()], hostsLoaded: true, toasts: [] }))

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
