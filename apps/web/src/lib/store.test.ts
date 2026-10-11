import { describe, expect, setSystemTime, test, afterEach } from 'bun:test'
import type { ChatItem } from '@tether/protocol'
import { notifyTag, patchChat, PENDING_MS, useStore, type PendingMessage } from './store.ts'
import { clearNativeNotification } from './native.ts'
import { emit } from '../test/fakes.ts'
import { agentPane, chatInfo, host, item } from '../test/fixtures.ts'

const chat = (key: string) => useStore.getState().chats[key]
const seqs = (items: ChatItem[]) => items.map((i) => i.seq)
const reset = (key: string, items: ChatItem[], hasMore = false) => emit({ t: 'chat.reset', key, info: chatInfo(), items, hasMore })

afterEach(() => setSystemTime())

describe('hub messages', () => {
  test('overview replaces the machines', () => {
    expect(useStore.getState().hostsLoaded).toBe(false)
    emit({ t: 'overview', hosts: [host('a'), host('b')] })
    expect(useStore.getState().hosts.map((h) => h.config.id)).toEqual(['a', 'b'])
    expect(useStore.getState().hostsLoaded).toBe(true)
  })

  test('chat.reset loads the transcript', () => {
    const items = [item.user('hi'), item.text('hello')]
    emit({ t: 'chat.reset', key: 'k', info: chatInfo({ title: 'T' }), items, hasMore: true })
    expect(chat('k')).toMatchObject({ loaded: true, hasMore: true, items, info: { title: 'T' } })
  })

  test('a resent latest page keeps the earlier messages already loaded', () => {
    const old = [item.user('1'), item.text('2'), item.user('3'), item.text('4')]
    reset('k', old, true)
    emit({ t: 'chat.more', key: 'k', items: [], hasMore: false })
    // the hub resends from item 3 on, with one new item
    const next = [old[2], old[3], item.text('5')]
    reset('k', next, true)
    expect(seqs(chat('k').items)).toEqual([...seqs(old), next[2].seq])
    // the reader already reached the start; that stays known
    expect(chat('k').hasMore).toBe(false)
  })

  test('a page that starts somewhere unknown replaces everything', () => {
    reset('k', [item.user('1'), item.text('2')], true)
    const other = [item.user('x'), item.text('y')]
    reset('k', other, true)
    expect(chat('k').items).toEqual(other)
  })

  test('chat.append adds only items it has not seen', () => {
    const a = item.user('a')
    const b = item.text('b')
    reset('k', [a, b])
    const c = item.text('c')
    emit({ t: 'chat.append', key: 'k', items: [b, c] })
    expect(seqs(chat('k').items)).toEqual([a.seq, b.seq, c.seq])
  })

  test('chat.more prepends older items without duplicates', () => {
    const [a, b, c] = [item.user('a'), item.text('b'), item.user('c')]
    reset('k', [b, c], true)
    emit({ t: 'chat.more', key: 'k', items: [a, b], hasMore: false })
    expect(seqs(chat('k').items)).toEqual([a.seq, b.seq, c.seq])
    expect(chat('k').hasMore).toBe(false)
  })

  test('chat.info without a transcript counts as loaded; with one, it waits for the items', () => {
    emit({ t: 'chat.info', key: 'none', info: chatInfo() })
    expect(chat('none').loaded).toBe(true)
    emit({ t: 'chat.info', key: 'some', info: chatInfo({ transcriptPath: '/t.jsonl' }) })
    expect(chat('some').loaded).toBe(false)
    reset('some', [])
    emit({ t: 'chat.info', key: 'some', info: chatInfo({ transcriptPath: '/t.jsonl' }) })
    expect(chat('some').loaded).toBe(true)
  })

  test('chat.screen and chat.draft land on the chat, keeping the rest', () => {
    const items = [item.user('a')]
    reset('k', items)
    emit({ t: 'chat.screen', key: 'k', screen: { working: true, width: 80 } })
    emit({ t: 'chat.draft', key: 'k', text: 'half typed', source: 'terminal', at: 5 })
    expect(chat('k')).toMatchObject({ items, screen: { working: true }, draft: { text: 'half typed', source: 'terminal', at: 5 } })
  })
})

