import { beforeEach, describe, expect, test } from 'bun:test'
import type { PageEntry } from '@inyon/protocol'
import {
  RENEW_BEFORE_MS, agoText, appOrigins, changedAt, fitScale, frameMessage, frameSrc, groupPages, isChanged, leftText, loadPages, markSeen, matchesPage, pageHosts, pageId,
  previewRefusal, projectName, shouldRenew, usePages, type Page,
} from './pages.ts'
import { api } from '../test/fakes.ts'

const entry = (slug: string, more: Partial<PageEntry> = {}): Page => {
  const e: PageEntry = { host: 'local', slug, name: slug, project: '/home/me/code/app', by: 'claude', added: 1_000, folder: `/home/me/code/app/private/plans/${slug}`, ...more }
  return { ...e, id: pageId(e.host, e.slug) }
}
const names: Record<string, string> = { local: 'studio', 'hub:h1/local': 'arm', laptop: 'air' }
const nameOf = (h: string) => names[h] ?? h

beforeEach(() => usePages.setState({ pages: null, hubless: false, error: undefined, seen: {} }))

describe('grouping', () => {
  test('machine, then project, then page; the hub machine first, the newest change on top', () => {
    const groups = groupPages(
      [
        entry('old', { added: 10 }),
        entry('win', { host: 'laptop', project: 'C:\\demo', added: 5 }),
        entry('busy', { added: 1, progress: { done: 1, total: 2, updated: new Date(50).toISOString() } }),
        entry('site', { project: '/home/me/code/site', added: 20 }),
      ],
      nameOf,
    )
    expect(groups.map((g) => g.host)).toEqual(['local', 'laptop'])
    expect(groups[0]!.projects.map((p) => [p.name, p.pages.map((x) => x.slug)])).toEqual([
      ['app', ['busy', 'old']],
      ['site', ['site']],
    ])
    // a Windows path names its project by its last folder too
    expect(groups[1]!.projects[0]!.name).toBe('demo')
  })

  test("other machines follow by name, and a paired hub's own machine counts as a hub machine", () => {
    const groups = groupPages([entry('a', { host: 'zeta' }), entry('b', { host: 'hub:h1/local' }), entry('c', { host: 'alpha' })], nameOf)
    expect(groups.map((g) => g.host)).toEqual(['hub:h1/local', 'alpha', 'zeta'])
  })

  test('the filter looks at the name, the project and the machine', () => {
    const p = entry('plan', { name: 'Inyon plan', project: '/srv/custom-tmux' })
    expect(matchesPage(p, 'studio', 'inyon')).toBe(true)
    expect(matchesPage(p, 'studio', 'CUSTOM')).toBe(true)
    expect(matchesPage(p, 'studio', 'stud')).toBe(true)
    expect(matchesPage(p, 'studio', 'handy')).toBe(false)
    expect(matchesPage(p, 'studio', '  ')).toBe(true)
    expect(projectName('/a/b/c/')).toBe('c')
  })
})

describe('changed since it was opened', () => {
  test('a page never opened counts as changed; opening it clears that until its progress moves', () => {
    const p = entry('plan', { added: 100 })
    expect(isChanged(p, {})).toBe(true)
    markSeen(p, 500)
    const seen = usePages.getState().seen
    expect(isChanged(p, seen)).toBe(false)
    expect(JSON.parse(localStorage.getItem('inyon.pages.seen.v1')!)).toEqual({ 'local/plan': 500 })
    const later = { ...p, progress: { done: 2, total: 9, updated: new Date(900).toISOString() } }
    expect(changedAt(later)).toBe(900)
    expect(isChanged(later, seen)).toBe(true)
  })

  test("a progress time that isn't a date falls back to when the page was added", () => {
    expect(changedAt(entry('x', { added: 42, progress: { done: 0, total: 1, updated: 'soon' } }))).toBe(42)
  })
})

describe('links', () => {
  const now = 1_000_000_000
  test('a link is renewed when less than an hour is left, not before', () => {
    expect(RENEW_BEFORE_MS).toBe(3_600_000)
    expect(shouldRenew(now + 12 * 3_600_000, now)).toBe(false)
    expect(shouldRenew(now + 3_600_001, now)).toBe(false)
    expect(shouldRenew(now + 3_599_999, now)).toBe(true)
    expect(shouldRenew(now - 1, now)).toBe(true)
  })

  test("the frame's address keeps the token path's slash, so the theme survives without a redirect", () => {
    expect(frameSrc('', '/v/v1.abc.def/', 'plan', 'dark')).toBe('/v/v1.abc.def/?theme=dark')
    expect(frameSrc('http://box:4777', '/v/t/', 'mockups', 'light')).toBe('http://box:4777/v/t/mockups/?theme=light')
    expect(frameSrc('', '/v/t/', 'matrix', 'light')).toBe('/v/t/matrix.html?theme=light')
  })

  test('words for how long ago and how long is left', () => {
    expect(agoText(now - 10_000, now)).toBe('just now')
    expect(agoText(now - 3 * 60_000, now)).toBe('3 min ago')
    expect(agoText(now - 2 * 3_600_000, now)).toBe('2 h ago')
    expect(agoText(now - 4 * 86_400_000, now)).toBe('4 d ago')
    expect(leftText(now + (11 * 60 + 52) * 60_000, now)).toBe('11 h 52 m')
    expect(leftText(now + 30 * 60_000, now)).toBe('30 m')
    expect(leftText(now - 5, now)).toBe('0 m')
  })

  test('a device frame shrinks to fit the stage and never grows', () => {
    expect(fitScale(390, 844, 2000, 2000)).toBe(1)
    expect(fitScale(1440, 900, 744, 1000)).toBeCloseTo(0.5)
    expect(fitScale(390, 844, 800, 446)).toBeCloseTo(0.5)
  })
})

