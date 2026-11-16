import { describe, expect, test } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import type { ConversationHit, ConversationSearchMachine } from '@inyon/protocol'
import { answered, flatHits, highlight, idle, mergeMachines, searchEverywhere, SETTLE_MS, typed, useConversationSearch, type SearchState } from './conversationSearch.ts'
import { api } from '../test/fakes.ts'
import type { PairedHub } from './hubs.ts'

const hit = (id: string, at: number, extra: Partial<ConversationHit> = {}): ConversationHit => ({ agent: 'claude', id, title: id, at, snippet: '', cwd: '/w', ...extra })
const machine = (name: string, hits: ConversationHit[], extra: Partial<ConversationSearchMachine> = {}): ConversationSearchMachine => ({ host: name.toLowerCase(), name, hits, ...extra })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('what the palette shows while searching', () => {
  test('nothing typed is idle, too few characters is short, and enough sends a search', () => {
    expect(typed(idle, '   ', 1)).toEqual(idle)
    expect(typed(idle, ' au ', 1)).toEqual({ status: 'short', q: 'au' })
    expect(typed(idle, ' fixed   auth ', 2)).toEqual({ status: 'searching', q: 'fixed auth', seq: 2, machines: undefined })
  })

  test('the last answer stays on screen while the next search runs', () => {
    const done: SearchState = { status: 'done', q: 'auth', seq: 1, machines: [machine('Laptop', [hit('a', 1)])] }
    const next = typed(done, 'auth fix', 2)
    expect(next.status).toBe('searching')
    expect(next.status === 'searching' && next.machines).toEqual(done.machines)
  })

  test('an answer for words since changed is dropped; the current one lands, or its error does', () => {
    const s = typed(idle, 'auth fix', 2)
    expect(answered(s, 1, { machines: [] })).toBe(s)
    expect(answered(s, 2, { machines: [machine('Laptop', [])] })).toEqual({ status: 'done', q: 'auth fix', seq: 2, machines: [machine('Laptop', [])] })
    expect(answered(s, 2, { error: 'Not signed in' })).toEqual({ status: 'failed', q: 'auth fix', seq: 2, error: 'Not signed in' })
    // once done, a late copy of the same answer changes nothing
    const done = answered(s, 2, { machines: [] })
    expect(answered(done, 2, { error: 'late' })).toBe(done)
  })
})

describe('putting the machines together', () => {
  test('newest matches first, then machines with none, then failed, then offline', () => {
    const merged = mergeMachines([
      [machine('Asleep', [], { skipped: 'Offline' }), machine('Server', [hit('s1', 10), hit('s2', 50)])],
      [machine('Failed', [], { error: 'ssh: refused' }), machine('Quiet', []), machine('Laptop', [hit('l1', 40)])],
    ])
    expect(merged.map((m) => m.name)).toEqual(['Server', 'Laptop', 'Quiet', 'Failed', 'Asleep'])
    expect(merged[0]!.hits.map((h) => h.id)).toEqual(['s2', 's1'])
    expect(flatHits(merged).map((h) => [h.machine, h.id])).toEqual([['Server', 's2'], ['Server', 's1'], ['Laptop', 'l1']])
  })

  test("this hub's machines and each paired hub's, whose ids lead back through that hub", async () => {
    const office: PairedHub = { id: 'h1', name: 'Office hub', url: 'https://office.example', pairedAt: 1 }
    const down: PairedHub = { id: 'h2', name: 'Home hub', url: 'https://home.example', pairedAt: 1 }
    api.searchConversations.mockImplementation(async (q: string, hub?: PairedHub) => {
      if (hub?.id === 'h2') throw new Error("Couldn't reach Home hub")
      return { query: q, machines: hub ? [machine('Desk', [hit('d', 30)])] : [machine('Laptop', [hit('l', 20)])] }
    })
    const all = await searchEverywhere('auth', [office, down])
    expect(api.searchConversations.mock.calls.map((c) => [c[0], (c[1] as PairedHub | undefined)?.id])).toEqual([['auth', undefined], ['auth', 'h1'], ['auth', 'h2']])
    expect(all.map((m) => [m.host, m.name, m.error])).toEqual([
      ['hub:h1/desk', 'Desk', undefined],
      ['laptop', 'Laptop', undefined],
      ['hub:h2/', 'Home hub', "Couldn't reach Home hub"],
    ])
  })

  test('when nothing answers, the reason is the error', async () => {
    api.searchConversations.mockImplementation(async () => {
      throw new Error('Not signed in')
    })
    await expect(searchEverywhere('auth', [])).rejects.toThrow('Not signed in')
  })
})

describe('marking the words in a snippet', () => {
  test('every place they appear, in any case', () => {
    expect(highlight('Auth works; the auth flow', 'AUTH')).toEqual([
      { text: 'Auth', mark: true },
      { text: ' works; the ', mark: false },
      { text: 'auth', mark: true },
      { text: ' flow', mark: false },
    ])
  })

  test('words not in the text, or none at all, leave it as it is', () => {
    expect(highlight('nothing here', 'auth')).toEqual([{ text: 'nothing here', mark: false }])
    expect(highlight('text', ' ')).toEqual([{ text: 'text', mark: false }])
    // characters a pattern would read specially are plain text
    expect(highlight('match .* here', '.*')).toEqual([{ text: 'match ', mark: false }, { text: '.*', mark: true }, { text: ' here', mark: false }])
  })
})

describe('the search hook', () => {
  test('waits for typing to settle and searches once, for the last words', async () => {
    const asked: string[] = []
    const search = async (q: string) => (asked.push(q), [machine('Laptop', [hit('a', 1)])])
    const { result, rerender } = renderHook(({ q }) => useConversationSearch(q, true, search), { initialProps: { q: 'oau' } })
    rerender({ q: 'oaut' })
    rerender({ q: 'oauth' })
    expect(result.current.state.status).toBe('searching')
    await act(() => wait(SETTLE_MS + 50))
    expect(asked).toEqual(['oauth'])
    expect(result.current.state).toMatchObject({ status: 'done', q: 'oauth' })
  })

  test('Enter searches at once, and nothing goes out while the palette shows sessions', async () => {
    const asked: string[] = []
    const search = async (q: string) => (asked.push(q), [])
    const { result, rerender } = renderHook(({ q, on }) => useConversationSearch(q, on, search), { initialProps: { q: 'login bug', on: false } })
    await act(() => wait(SETTLE_MS + 50))
    expect(asked).toEqual([])
    rerender({ q: 'login bug', on: true })
    await act(async () => result.current.now())
    await act(() => wait(10))
    expect(asked).toEqual(['login bug'])
    // the search the typing started was replaced, not sent as well
    await act(() => wait(SETTLE_MS + 50))
    expect(asked).toEqual(['login bug'])
  })
})
