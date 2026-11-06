import { beforeEach, describe, expect, test } from 'bun:test'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { VERSION } from '@inyon/protocol'
import { Settings } from './Settings.tsx'
import { useStore } from '../lib/store.ts'
import { api, emit, setSocketUp } from '../test/fakes.ts'
import { forgetHub } from '../lib/updates.ts'
import { fresh, host } from '../test/fixtures.ts'
import { flush, renderSettled as render } from '../test/render.tsx'
import { ConfirmHost } from '../components/Confirm.tsx'
import { OLD_HUB } from '../components/CustomAgents.tsx'

const hosts = [host('box'), host('pi', { status: 'error' })]
const poll = () => act(() => emit({ t: 'overview', hosts: fresh(hosts) }))
const field = (placeholder: string) => screen.getByPlaceholderText(placeholder) as HTMLInputElement
const page = () => (
  <MemoryRouter>
    <Settings />
  </MemoryRouter>
)

beforeEach(() => {
  api.settings.mockResolvedValue({ uploads: { retentionDays: 7, maxMB: 100, maxTotalMB: 1024, longPasteLines: 40 }, autoResume: false })
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
    await user.click(within(screen.getByRole('radiogroup', { name: 'Delete uploads after' })).getByText('30 days'))
    await flush()
    expect(api.saveSettings.mock.calls[0][0]).toEqual({ uploads: { retentionDays: 30, maxMB: 100, maxTotalMB: 1024, longPasteLines: 40 }, autoResume: false })
  })

  test('old blueprints are cleaned up after 14 days unless set otherwise, and on demand', async () => {
    const user = userEvent.setup()
    api.saveSettings.mockImplementation(async (s) => s as any)
    await render(page())
    const days = screen.getByRole('radiogroup', { name: 'Clean up old blueprints after' })
    expect(within(days).getByRole('radio', { name: '14 days' }).getAttribute('aria-checked')).toBe('true')
    await user.click(within(days).getByText('Never'))
    await flush()
    expect(api.saveSettings.mock.calls[0][0]).toMatchObject({ pagesCleanupDays: 0, autoResume: false })
    // now: what went, or that nothing did
    api.cleanupPages.mockResolvedValueOnce({ pages: [{ host: 'local', slug: 'a', name: 'Checkout redesign' }], days: 14 })
    await user.click(screen.getByRole('button', { name: 'Clean up' }))
    await flush()
    expect(api.cleanupPages).toHaveBeenCalledTimes(1)
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ title: 'Cleaned up “Checkout redesign”', tone: 'success' })
    api.cleanupPages.mockResolvedValueOnce({ pages: [], days: 14 })
    await user.click(screen.getByRole('button', { name: 'Clean up' }))
    await flush()
    expect(useStore.getState().toasts.at(-1)?.title).toBe('Nothing to clean up')
  })

  test('machines can message agents only once the switch is on', async () => {
    const user = userEvent.setup()
    api.saveSettings.mockImplementation(async (s) => s as any)
    await render(page())
    const toggle = screen.getByRole('switch', { name: 'Machines can message agents' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await user.click(toggle)
    await flush()
    expect(api.saveSettings.mock.calls[0][0]).toMatchObject({ machinesSend: true, autoResume: false })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  test('appearance settings apply at once', async () => {
    const user = userEvent.setup()
    await render(page())
    await user.click(screen.getByText('Compact'))
    expect(useStore.getState().settings.toolDetail).toBe('compact')
  })
})

describe('Your own agents', () => {
  const base = { uploads: { retentionDays: 7, maxMB: 100, maxTotalMB: 1024, longPasteLines: 40 }, autoResume: false }
  // the hub gives each an id from its name
  const hubSaves = () => api.saveSettings.mockImplementation(async (s: any) => ({ ...s, customAgents: s.customAgents?.map((a: any) => ({ ...a, id: a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') })) }))

  test('adding one keeps what you type through refreshes and saves it with the agent it works like', async () => {
    const user = userEvent.setup()
    hubSaves()
    await render(page())
    await user.click(screen.getByText('Add an agent'))
    await user.type(field('Claude YOLO'), 'Codex ')
    poll()
    await user.type(field('Claude YOLO'), 'OSS')
    await user.type(field('claude --dangerously-skip-permissions'), 'codex --oss')
    poll()
    await user.click(screen.getByRole('combobox', { name: 'Works like' }))
    await user.click(screen.getByRole('option', { name: /Codex/ }))
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await flush()
    expect(api.saveSettings.mock.calls[0][0]).toMatchObject({ autoResume: false, customAgents: [{ name: 'Codex OSS', command: 'codex --oss', like: 'codex' }] })
    expect(screen.getByText('Codex OSS')).toBeTruthy()
    expect(screen.getByText('Works like Codex')).toBeTruthy()
    expect(screen.getAllByText('codex --oss')).toHaveLength(2)
  })

  test('the hub refusing one shows why in the sheet, and so does a Bun hub that keeps none', async () => {
    const user = userEvent.setup()
    api.saveSettings.mockRejectedValueOnce(new Error('x: pick the agent it works like'))
    await render(page())
    await user.click(screen.getByText('Add an agent'))
    await user.type(field('Claude YOLO'), 'x')
    await user.type(field('claude --dangerously-skip-permissions'), 'x')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('x: pick the agent it works like')
    // the Bun hub answers with its settings, the list dropped
    api.saveSettings.mockImplementation(async (s: any) => ({ ...s, customAgents: undefined }))
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await flush()
    expect(screen.getByRole('alert').textContent).toBe(OLD_HUB)
  })

  test('editing renames it in place, and removing it can be undone', async () => {
    const user = userEvent.setup()
    hubSaves()
    api.settings.mockResolvedValue({ ...base, customAgents: [{ id: 'yolo', name: 'yolo', command: 'claude --dangerously-skip-permissions', like: 'claude' }] })
    await render(page())
    await user.click(screen.getByRole('button', { name: 'Options for yolo' }))
    await user.click(screen.getByText('Edit'))
    expect(field('Claude YOLO').value).toBe('yolo')
    await user.type(field('Claude YOLO'), '2')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await flush()
    expect(api.saveSettings.mock.calls[0][0].customAgents as unknown[]).toEqual([{ name: 'yolo2', command: 'claude --dangerously-skip-permissions', like: 'claude' }])
    await user.click(screen.getByRole('button', { name: 'Options for yolo2' }))
    await user.click(screen.getByText('Remove'))
    await flush()
    expect(api.saveSettings.mock.calls[1][0].customAgents as unknown[]).toEqual([])
    expect(screen.queryByText('yolo2')).toBeNull()
    const toast = useStore.getState().toasts.at(-1)!
    expect(toast.title).toBe('Removed yolo2')
    await act(async () => toast.action!.onSelect())
    await flush()
    expect(api.saveSettings.mock.calls[2][0].customAgents as unknown[]).toEqual([{ id: 'yolo2', name: 'yolo2', command: 'claude --dangerously-skip-permissions', like: 'claude' }])
    expect(screen.getByText('yolo2')).toBeTruthy()
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
    const url = 'https://inyon.tech/download/inyon-0.6.4.apk'
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

describe('Paired devices', () => {
  const legato = { id: 'c1', name: 'Legato on test-laptop', app: 'Legato for Windows', scopes: ['overview', 'chat', 'answer', 'send'] as const, contractVersion: 1, pairedAt: Date.now() - 86_400_000, lastSeen: Date.now() - 120_000 }

  test('lists each companion app with its contract and what it may do', async () => {
    api.companions.mockResolvedValue([{ ...legato, scopes: [...legato.scopes] }])
    api.phones.mockResolvedValue([])
    await render(page())
    await flush()
    expect(screen.getByText('Legato on test-laptop')).toBeTruthy()
    expect(screen.getByText('contract v1')).toBeTruthy()
    expect(screen.getByText(/Legato for Windows · paired .* · seen 2 min ago/)).toBeTruthy()
    for (const s of ['Overview', 'Chats', 'Answer', 'Send']) expect(screen.getAllByText(s).length).toBeGreaterThan(0)
    expect(screen.getByText('No phones paired.')).toBeTruthy()
  })

  test('Remove asks first, then ends it at the hub', async () => {
    const user = userEvent.setup()
    api.companions.mockResolvedValue([{ ...legato, scopes: [...legato.scopes] }])
    api.forgetCompanion.mockResolvedValue({ ok: true })
    await render(
      <>
        {page()}
        <ConfirmHost />
      </>,
    )
    await flush()
    await user.click(screen.getByRole('button', { name: 'Options for Legato on test-laptop' }))
    await user.click(screen.getByText('Remove'))
    await flush()
    expect(api.forgetCompanion).not.toHaveBeenCalled()
    expect(screen.getByText('Remove Legato on test-laptop?')).toBeTruthy()
    api.companions.mockResolvedValue([])
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await flush()
    expect(api.forgetCompanion.mock.calls).toEqual([['c1']])
    expect(screen.getByText(/No companion apps/)).toBeTruthy()
  })

  test('What it can do lists the scopes and what the hub refuses', async () => {
    const user = userEvent.setup()
    api.companions.mockResolvedValue([{ ...legato, scopes: [...legato.scopes] }])
    await render(page())
    await flush()
    await user.click(screen.getByRole('button', { name: 'Options for Legato on test-laptop' }))
    await user.click(screen.getByText('What it can do'))
    await flush()
    expect(screen.getByText('Answer a prompt, once, with its prompt key')).toBeTruthy()
    expect(screen.getByText('Interrupt, terminal, files, settings')).toBeTruthy()
  })
})

describe('Put idle agents to sleep', () => {
  test('turns up when the hub keeps it, and shows a time set some other way', async () => {
    const org = { v: 1, sessions: [], projects: [], groups: [], spaces: [] }
    act(() => emit({ t: 'overview', hosts: fresh(hosts), organize: org }))
    await render(page())
    expect(screen.queryByText('Put idle agents to sleep')).toBeNull()
    // the hub moves on to a record that has it, with 15 minutes set through the API
    await act(async () => emit({ t: 'overview', hosts: useStore.getState().hosts, organize: { ...org, v: 2, sleep: [{ scope: 'all', minutes: 15 }] } }))
    expect(screen.getByText('Put idle agents to sleep')).toBeTruthy()
    expect(screen.getByRole('radio', { name: '15 min' }).getAttribute('aria-checked')).toBe('true')
    act(() => emit({ t: 'overview', hosts: [] }))
  })
})

describe('Settings › Blueprints › shared links', () => {
  const link = { id: 'a1', host: 'box', slug: 'plan', public: true, created: Date.now() - 86_400_000, expires: Date.now() + 6 * 86_400_000 + 3_600_000, opens: 4 }
  const passed = { address: 'https://share.example.com', dns: { ok: true, addresses: ['203.0.113.4'] }, reach: { ok: true }, wall: { ok: true, open: [] } }
  test('off by default; Set up walks through the name, DNS and proxy, then saves and checks', async () => {
    const user = userEvent.setup()
    api.shares.mockResolvedValue({ address: null, fromEnv: false, upstream: '127.0.0.1:4777', links: [] })
    api.setShareAddress.mockResolvedValue({ address: 'https://share.example.com', fromEnv: false, upstream: '127.0.0.1:4777', links: [] })
    api.checkShareAddress.mockResolvedValue(passed)
    await render(page())
    expect(screen.getByText('Off. Links stay on your network until you set one up.')).toBeTruthy()
    expect(screen.getByText('None live. Share a blueprint from its ⋯ menu.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Set up' }))
    const sheet = screen.getByRole('dialog', { name: 'Address for shared links' })
    // a main domain gets the subdomain advice
    const input = within(sheet).getByRole('textbox', { name: 'Name for shared links' }) as HTMLInputElement
    await user.type(input, 'example.com')
    expect(within(sheet).getByRole('status').textContent).toMatch(/main domain.*share\.example\.com/)
    await user.clear(input)
    await user.type(input, 'share.example.com')
    expect(within(sheet).queryByRole('status')).toBeNull()
    // the record and the proxy example follow the name, with the hub's own port
    expect(within(sheet).getByRole('cell', { name: 'share' })).toBeTruthy()
    expect(within(sheet).getByText(/handle \/share\/\*/).textContent).toContain('reverse_proxy 127.0.0.1:4777')
    await user.click(within(sheet).getByRole('radio', { name: 'nginx' }))
    expect(within(sheet).getByText(/proxy_set_header Host \$host;/)).toBeTruthy()
    await user.click(within(sheet).getByRole('button', { name: 'Save and check' }))
    expect(api.setShareAddress.mock.calls).toEqual([['https://share.example.com']])
    expect(api.checkShareAddress).toHaveBeenCalledTimes(1)
    expect(within(sheet).getByText('Links reach this hub')).toBeTruthy()
    expect(within(sheet).getByText('Nothing else answers there')).toBeTruthy()
  })

  test("a refused address says why in the sheet, and a failed check says what to fix", async () => {
    const user = userEvent.setup()
    api.shares.mockResolvedValue({ address: null, fromEnv: false, links: [] })
    api.setShareAddress.mockRejectedValue(new Error("That's the address you're using Inyon at."))
    await render(page())
    await user.click(screen.getByRole('button', { name: 'Set up' }))
    const sheet = screen.getByRole('dialog', { name: 'Address for shared links' })
    await user.type(within(sheet).getByRole('textbox', { name: 'Name for shared links' }), 'hub.test')
    await user.click(within(sheet).getByRole('button', { name: 'Save and check' }))
    expect(within(sheet).getByRole('alert').textContent).toBe("That's the address you're using Inyon at.")
  })

  test('a saved address shows on the row even when its check fails, and a check hides once the name changes', async () => {
    const user = userEvent.setup()
    api.shares.mockResolvedValue({ address: null, fromEnv: false, links: [] })
    api.setShareAddress.mockResolvedValue({ address: 'https://share.example.com', fromEnv: false, links: [] })
    api.checkShareAddress.mockRejectedValueOnce(new Error('The hub took too long to answer.'))
    await render(page())
    await user.click(screen.getByRole('button', { name: 'Set up' }))
    const sheet = screen.getByRole('dialog', { name: 'Address for shared links' })
    const input = within(sheet).getByRole('textbox', { name: 'Name for shared links' })
    await user.type(input, 'share.example.com')
    await user.click(within(sheet).getByRole('button', { name: 'Save and check' }))
    expect(within(sheet).getByRole('alert').textContent).toBe('The hub took too long to answer.')
    expect(screen.getByText('Links for anyone open here.', { exact: false })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy()
    // the saved name now only needs a check, and its result goes once the name is edited
    api.checkShareAddress.mockResolvedValue(passed)
    await user.click(within(sheet).getByRole('button', { name: 'Check' }))
    expect(within(sheet).getByText('Links reach this hub')).toBeTruthy()
    await user.type(input, 'x')
    expect(within(sheet).queryByText('Links reach this hub')).toBeNull()
    expect(within(sheet).queryByRole('button', { name: 'Done' })).toBeNull()
  })

  test('Change keeps an http address or a port as saved, and a name no certificate fits is not saved', async () => {
    const user = userEvent.setup()
    api.shares.mockResolvedValue({ address: 'http://share.example.com:8080', fromEnv: false, links: [] })
    await render(page())
    await user.click(screen.getByRole('button', { name: 'Change' }))
    const sheet = screen.getByRole('dialog', { name: 'Address for shared links' })
    const input = within(sheet).getByRole('textbox', { name: 'Name for shared links' }) as HTMLInputElement
    expect(input.value).toBe('http://share.example.com:8080')
    expect(within(sheet).getByRole('button', { name: 'Check' })).toBeTruthy()
    await user.clear(input)
    await user.type(input, 'share{{.example.com')
    expect(within(sheet).getByRole('status').textContent).toMatch(/letters, digits and hyphens/)
    expect((within(sheet).getByRole('button', { name: 'Save and check' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(sheet).getByText(/handle \/share\/\*/).textContent).toContain('share.example.com {')
  })

  test('Check on the row shows what the hub found', async () => {
    const user = userEvent.setup()
    api.shares.mockResolvedValue({ address: 'https://share.example.com', fromEnv: false, links: [] })
    api.checkShareAddress.mockResolvedValue({ ...passed, reach: { ok: false, fault: 'not-hub', status: 421 }, wall: { ok: false, open: [] } })
    await render(page())
    expect(screen.getByText('share.example.com')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Check' }))
    expect(screen.getByText('share.example.com answered 421, but not from this hub')).toBeTruthy()
    expect(screen.getByText('The last check found something to fix.', { exact: false })).toBeTruthy()
  })

  test('an address set by INYON_SHARE_ORIGIN is shown, not changed here', async () => {
    const user = userEvent.setup()
    api.shares.mockResolvedValue({ address: 'https://share.example.com', fromEnv: true, links: [] })
    await render(page())
    expect(screen.getByText(/Set by INYON_SHARE_ORIGIN\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Guide' }))
    const sheet = screen.getByRole('dialog', { name: 'Address for shared links' })
    expect((within(sheet).getByRole('textbox', { name: 'Name for shared links' }) as HTMLInputElement).readOnly).toBe(true)
    expect(within(sheet).getByRole('button', { name: 'Check' })).toBeTruthy()
  })

  test('Turn off asks first, then clears the address', async () => {
    const user = userEvent.setup()
    api.shares.mockResolvedValue({ address: 'https://share.example.com', fromEnv: false, links: [] })
    api.setShareAddress.mockResolvedValue({ address: null, fromEnv: false, links: [] })
    await render(
      <MemoryRouter>
        <Settings />
        <ConfirmHost />
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: 'Turn off' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Turn off the public address?' })).getByRole('button', { name: 'Turn off' }))
    await flush()
    expect(api.setShareAddress.mock.calls).toEqual([['']])
    expect(screen.getByText('Off. Links stay on your network until you set one up.')).toBeTruthy()
  })

  test('every live link with Revoke, and Revoke all after asking', async () => {
    const user = userEvent.setup()
    api.shares.mockResolvedValue({ address: 'https://share.example.com', fromEnv: false, links: [link, { ...link, id: 'b2', public: false, slug: 'other' }] })
    await render(
      <MemoryRouter>
        <Settings />
        <ConfirmHost />
      </MemoryRouter>,
    )
    expect(screen.getByText(/^Anyone with the link · ends in 6 days · 4 opens/)).toBeTruthy()
    expect(screen.getByText('other')).toBeTruthy()
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!)
    await flush()
    expect(api.revokeShare.mock.calls).toEqual([['a1']])
    expect(screen.getAllByRole('button', { name: 'Revoke' }).length).toBe(1)
    await user.click(screen.getByRole('button', { name: 'Revoke all' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Revoke the shared link?' })).getByRole('button', { name: 'Revoke all' }))
    await flush()
    expect(api.revokeAllShares.mock.calls.length).toBe(1)
    expect(screen.getByText('None live. Share a blueprint from its ⋯ menu.')).toBeTruthy()
  })
})
