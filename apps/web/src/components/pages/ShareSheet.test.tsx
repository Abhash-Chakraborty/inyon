import { beforeEach, describe, expect, test } from 'bun:test'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { PageEntry } from '@inyon/protocol'
import { ShareSheet } from './ShareSheet.tsx'
import { pageMenu, type PageMachine } from './shared.tsx'
import { pageId, type Page } from '../../lib/pages.ts'
import type { ShareLink, ShareList } from '../../lib/api.ts'
import { api } from '../../test/fakes.ts'
import { flush, renderSettled as render } from '../../test/render.tsx'

const NOW = Date.now()
const DAY = 86_400_000
const e: PageEntry = { host: 'local', slug: 'plan', name: 'Checkout plan', project: '/home/me/shop', by: 'claude', added: NOW - DAY, folder: '/home/me/shop/private/plans/checkout' }
const PAGE: Page = { ...e, id: pageId(e.host, e.slug) }
const link = (more: Partial<ShareLink> = {}): ShareLink => ({ id: 'a1b2c3', host: 'local', slug: 'plan', public: false, created: NOW - DAY, expires: NOW + 6 * DAY, opens: 2, ...more })
const list = (more: Partial<ShareList> = {}): ShareList => ({ address: null, fromEnv: false, links: [], ...more })

const sheet = () =>
  render(
    <MemoryRouter>
      <ShareSheet page={PAGE} open onClose={() => {}} />
    </MemoryRouter>,
  )

beforeEach(() => {
  api.pageShares.mockResolvedValue(list())
})

describe('Share…', () => {
  test('your network is the default; anyone needs the share address first, and says where to set it', async () => {
    await sheet()
    const network = screen.getByRole('radio', { name: /People on your network/ })
    const anyone = screen.getByRole('radio', { name: /Anyone with the link/ })
    expect(network.getAttribute('aria-checked')).toBe('true')
    expect(anyone.getAttribute('aria-disabled')).toBe('true')
    expect(within(anyone).getByRole('link', { name: 'Settings › Blueprints' }).getAttribute('href')).toBe('/settings#blueprints')
    await userEvent.setup().click(anyone)
    expect(anyone.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('None yet.')).toBeTruthy()
  })

  test('Create link makes a network link for the days picked and shows it whole, on the address the app is at', async () => {
    const user = userEvent.setup()
    api.sharePage.mockResolvedValue({ ...link({ id: 'n3w', opens: 0 }), url: '/share/AbCdEfGhIjKlMnOpQrStUv/' })
    await sheet()
    await user.click(screen.getByRole('radio', { name: '30 days' }))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(api.sharePage.mock.calls).toEqual([['local', 'plan', { public: false, days: 30 }]])
    expect(screen.getByTestId('share-url').textContent).toBe(`${location.origin}/share/AbCdEfGhIjKlMnOpQrStUv/`)
    expect(screen.getByText(/the hub keeps only a fingerprint of it/)).toBeTruthy()
    // the list is asked for again, with the new link in it
    expect(api.pageShares.mock.calls.length).toBe(2)
  })

  test('with an address set, a link for anyone is made there, with a line on what it opens', async () => {
    const user = userEvent.setup()
    api.pageShares.mockResolvedValue(list({ address: 'https://share.example.com' }))
    api.sharePage.mockResolvedValue({ ...link({ public: true, opens: 0 }), url: 'https://share.example.com/share/AbCdEfGhIjKlMnOpQrStUv/' })
    await sheet()
    const anyone = screen.getByRole('radio', { name: /Anyone with the link/ })
    expect(within(anyone).getByText('Opens at share.example.com, through the proxy you set up.')).toBeTruthy()
    await user.click(anyone)
    expect(screen.getByText(/research notes too/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(api.sharePage.mock.calls[0]).toEqual(['local', 'plan', { public: true, days: 7 }])
    expect(screen.getByTestId('share-url').textContent).toBe('https://share.example.com/share/AbCdEfGhIjKlMnOpQrStUv/')
  })

  test('the keys move between the choices, skipping one that is off', async () => {
    const user = userEvent.setup()
    await sheet()
    screen.getByRole('radio', { name: /People on your network/ }).focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('radio', { name: /People on your network/ }).getAttribute('aria-checked')).toBe('true')
  })

  test('a refusal from the hub shows in the sheet', async () => {
    const user = userEvent.setup()
    api.sharePage.mockRejectedValue(new Error('This hub has 500 live shared links. Revoke some first.'))
    await sheet()
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(screen.getByRole('alert').textContent).toBe('This hub has 500 live shared links. Revoke some first.')
  })

  test('live links are listed with who they are for, when they end and how often they were opened, and Revoke ends one', async () => {
    const user = userEvent.setup()
    api.pageShares.mockResolvedValue(list({ address: 'https://share.example.com', links: [link(), link({ id: 'z9', public: true, opens: 1 })] }))
    await sheet()
    expect(screen.getByText('Your network')).toBeTruthy()
    expect(screen.getByText(/^ends in 6 days · 2 opens/)).toBeTruthy()
    expect(screen.getByText(/1 open ·/)).toBeTruthy()
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!)
    await flush()
    expect(api.unsharePage.mock.calls).toEqual([['local', 'plan', 'a1b2c3']])
    expect(screen.queryByText('Your network')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Revoke' }).length).toBe(1)
  })
})

describe('where Share… is offered', () => {
  const machine: PageMachine = { name: 'abhash-arm', online: true, hub: true }
  test('in every page menu, for a page a hub serves', () => {
    const labels = pageMenu(PAGE, machine, () => {}).map((i) => i.label)
    expect(labels).toContain('Share…')
    expect(labels.indexOf('Share…')).toBe(labels.indexOf('Revoke links') - 1)
  })
})
