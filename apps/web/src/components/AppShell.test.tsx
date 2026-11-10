import { afterEach, expect, test } from 'bun:test'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AppShell } from './AppShell.tsx'
import { useStore } from '../lib/store.ts'
import { agentPane, host } from '../test/fixtures.ts'
import { renderSettled as render } from '../test/render.tsx'

afterEach(() => act(() => useStore.getState().setSettings({ sidebar: true })))

const shell = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<div>overview</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )

test('the sidebar folds to a rail of icons and opens again, by its button and by Ctrl B', async () => {
  useStore.setState({ hosts: [host('box', { panes: [agentPane('%1', 'claude')] })], hostsLoaded: true, connected: true, authed: true })
  const { container } = await shell()
  const side = () => container.querySelector('aside')!
  expect(side().getAttribute('data-sidebar')).toBe('open')
  expect(screen.getByText('Search or jump to…')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))
  expect(useStore.getState().settings.sidebar).toBe(false)
  expect(side().getAttribute('data-sidebar')).toBe('rail')
  // every place is still one click away, named for a screen reader and by its tooltip
  for (const name of ['Show sidebar', 'Search or jump to…', 'New session']) expect(within(side()).getByRole('button', { name })).toBeTruthy()
  for (const name of ['Overview', 'Machines', 'Blueprints', 'Settings']) expect(side().querySelector(`a[aria-label="${name}"]`)).not.toBeNull()
  // the words are gone, and so is the sessions' tree
  expect(screen.queryByText('Search or jump to…')).toBeNull()
  expect(side().querySelector('nav')).toBeNull()

  fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ctrlKey: true })
  expect(useStore.getState().settings.sidebar).toBe(true)
  expect(side().getAttribute('data-sidebar')).toBe('open')
  fireEvent.keyDown(window, { key: 'b', code: 'KeyB', metaKey: true })
  expect(side().getAttribute('data-sidebar')).toBe('rail')
  fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }))
  expect(side().getAttribute('data-sidebar')).toBe('open')
})

test('folded stays folded: the choice is kept with the settings', async () => {
  act(() => useStore.getState().setSettings({ sidebar: false }))
  expect(JSON.parse(localStorage.getItem('inyon.settings.v2')!).sidebar).toBe(false)
  const { container } = await shell()
  expect(container.querySelector('aside')!.getAttribute('data-sidebar')).toBe('rail')
})