describe('messages from the frame', () => {
  const frame = {} as Window
  test('only from the page\u2019s own frame, and only a kind the app knows', () => {
    expect(frameMessage({ source: frame, data: { type: 'theme?' } }, frame)).toEqual({ type: 'theme?' })
    // another window, a frame inside the page, or no frame at all
    expect(frameMessage({ source: {} as Window, data: { type: 'theme?' } }, frame)).toBeNull()
    expect(frameMessage({ source: null, data: { type: 'theme?' } }, frame)).toBeNull()
    expect(frameMessage({ source: frame, data: { type: 'theme?' } }, null)).toBeNull()
    // unknown kinds and odd shapes
    for (const data of [{ type: 'navigate', url: '/api/session' }, { type: 'theme' }, 'theme?', null, { type: 7 }, ['theme?']]) expect(frameMessage({ source: frame, data }, frame)).toBeNull()
  })

  test('nothing but the type is passed on', () => {
    expect(frameMessage({ source: frame, data: { type: 'theme?', html: '<script>alert(1)</script>' } }, frame)).toEqual({ type: 'theme?' })
  })
})

describe('the Preview tab', () => {
  test("refuses the app's own address and each paired hub's, whatever the path", () => {
    const own = ['http://localhost:5173', 'http://box:4777']
    expect(previewRefusal('http://localhost:5173/', own)).toMatch(/Inyon itself/)
    expect(previewRefusal('http://localhost:5173/v/v1.a.b/', own)).toMatch(/Inyon itself/)
    expect(previewRefusal('http://box:4777/settings?x=1', own)).toMatch(/Inyon itself/)
    expect(previewRefusal('http://localhost:3000/', own)).toBeNull()
    expect(previewRefusal('https://localhost:5173/', own)).toBeNull()
    expect(previewRefusal('not a url', own)).toBeNull()
  })

  test("the app's origins: this page's and the paired hubs'", () => {
    localStorage.setItem('inyon.hubs.v1', JSON.stringify([{ id: 'h1', name: 'arm', url: 'http://box:4777', token: 't', pairedAt: 1 }]))
    expect(appOrigins()).toEqual(['http://localhost:5173', 'http://box:4777'])
  })
})

describe('the list', () => {
  test('in a browser it comes from the hub the app came from', async () => {
    api.pages.mockResolvedValue({ pages: [{ host: 'local', slug: 'plan', name: 'Plan', project: '/p', by: 'cli', added: 1, folder: '/p/plan' }] } as never)
    await loadPages()
    expect(usePages.getState().pages!.map((p) => p.id)).toEqual(['local/plan'])
    expect(pageHosts()).toEqual(['local'])
  })

  test('the phone app with no hub paired has nothing to list, and says pages open through a hub', async () => {
    ;(window as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} }
    try {
      await loadPages()
      expect(usePages.getState()).toMatchObject({ pages: [], hubless: true })
      expect(api.pages).not.toHaveBeenCalled()
    } finally {
      delete (window as any).Capacitor
    }
  })

  test("the phone app asks each paired hub, naming the hub's machines as the app does; one out of reach keeps the others", async () => {
    ;(window as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} }
    localStorage.setItem('inyon.hubs.v1', JSON.stringify([
      { id: 'h1', name: 'arm', url: 'http://arm:4777', token: 't1', pairedAt: 1 },
      { id: 'h2', name: 'nas', url: 'http://nas:4777', token: 't2', pairedAt: 2 },
    ]))
    api.hubPages.mockImplementation((async (hub: { id: string }) => {
      if (hub.id === 'h2') throw new Error("Couldn't reach nas")
      return { pages: [{ host: 'local', slug: 'plan', name: 'Plan', project: '/p', by: 'cli', added: 1, folder: '/p/plan' }] }
    }) as never)
    try {
      await loadPages()
      expect(usePages.getState().pages!.map((p) => [p.id, p.host])).toEqual([['hub:h1/local/plan', 'hub:h1/local']])
      expect(usePages.getState().error).toBeUndefined()
      expect(pageHosts()).toEqual(['hub:h1/local', 'hub:h2/local'])
    } finally {
      delete (window as any).Capacitor
    }
  })
})
