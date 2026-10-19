import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { PageEntry } from '@inyon/protocol'
import { PagesPage } from './Pages.tsx'
import { AppShell } from '../components/AppShell.tsx'
import { PreviewTab } from '../components/session/Panels.tsx'
import { useStore } from '../lib/store.ts'
import { usePages, pageId, type Page } from '../lib/pages.ts'
import { backHandled } from '../lib/back.ts'
import { api } from '../test/fakes.ts'
import { host } from '../test/fixtures.ts'
import { flush, renderSettled as render } from '../test/render.tsx'

const NOW = Date.now()
const entry = (slug: string, more: Partial<PageEntry> = {}): Page => {
  const e: PageEntry = { host: 'local', slug, name: slug, project: '/home/me/code/custom-tmux', by: 'claude', added: NOW - 86_400_000, folder: `/home/me/code/custom-tmux/private/plans/${slug}`, ...more }
  return { ...e, id: pageId(e.host, e.slug) }
}
const PLAN = entry('ghostex', { name: 'Inyon plan', progress: { done: 41, total: 68, now: 'R2 step 2c: the HTTP layer', updated: new Date(NOW - 3 * 60_000).toISOString() } })
const HANDY = entry('handy', { name: 'Handy redesign', project: '/home/me/code/Handy', added: NOW - 3_600_000 })
const LAPTOP = entry('win-paths', { host: 'laptop', name: 'Windows path test', project: 'C:\\demo', progress: { done: 5, total: 9 } })

const viewport = (width: number, height: number) => (window as any).happyDOM.setViewport({ width, height })
function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}
const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="pages" element={<PagesPage />} />
        <Route path="pages/:host/:slug" element={<PagesPage />} />
        <Route path="*" element={null} />
      </Routes>
      <Where />
    </MemoryRouter>,
  )

// the frames must never load anything: happy-dom would fetch their address for real
const settings = (window as any).happyDOM.settings
const loadFrames = settings.disableIframePageLoading
beforeAll(() => void (settings.disableIframePageLoading = true))
afterAll(() => void (settings.disableIframePageLoading = loadFrames))

beforeEach(() => {
  useStore.setState({ hosts: [host('local', { config: { id: 'local', kind: 'local', name: 'abhash-arm' } }), host('laptop', { config: { id: 'laptop', kind: 'node', name: 'abhash-laptop' }, status: 'error' })], hostsLoaded: true })
  usePages.setState({ pages: [PLAN, HANDY, LAPTOP], hubless: false, error: undefined, seen: { [HANDY.id]: NOW } })
  useStore.setState({ resolvedTheme: 'light' })
})
afterEach(() => viewport(1024, 768))

describe('the list on a phone', () => {
  beforeEach(() => viewport(390, 844))

  test('grouped by machine, then project; each card has its bar, its now line and when it last moved', async () => {
    await at('/pages')
    const headings = screen.getAllByText(/^abhash-(arm|laptop)$/).map((e) => e.textContent)
    expect(headings).toEqual(['abhash-arm', 'abhash-laptop'])
    expect(screen.getByText('hub')).toBeTruthy()
    const card = screen.getByRole('link', { name: 'Inyon plan' })
    expect(within(card).getByRole('progressbar', { name: '41 of 68 done' })).toBeTruthy()
    expect(within(card).getByText('41/68')).toBeTruthy()
    expect(within(card).getByText('R2 step 2c: the HTTP layer')).toBeTruthy()
    expect(within(card).getByText('updated 3 min ago')).toBeTruthy()
    // never opened: marked changed; Handy was opened since it last changed
    expect(within(card).getByLabelText('changed')).toBeTruthy()
    expect(within(screen.getByRole('link', { name: 'Handy redesign' })).queryByLabelText('changed')).toBeNull()
    // the laptop is offline: its card says so
    expect(within(screen.getByRole('link', { name: 'Windows path test, machine offline' })).getByText('Machine offline')).toBeTruthy()
    // projects by their folder's name
    expect(screen.getByText('custom-tmux')).toBeTruthy()
    expect(screen.getByText('demo')).toBeTruthy()
  })

  test('one menu on a card: open, open in browser with a 12 h link, revoke, show folder, remove', async () => {
    const user = userEvent.setup()
    await at('/pages')
    await user.click(screen.getByRole('button', { name: 'More for Inyon plan' }))
    const items = screen.getAllByRole('menuitem').map((m) => m.textContent)
    expect(items).toEqual(['Open', 'Open in browserA link that works for 12 h', 'Revoke links', 'Show folder', 'Remove'])
    await user.click(screen.getByRole('menuitem', { name: /Open$/ }))
    expect(screen.getByTestId('where').textContent).toBe('/pages/local/ghostex')
  })

  test('Remove takes it off the list at once and Undo adds the same folder back', async () => {
    const user = userEvent.setup()
    await at('/pages')
    await user.click(screen.getByRole('button', { name: 'More for Inyon plan' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove' }))
    await flush()
    expect(api.removePage).toHaveBeenCalledWith('local', 'ghostex')
    expect(screen.queryByRole('link', { name: 'Inyon plan' })).toBeNull()
    const toast = useStore.getState().toasts.at(-1)!
    expect([toast.title, toast.body, toast.action?.label]).toEqual(['Removed “Inyon plan”', 'The folder stays on abhash-arm.', 'Undo'])
    toast.action!.onSelect()
    expect(api.addPage).toHaveBeenCalledWith('local', { path: PLAN.folder, name: 'Inyon plan', slug: 'ghostex' })
  })

  test('no pages yet: the command an agent runs, and a way to add a folder', async () => {
    usePages.setState({ pages: [] })
    await at('/pages')
    expect(screen.getByText('No pages yet')).toBeTruthy()
    expect(screen.getByText(/^inyon pages add /)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add a folder/ })).toBeTruthy()
  })

  test('the phone app with no hub paired: pages open through a hub', async () => {
    usePages.setState({ pages: [], hubless: true })
    await at('/pages')
    expect(screen.getByText('Pages open through a hub')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Pair a hub/ })).toBeTruthy()
  })
})

