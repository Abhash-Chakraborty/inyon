import { beforeEach, describe, expect, test } from 'bun:test'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Home } from './Home.tsx'
import { useStore } from '../lib/store.ts'
import { api } from '../test/fakes.ts'
import { agentPane, host } from '../test/fixtures.ts'
import { flush, renderSettled as render } from '../test/render.tsx'

const asking = (id = '%1', title = 'Failing tests') =>
  agentPane(id, 'claude', { title, agent: { kind: 'claude', pid: 1, state: 'waiting', waitingFor: 'Bash command: npm test', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] } })

const home = () =>
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/m/:host/p/:pane" element={<p>chat open</p>} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => useStore.setState({ hostsLoaded: true, toasts: [], connected: true }))

describe('agent sessions', () => {
  test('when every session is under Needs you, the list below adds nothing, not an empty filter', async () => {
    useStore.setState({ hosts: [host('box', { panes: [asking()] })] })
    await home()
    expect(screen.getByText('Needs you')).toBeTruthy()
    expect(screen.queryByText('Nothing here')).toBeNull()
    expect(screen.queryByText('Try another filter.')).toBeNull()
    expect(screen.queryByText('Agent sessions')).toBeNull()
  })

  test('with others idle, the list shows them', async () => {
    useStore.setState({ hosts: [host('box', { panes: [asking(), agentPane('%2', 'claude', { title: 'Write docs' })] })] })
    await home()
    expect(screen.getByText('Agent sessions')).toBeTruthy()
    expect(screen.getByText('Write docs')).toBeTruthy()
  })

  test("a Needs-you card's session name opens its chat", async () => {
    useStore.setState({ hosts: [host('box', { panes: [asking()] })] })
    await home()
    await userEvent.click(screen.getByText('Failing tests'))
    expect(screen.getByText('chat open')).toBeTruthy()
  })
})

describe('turning the integration on from the overview', () => {
  const off = () => host('box', { integration: 'missing' })

  test('the card keeps a spinner until the machine answers, then says it is on', async () => {
    let done!: () => void
    api.integration.mockImplementationOnce(() => new Promise<any>((r) => (done = () => r({ ok: true }))))
    useStore.setState({ hosts: [off()] })
    await home()
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(api.integration).toHaveBeenCalledWith('box', true)
    // the hub reports the new state before the request returns: the card stays, busy
    act(() => useStore.setState({ hosts: [host('box', { integration: 'installed' })] }))
    const button = screen.getByRole('button', { name: /Turning on/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText(/turn on the integration for live usage limits/)).toBeTruthy()
    done()
    await flush()
    expect(screen.queryByRole('button', { name: /Turn/ })).toBeNull()
    expect(useStore.getState().toasts.map((t) => [t.title, t.tone])).toEqual([['Claude integration on', 'success']])
  })

  test('a failure says so, and the card stays to try again', async () => {
    api.integration.mockImplementationOnce(async () => {
      throw new Error('settings.json is not valid JSON')
    })
    useStore.setState({ hosts: [off()] })
    await home()
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await flush()
    expect(useStore.getState().toasts.map((t) => [t.title, t.body, t.tone])).toEqual([['Could not turn on the integration', 'settings.json is not valid JSON', 'error']])
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeTruthy()
  })
})
