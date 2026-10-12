import { beforeEach, describe, expect, test } from 'bun:test'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { HostState } from '@inyon/protocol'
import { SessionTree, TREE_SEARCH_FROM } from './SessionTree.tsx'
import { agentPane, host, pane } from '../test/fixtures.ts'
import { renderSettled as render } from '../test/render.tsx'

const machine = (id: string, titles: string[], more: Partial<HostState> = {}) =>
  host(id, { ...more, panes: titles.map((t, i) => (t === 'zsh' ? pane(`%${i}`) : agentPane(`%${i}`, 'claude', { title: t }))) })

const tree = (hosts: HostState[]) => render(<MemoryRouter><SessionTree hosts={hosts} /></MemoryRouter>)
const heading = (name: RegExp) => screen.getByRole('button', { name })

beforeEach(() => localStorage.clear())

describe('the sidebar session tree', () => {
  test('groups by machine, then tmux session, with each pane’s window', async () => {
    await tree([machine('box', ['Fix the login test', 'zsh']), machine('laptop', ['Write the docs'], { machineKind: 'laptop' })])
    expect(heading(/ box /).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('button', { name: /^main/ })).toHaveLength(2)
    const login = screen.getByRole('link', { name: /Fix the login test/ })
    expect(login.getAttribute('title')).toBe('box · main:0')
    expect(within(login).getByText(':0')).toBeTruthy()
    expect(screen.getByRole('link', { name: /zsh/ })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Laptop' })).toBeTruthy()
  })

  test('one machine leaves its level out', async () => {
    await tree([machine('box', ['Fix the login test'])])
    expect(screen.queryByRole('button', { name: / box / })).toBeNull()
    expect(heading(/^main/)).toBeTruthy()
  })

  test('a folded machine stays folded next time, and still shows that something waits', async () => {
    const user = userEvent.setup()
    const hosts = [machine('box', ['Fix the login test']), machine('laptop', ['Write the docs'])]
    hosts[0].sessions[0].windows[0].panes[0].agent!.state = 'waiting'
    const r = await tree(hosts)
    await user.click(heading(/ box /))
    expect(heading(/ box /).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByLabelText('1 waiting for you')).toBeTruthy()
    r.unmount()
    await tree(hosts)
    expect(heading(/ box /).getAttribute('aria-expanded')).toBe('false')
    expect(heading(/ laptop /).getAttribute('aria-expanded')).toBe('true')
  })

  test('with many panes a filter searches every group, folded ones too', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: TREE_SEARCH_FROM }, (_, i) => `Task ${i}`)
    await tree([machine('box', many), machine('laptop', ['Fix the login test'])])
    await user.click(heading(/ laptop /))
    await user.type(screen.getByRole('searchbox', { name: 'Filter sessions' }), 'login')
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([expect.stringContaining('Fix the login test')])
    expect(heading(/ laptop /).getAttribute('aria-expanded')).toBe('true')
    await user.clear(screen.getByRole('searchbox'))
    await user.type(screen.getByRole('searchbox'), 'zzz')
    expect(screen.getByText('Nothing matches')).toBeTruthy()
  })

  test('few panes, no filter box', async () => {
    await tree([machine('box', ['One', 'Two'])])
    expect(screen.queryByRole('searchbox')).toBeNull()
  })
})