describe('the viewer', () => {
  beforeEach(() => {
    api.openPage.mockResolvedValue({ url: '/v/v1.tok.sig/', expires: Date.now() + 12 * 3_600_000 } as never)
    globalThis.fetch = mock(async () => new Response(null, { status: 404 })) as any
  })

  test('the frame is sandboxed like the hub serves it, without same-origin rights, and starts in the app theme', async () => {
    viewport(390, 844)
    useStore.setState({ resolvedTheme: 'dark' })
    const { container } = await at('/pages/local/ghostex')
    await flush()
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups allow-downloads')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.getAttribute('allow')).toBe('')
    expect(frame.getAttribute('src')).toBe('/v/v1.tok.sig/?theme=dark')
    expect(api.openPage).toHaveBeenCalledWith('local', 'ghostex')
    // opening it clears its changed mark
    expect(usePages.getState().seen[PLAN.id]).toBeGreaterThan(0)
  })

  test('a link with less than an hour left is renewed when the app comes back into view, not before', async () => {
    api.openPage.mockResolvedValue({ url: '/v/v1.old.sig/', expires: Date.now() + 11 * 3_600_000 } as never)
    const { container } = await at('/pages/local/ghostex')
    await flush()
    expect(api.openPage).toHaveBeenCalledTimes(1)
    await act(async () => void window.dispatchEvent(new Event('focus')))
    expect(api.openPage).toHaveBeenCalledTimes(1)
    // the same link, later: 50 minutes left
    api.openPage.mockResolvedValue({ url: '/v/v1.new.sig/', expires: Date.now() + 12 * 3_600_000 } as never)
    const realNow = Date.now
    Date.now = () => realNow() + 10 * 3_600_000 + 10 * 60_000
    try {
      await act(async () => void window.dispatchEvent(new Event('focus')))
      await flush()
    } finally {
      Date.now = realNow
    }
    expect(api.openPage).toHaveBeenCalledTimes(2)
    expect(container.querySelector('iframe')!.getAttribute('src')).toBe('/v/v1.new.sig/?theme=light')
  })

  test("the app answers only its frame's messages, and only the kinds it knows", async () => {
    const { container } = await at('/pages/local/ghostex')
    await flush()
    // frames don't load here, so the frame's window is a stand-in
    const post = mock(() => {})
    const win = { postMessage: post } as unknown as Window
    Object.defineProperty(container.querySelector('iframe')!, 'contentWindow', { value: win })
    const send = (source: unknown, data: unknown) => act(async () => void window.dispatchEvent(new MessageEvent('message', { data, source: source as Window })))
    await send(window, { type: 'theme?' })
    await send(win, { type: 'navigate', url: '/api/session' })
    await send(win, 'theme?')
    expect(post).not.toHaveBeenCalled()
    await send(win, { type: 'theme?' })
    expect(post).toHaveBeenCalledWith({ type: 'theme', value: 'light' }, '*')
    // a theme change in the app goes in as a message, without reloading the frame
    post.mockClear()
    await act(async () => void useStore.setState({ resolvedTheme: 'dark' }))
    expect(post).toHaveBeenCalledWith({ type: 'theme', value: 'dark' }, '*')
    expect(container.querySelector('iframe')!.getAttribute('src')).toBe('/v/v1.tok.sig/?theme=light')
  })

  test('on a phone, back closes the viewer instead of walking back through the frame', async () => {
    viewport(390, 844)
    await at('/pages/local/ghostex')
    await flush()
    let handled = false
    await act(async () => void (handled = backHandled()))
    expect(handled).toBe(true)
    expect(screen.getByTestId('where').textContent).toBe('/pages')
  })

  test('the phone menu offers Plan, Mockups and Matrix only when the site has them', async () => {
    viewport(390, 844)
    globalThis.fetch = mock(async (url: string) => new Response(null, { status: String(url).endsWith('mockups/') ? 200 : 404 })) as any
    const user = userEvent.setup()
    await at('/pages/local/ghostex')
    await flush()
    await flush()
    await user.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Reload', 'Plan', 'Mockups', 'Open in browserA link that works for 12 h'])
    await user.click(screen.getByRole('menuitem', { name: 'Mockups' }))
    expect(document.querySelector('iframe')!.getAttribute('src')).toBe('/v/v1.tok.sig/mockups/?theme=light')
  })

  test('on a desktop, the list and the viewer sit side by side, with device sizes', async () => {
    const user = userEvent.setup()
    const { container } = await at('/pages/local/ghostex')
    await flush()
    expect(screen.getByRole('navigation', { name: 'Page location' }).textContent).toBe('abhash-arm/custom-tmux/Inyon plan')
    expect(screen.getByRole('link', { name: 'Handy redesign' }).getAttribute('href')).toBe('/pages/local/handy')
    expect(screen.getByRole('link', { name: 'Open in new tab' }).getAttribute('href')).toBe('/v/v1.tok.sig/')
    await user.click(screen.getByRole('radio', { name: 'Phone 390 × 844' }))
    const box = container.querySelector('iframe')!.parentElement as HTMLElement
    expect([box.style.width, box.style.height]).toEqual(['390px', '844px'])
    expect(screen.getByText(/^Phone · 390 × 844/)).toBeTruthy()
  })

  test('on a desktop, /pages opens the page that changed last', async () => {
    await at('/pages')
    await flush()
    expect(screen.getByTestId('where').textContent).toBe('/pages/local/ghostex')
  })
})

