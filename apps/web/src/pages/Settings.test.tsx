import { beforeEach, describe, expect, test } from 'bun:test'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { VERSION } from '@inyon/protocol'
import { Settings } from './Settings.tsx'
import { useStore } from '../lib/store.ts'
import { api, emit, setSocketUp } from '../test/fakes.ts'
import { forgetHub } from '../lib/updates.ts'
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
  api.uploadUsage.mockResolvedValue({ bytes: 2048, files: 1, expired: 0, dir: '/home/me/.inyon/uploads' })
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

describe('About', () => {
  test('shows the version and copies it for a bug report', async () => {
    const user = userEvent.setup()
    const copied: string[] = []
    const clipboard = navigator.clipboard
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } })
    await render(page())
    expect(screen.getByText(VERSION)).toBeTruthy()
    await user.click(screen.getByText('Copy version details'))
    await flush()
    expect(copied[0]).toStartWith(`Inyon ${VERSION}`)
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
    delete (window as any).isSecureContext
  })

  test('Support Inyon opens the sponsor page in a new tab', async () => {
    const user = userEvent.setup()
    const opened: string[] = []
    const open = window.open
    window.open = ((url: string) => (opened.push(url), null)) as typeof window.open
    try {
      await render(page())
      await user.click(screen.getByText('Support Inyon'))
      expect(opened).toEqual(['https://github.com/sponsors/Abhash-Chakraborty'])
    } finally {
      window.open = open
    }
  })
})

describe('while the hub answers', () => {
  test("hub settings show as the rows they'll become, each saying what it loads", async () => {
    api.settings.mockReturnValue(new Promise(() => {}))
    const { container } = await render(page())
    expect(screen.getByText('Loading hub settings')).toBeTruthy()
    expect(screen.getByText('Loading upload settings')).toBeTruthy()
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThanOrEqual(3)
    expect(container.querySelector('.animate-spin')).toBeNull()
  })
})

describe('Updates', () => {
  const status = (o: Partial<import('../lib/api.ts').HubUpdate> = {}) => ({ current: '0.6.3', canUpdate: true, checkedAt: Date.now(), behind: 0, ...o })
  beforeEach(() => forgetHub())

  test('checking shows a row-shaped skeleton that says so', async () => {
    api.hubUpdate.mockReturnValue(new Promise(() => {}))
    const { container } = await render(page())
    expect(screen.getByText('Checking the hub for updates')).toBeTruthy()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  test('an up-to-date hub says so and can check again', async () => {
    const user = userEvent.setup()
    api.hubUpdate.mockResolvedValue(status())
    await render(page())
    expect(screen.getByText('Up to date')).toBeTruthy()
    expect(screen.getByText('This hub runs 0.6.3.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    await flush()
    expect(api.hubUpdate.mock.calls.at(-1)).toEqual([true])
  })

  test('a new release: Update starts it, and the hub coming back on a new version ends it', async () => {
    const user = userEvent.setup()
    api.session.mockResolvedValue({ authed: true, version: '0.6.3', commit: 'aaa1111' })
    act(() => setSocketUp(true))
    api.hubUpdate.mockResolvedValue(status({ latest: '0.6.10', behind: 4 }))
    await render(page())
    expect(screen.getByText('Update available: 0.6.10')).toBeTruthy()
    expect(screen.getByText(/4 new commits to pull/)).toBeTruthy()
    api.startHubUpdate.mockResolvedValue({ started: true })
    await user.click(screen.getByRole('button', { name: 'Update' }))
    await flush()
    expect(api.startHubUpdate).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Updating the hub…')).toBeTruthy()
    expect(document.querySelector('.pulse-soft')).toBeTruthy()
    expect(document.querySelector('.animate-spin')).toBeNull()
    // the hub restarts on the new code
    api.session.mockResolvedValue({ authed: true, version: '0.6.10', commit: 'bbb2222' })
    api.hubUpdate.mockResolvedValue(status({ current: '0.6.10' }))
    act(() => setSocketUp(false))
    act(() => setSocketUp(true))
    await flush()
    await flush()
    expect(screen.queryByText('Updating the hub…')).toBeNull()
    expect(screen.getByText('This hub runs 0.6.10.')).toBeTruthy()
  })

  test("tapping Update before the hub's build is known doesn't end the update at the first reconnect", async () => {
    const user = userEvent.setup()
    api.session.mockResolvedValue({ authed: true, version: '0.6.3', commit: 'aaa1111' })
    api.hubUpdate.mockResolvedValue(status({ latest: '0.6.4' }))
    api.startHubUpdate.mockResolvedValue({ started: true })
    await render(page())
    await user.click(screen.getByRole('button', { name: 'Update' }))
    await flush()
    // the old hub, still running while the update installs
    act(() => setSocketUp(true))
    await flush()
    expect(screen.getByText('Updating the hub…')).toBeTruthy()
    expect(api.hubUpdate).toHaveBeenCalledTimes(1)
  })

  test("a checkout that can't update says why, with no button", async () => {
    api.hubUpdate.mockResolvedValue(status({ latest: '0.6.4', canUpdate: false, reason: 'The checkout has local changes. Commit or stash them first.' }))
    await render(page())
    expect(screen.getByText('Update available: 0.6.4')).toBeTruthy()
    expect(screen.getByText(/The checkout has local changes/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  })

  test('a failed update shows why and where its log is', async () => {
    api.hubUpdate.mockResolvedValue(status({ latest: '0.6.4', error: 'Building the web app failed.', log: '/home/me/.inyon/hub-update.log' }))
    await render(page())
    expect(screen.getByText(/Building the web app failed\./)).toBeTruthy()
    expect(screen.getByText(/hub-update\.log/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  test('an update still running from before shows as running', async () => {
    api.hubUpdate.mockResolvedValue(status({ latest: '0.6.4', running: true }))
    await render(page())
    expect(screen.getByText('Updating the hub…')).toBeTruthy()
  })

  test('in the Android app: the newer APK, with Download opening it in the browser', async () => {
    const user = userEvent.setup()
    const realFetch = globalThis.fetch
    const open = window.open
    const opened: string[] = []
    window.open = ((url: string) => (opened.push(url), null)) as typeof window.open
    ;(window as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { App: { getInfo: async () => ({ version: '0.6.3', build: '7' }) } } }
    const url = 'https://inyon.abhashchakraborty.tech/download/inyon-0.6.4.apk'
    globalThis.fetch = (async () => Response.json({ version: '0.6.4', tag: 'v0.6.4', files: [{ name: 'inyon.apk' }, { name: 'inyon-0.6.4.apk' }] })) as unknown as typeof fetch
    try {
      await render(page())
      await flush()
      expect(screen.getByText('Update available: 0.6.4')).toBeTruthy()
      expect(api.hubUpdate).not.toHaveBeenCalled()
      await user.click(screen.getByRole('button', { name: 'Download' }))
      expect(opened).toEqual([url])
    } finally {
      delete (window as any).Capacitor
      globalThis.fetch = realFetch
      window.open = open
    }
  })
})
