import { beforeEach, describe, expect, test } from 'bun:test'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Settings } from './Settings.tsx'
import { useStore } from '../lib/store.ts'
import { api, emit } from '../test/fakes.ts'
import { fresh, host } from '../test/fixtures.ts'
import { flush, renderSettled as render } from '../test/render.tsx'

const hosts = [host('box'), host('pi', { status: 'error' })]
const poll = () => act(() => emit({ t: 'overview', hosts: fresh(hosts) }))
const field = (placeholder: string) => screen.getByPlaceholderText(placeholder) as HTMLInputElement
const page = () => (
  <MemoryRouter>
    <Settings />
  </MemoryRouter>
)

beforeEach(() => {
  api.settings.mockResolvedValue({ uploads: { retentionDays: 7, maxMB: 100, longPasteLines: 40 }, autoResume: false })
  api.uploadUsage.mockResolvedValue({ bytes: 2048, files: 1, expired: 0, dir: '/home/me/.tether/uploads' })
  useStore.setState({ hosts })
})

describe('Settings keeps what you type while live data flows', () => {
  test('the change-password fields survive machine refreshes', async () => {
    const user = userEvent.setup()
    await render(page())
    await user.click(screen.getByText('Change password'))
    await user.type(field('Current password'), 'old-')
    await user.type(field('New password (8+ characters)'), 'correct')
    poll()
    poll()
    await user.type(field('Current password'), 'secret')
    await user.type(field('New password (8+ characters)'), ' horse')
    await user.type(field('New password again'), 'correct horse')
    expect(field('Current password').value).toBe('old-secret')
    expect(field('New password (8+ characters)').value).toBe('correct horse')
  })

  test('changing the password checks the two match before asking the hub', async () => {
    const user = userEvent.setup()
    await render(page())
    await user.click(screen.getByText('Change password'))
    await user.type(field('Current password'), 'old-secret')
    await user.type(field('New password (8+ characters)'), 'correct horse')
    await user.type(field('New password again'), 'correct house')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    expect(screen.getByText("The two new passwords don't match.")).toBeTruthy()
    expect(api.changePassword).not.toHaveBeenCalled()
    await user.clear(field('New password again'))
    await user.type(field('New password again'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    await flush()
    expect(api.changePassword.mock.calls).toEqual([['old-secret', 'correct horse']])
  })

  test('hub settings save the one change, keeping the rest', async () => {
    const user = userEvent.setup()
    api.saveSettings.mockImplementation(async (s) => s as any)
    await render(page())
    await user.click(screen.getByText('30 days'))
    await flush()
    expect(api.saveSettings.mock.calls[0][0]).toEqual({ uploads: { retentionDays: 30, maxMB: 100, longPasteLines: 40 }, autoResume: false })
  })

  test('appearance settings apply at once', async () => {
    const user = userEvent.setup()
    await render(page())
    await user.click(screen.getByText('Compact'))
    expect(useStore.getState().settings.toolDetail).toBe('compact')
  })
})