describe('the shell', () => {
  test('the phone tab bar has five places, Pages second, with the count of changed pages', async () => {
    viewport(390, 844)
    api.pages.mockResolvedValue({ pages: [PLAN, HANDY] } as never)
    await render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    await flush()
    const bar = screen.getAllByRole('navigation').find((n) => n.className.includes('grid-cols-5'))!
    expect(within(bar).getAllByRole('link').map((a) => a.textContent)).toEqual(['Overview', '1Pages', 'Machines', 'Settings'])
    expect(within(bar).getByLabelText('1 changed')).toBeTruthy()
  })

  test('a page open on a phone hides the tab bar', async () => {
    viewport(390, 844)
    api.openPage.mockResolvedValue({ url: '/v/t/', expires: Date.now() + 1e7 } as never)
    await render(
      <MemoryRouter initialEntries={['/pages/local/ghostex']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="pages/:host/:slug" element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getAllByRole('navigation').find((n) => n.className.includes('grid-cols-5'))).toBeUndefined()
  })
})

describe('the Preview tab', () => {
  test("refuses to frame Inyon's own address", async () => {
    localStorage.setItem('inyon.preview.box:%1', 'http://localhost:5173/settings')
    const { container } = await render(<PreviewTab storageKey="box:%1" suggestions={[]} />)
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByText(/That address is Inyon itself/)).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Preview address' }), { target: { value: 'http://localhost:3000' } })
    fireEvent.submit(screen.getByRole('textbox', { name: 'Preview address' }).closest('form')!)
    expect(container.querySelector('iframe')!.getAttribute('src')).toBe('http://localhost:3000')
  })
})