describe('pending messages', () => {
  const T = Date.UTC(2026, 9, 11, 12)
  const p = (text: string, more: Partial<PendingMessage> = {}): PendingMessage => ({ id: text, text, status: 'sent', at: T, ...more })
  const ts = new Date(T + 1000).toISOString()

  test('the transcript confirms them on reset and on append', () => {
    patchChat('k', () => ({ pending: [p('one'), p('two'), p('three')] }))
    reset('k', [item.user('one', { ts })])
    expect(chat('k').pending.map((m) => m.text)).toEqual(['two', 'three'])
    emit({ t: 'chat.append', key: 'k', items: [item.user('three', { ts })] })
    expect(chat('k').pending.map((m) => m.text)).toEqual(['two'])
  })

  test('a reappearing old item does not confirm a new send', () => {
    const old = item.user('yes', { ts })
    reset('k', [old])
    patchChat('k', () => ({ pending: [p('yes')] }))
    emit({ t: 'chat.append', key: 'k', items: [old] })
    expect(chat('k').pending).toHaveLength(1)
  })

  test('they survive a reload; one that was mid-send says delivery was interrupted', () => {
    setSystemTime(T + 60_000)
    patchChat('k', () => ({ pending: [p('sending', { status: 'sending' }), p('failed', { status: 'failed', error: 'boom' }), p('sent')] }))
    const saved = sessionStorage.getItem('tether.pending.k')
    expect(JSON.parse(saved!)).toHaveLength(3)
    // a fresh page: same tab storage, empty store
    useStore.setState({ chats: {} })
    patchChat('k', () => ({}))
    expect(chat('k').pending.map((m) => [m.text, m.status, m.error])).toEqual([
      ['sending', 'failed', 'Delivery was interrupted. Check the terminal before retrying.'],
      ['failed', 'failed', 'boom'],
      ['sent', 'sent', undefined],
    ])
  })

  test('old or malformed saved messages are dropped', () => {
    setSystemTime(T + PENDING_MS + 1)
    sessionStorage.setItem('tether.pending.k', JSON.stringify([p('stale'), { id: 1, text: 'bad' }, null, p('fresh', { at: T + PENDING_MS })]))
    patchChat('k', () => ({}))
    expect(chat('k').pending.map((m) => m.text)).toEqual(['fresh'])
    sessionStorage.setItem('tether.pending.j', '{not json')
    patchChat('j', () => ({}))
    expect(chat('j').pending).toEqual([])
  })

  test('the saved copy goes away once nothing is pending', () => {
    patchChat('k', () => ({ pending: [p('a')] }))
    patchChat('k', () => ({ pending: [] }))
    expect(sessionStorage.getItem('tether.pending.k')).toBeNull()
  })
})

describe('toasts and settings', () => {
  test('at most three toasts at a time, newest last; one per conversation', () => {
    const { toast } = useStore.getState()
    for (const n of [1, 2, 3, 4]) toast({ title: `t${n}`, tone: 'info' })
    expect(useStore.getState().toasts.map((t) => t.title)).toEqual(['t2', 't3', 't4'])
    useStore.getState().dismiss(useStore.getState().toasts[0].id)
    expect(useStore.getState().toasts.map((t) => t.title)).toEqual(['t3', 't4'])
    toast({ title: 'working', tone: 'info', href: '/m/box/p/1' })
    toast({ title: 'finished', tone: 'success', href: '/m/box/p/1' })
    expect(useStore.getState().toasts.map((t) => t.title)).toEqual(['t3', 't4', 'finished'])
  })

  test('settings merge and persist', () => {
    useStore.getState().setSettings({ density: 'compact' })
    expect(useStore.getState().settings).toMatchObject({ density: 'compact', theme: 'system' })
    expect(JSON.parse(localStorage.getItem('tether.settings.v2')!)).toMatchObject({ density: 'compact', haptics: true })
  })
})

