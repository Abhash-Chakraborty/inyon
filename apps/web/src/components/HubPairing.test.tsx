import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LaptopSheet } from './LaptopSheet.tsx'
import { listHubs } from '../lib/hubs.ts'
import { useStore } from '../lib/store.ts'
import { emit } from '../test/fakes.ts'
import { host } from '../test/fixtures.ts'
import { flush, renderSettled as render } from '../test/render.tsx'

const realFetch = globalThis.fetch
const claims: { url: string; body: any }[] = []
beforeEach(() => {
  localStorage.removeItem('inyon.hubs.v1')
  claims.length = 0
  // the hub's claim endpoint, answered here
  globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    claims.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
    if (claims[claims.length - 1]!.body.code !== 'K7Q4MX2T:493812') return new Response(JSON.stringify({ error: 'That code is not right.' }), { status: 401 })
    return new Response(JSON.stringify({ token: 'tok', hub: { id: 'h1', name: 'studio', version: '0.12.0' } }), { status: 200 })
  }) as any
})
afterEach(() => {
  globalThis.fetch = realFetch
})

test('a scanned hub code pairs with one tap and remembers the hub', async () => {
  const onClose = mock(() => {})
  await render(<LaptopSheet open onClose={onClose} link="inyon://hub?u=https%3A%2F%2Fhub.example&c=K7Q4MX2T%3A493812&n=studio" />)
  expect(screen.getByText(/Pair with the hub/)).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: 'Pair' }))
  await flush()
  expect(claims[0]!.url).toBe('https://hub.example/api/phones/claim')
  expect(claims[0]!.body.code).toBe('K7Q4MX2T:493812')
  expect(listHubs()).toMatchObject([{ id: 'h1', name: 'studio', url: 'https://hub.example', token: 'tok' }])
  expect(onClose).toHaveBeenCalled()
})

test('a typed address and code pair too, and a wrong code says so', async () => {
  await render(<LaptopSheet open onClose={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: /Connect to a hub/ }))
  await userEvent.type(screen.getByLabelText('Hub address'), 'box:4777')
  await userEvent.type(screen.getByLabelText('Hub code'), 'k7q4-mx2t 000000')
  await userEvent.click(screen.getByRole('button', { name: 'Pair' }))
  await flush()
  expect(claims[0]!.url).toBe('http://box:4777/api/phones/claim')
  expect(listHubs()).toEqual([])
  expect(useStore.getState().toasts.map((t) => t.title)).toContain("Couldn't pair with the hub")
})

test("a hub's machines join the list with the hub's id in front", () => {
  useStore.setState({ hosts: [] })
  emit({ t: 'overview', hosts: [host('mine')] } as any)
  emit({ t: 'overview', hosts: [host('hub:h1/laptop')], source: 'hub:h1' } as any)
  expect(useStore.getState().hosts.map((h) => h.config.id)).toEqual(['mine', 'hub:h1/laptop'])
  // the hub going quiet changes only its own
  emit({ t: 'overview', hosts: [], source: 'hub:h1' } as any)
  expect(useStore.getState().hosts.map((h) => h.config.id)).toEqual(['mine'])
})
