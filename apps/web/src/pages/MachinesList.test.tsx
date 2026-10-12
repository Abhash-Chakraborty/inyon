import { describe, expect, test } from 'bun:test'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { HostState, MachineKind } from '@inyon/protocol'
import { MachinesPage, metaLine } from './Machines.tsx'
import { useStore } from '../lib/store.ts'
import { host } from '../test/fixtures.ts'
import { renderSettled as render } from '../test/render.tsx'

const m = (name: string, machineKind?: MachineKind, status: HostState['status'] = 'online') => host(name, { machineKind, status })
const rows = () => screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/machines/')).map((a) => a.getAttribute('href')!.slice(10))
const page = () => render(<MemoryRouter><MachinesPage /></MemoryRouter>)

describe('the machines list', () => {
  test('machines that answer come first, each with the icon of what it is', async () => {
    useStore.setState({ hosts: [m('nas', 'server', 'error'), m('studio', 'desktop'), m('air', 'laptop'), m('vm', 'server')] })
    await page()
    expect(rows()).toEqual(['studio', 'air', 'vm', 'nas'])
    expect(screen.getAllByRole('img', { name: 'Server' })).toHaveLength(2)
    expect(screen.getByRole('img', { name: 'Laptop' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Desktop' })).toBeTruthy()
  })

  test('past eight machines a search narrows the list', async () => {
    const user = userEvent.setup()
    useStore.setState({ hosts: Array.from({ length: 9 }, (_, i) => m(`box-${i}`, i === 4 ? 'laptop' : 'server')) })
    await page()
    await user.type(screen.getByRole('searchbox', { name: 'Search 9 machines' }), 'laptop')
    expect(rows()).toEqual(['box-4'])
    await user.clear(screen.getByRole('searchbox'))
    await user.type(screen.getByRole('searchbox'), 'nothing')
    expect(screen.getByText('No machine matches “nothing”')).toBeTruthy()
  })

  test('a few machines, no search box', async () => {
    useStore.setState({ hosts: [m('one'), m('two')] })
    await page()
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  test('the meta line wraps only between items, never before a dot or inside a count', () => {
    const line = metaLine('build box', 2, 1, 38)
    expect(line.replace(/\u00a0/g, ' ')).toBe('build box · 2 sessions · 1 agent · 38 ms')
    // the only ordinary spaces left are the ones after each dot, and inside the address
    expect(line.split(' ')).toEqual(['build', 'box\u00a0·', '2\u00a0sessions\u00a0·', '1\u00a0agent\u00a0·', '38\u00a0ms'])
    expect(metaLine('studio', 1, 0)).toBe('studio\u00a0· 1\u00a0session')
  })
})