describe('notify', () => {
  const note = (kind: 'waiting' | 'done' | 'offline' | 'online', title = 'Claude needs you') => emit({ t: 'notify', host: 'box', pane: '%3', kind, title, body: 'b', agent: 'claude' })
  afterEach(() => history.pushState({}, '', '/'))

  test('agent events go in the activity list and toast with a link to the session', () => {
    note('waiting')
    expect(useStore.getState().activity[0]).toMatchObject({ host: 'box', pane: '%3', kind: 'waiting' })
    expect(useStore.getState().toasts[0]).toMatchObject({ title: 'Claude needs you', tone: 'warn', href: '/m/box/p/3' })
  })

  test('machine events toast but are not activity', () => {
    note('offline', 'box is offline')
    expect(useStore.getState().activity).toEqual([])
    expect(useStore.getState().toasts[0]).toMatchObject({ tone: 'warn', href: '/machines/box' })
  })

  test('no toast for the conversation on screen', () => {
    history.pushState({}, '', '/m/box/p/3')
    note('done')
    expect(useStore.getState().toasts).toEqual([])
    expect(useStore.getState().activity).toHaveLength(1)
  })

  test('finished notices can be turned off; they still go in the activity list', () => {
    useStore.getState().setSettings({ notifyDone: false })
    note('done')
    expect(useStore.getState().toasts).toEqual([])
    expect(useStore.getState().activity).toHaveLength(1)
    note('waiting')
    expect(useStore.getState().toasts).toHaveLength(1)
  })

  test('the activity list keeps the latest 30', () => {
    for (let i = 0; i < 35; i++) note('done', `n${i}`)
    const titles = useStore.getState().activity.map((a) => a.title)
    expect(titles).toHaveLength(30)
    expect(titles[0]).toBe('n34')
  })

  test("in the phone app's background: one native notification per session, with the logo, cleared on opening", async () => {
    const posted: any[] = []
    const cleared: string[] = []
    ;(window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: { TetherDevice: { postNotification: async (o: any) => void posted.push(o), clearNotification: async (o: any) => void cleared.push(o.tag) } },
    }
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      note('waiting')
      emit({ t: 'notify', host: 'box', pane: '', kind: 'offline', title: 'box is offline', body: 'b' })
      await Promise.resolve()
      expect(posted).toEqual([
        { title: 'Claude needs you', body: 'b', href: '/m/box/p/3', tag: 'box:%3', kind: 'waiting' },
        { title: 'box is offline', body: 'b', href: '/machines/box', tag: 'machine:box', kind: 'offline' },
      ])
      clearNativeNotification(notifyTag('box', '%3'))
      expect(cleared).toEqual(['box:%3'])
    } finally {
      delete (window as any).Capacitor
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    }
  })

  test('a question answered somewhere else takes its notification with it', async () => {
    const cleared: string[] = []
    ;(window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: { TetherDevice: { postNotification: async () => ({ ok: true }), clearNotification: async (o: any) => void cleared.push(o.tag) } },
    }
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    const box = (state: 'waiting' | 'working' | 'idle', status: 'online' | 'error' = 'online') => host('box', { status, panes: [agentPane('%3', 'claude', { agent: { kind: 'claude', pid: 1, state } })] })
    try {
      note('waiting')
      emit({ t: 'overview', hosts: [box('waiting')] })
      // still asking, or the machine went quiet: it stays
      emit({ t: 'overview', hosts: [box('working', 'error')] })
      expect(cleared).toEqual([])
      // answered on the computer
      emit({ t: 'overview', hosts: [box('working')] })
      expect(cleared).toEqual(['box:%3'])
      emit({ t: 'overview', hosts: [box('idle')] })
      expect(cleared).toEqual(['box:%3'])
      // a finished notice replaced it: nothing to take back
      note('waiting')
      note('done')
      emit({ t: 'overview', hosts: [box('idle')] })
      expect(cleared).toEqual(['box:%3'])
    } finally {
      delete (window as any).Capacitor
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    }
  })
})
