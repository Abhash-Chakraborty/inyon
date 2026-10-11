import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { checkAppUpdate, RELEASES_API, startAppUpdateCheck } from './appUpdate.ts'
import { useStore } from './store.ts'

const realFetch = globalThis.fetch
let appVersion = '0.6.3'
let release: Record<string, unknown> = {}
const fetched = mock((_url: string) => {})

const apk = (version: string, name = `tether-${version}.apk`) => ({
  tag_name: `v${version}`,
  prerelease: false,
  assets: [
    { name: 'tether-node-linux-x64', browser_download_url: `https://github.com/x/releases/download/v${version}/tether-node-linux-x64` },
    { name, browser_download_url: `https://github.com/x/releases/download/v${version}/${name}` },
  ],
})

beforeEach(() => {
  appVersion = '0.6.3'
  release = apk('0.6.4')
  ;(window as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { App: { getInfo: async () => ({ version: appVersion, build: '7' }) } } }
  globalThis.fetch = (async (url: string) => {
    fetched(String(url))
    return new Response(JSON.stringify(release), { status: 200 })
  }) as unknown as typeof fetch
  fetched.mockClear()
})
afterEach(() => {
  delete (window as any).Capacitor
  globalThis.fetch = realFetch
})

describe('the Android app looks for a newer APK', () => {
  test('finds the newer release and its APK on tether-releases', async () => {
    expect(await checkAppUpdate(true)).toEqual({ current: '0.6.3', latest: '0.6.4', url: 'https://github.com/x/releases/download/v0.6.4/tether-0.6.4.apk' })
    expect(fetched.mock.calls[0][0]).toBe(RELEASES_API)
  })

  test('asks GitHub at most once a day unless Settings asks', async () => {
    const t = 1_000_000_000
    await checkAppUpdate(false, t)
    await checkAppUpdate(false, t + 60_000)
    await checkAppUpdate(false, t + 23 * 3600_000)
    expect(fetched).toHaveBeenCalledTimes(1)
    await checkAppUpdate(false, t + 25 * 3600_000)
    expect(fetched).toHaveBeenCalledTimes(2)
    await checkAppUpdate(true, t + 25 * 3600_000 + 1)
    expect(fetched).toHaveBeenCalledTimes(3)
  })

  test('the same or an older version, a prerelease, or a release without an APK is no update', async () => {
    release = apk('0.6.3')
    expect(await checkAppUpdate(true)).toEqual({ current: '0.6.3' })
    release = { ...apk('0.7.0'), prerelease: true }
    expect(await checkAppUpdate(true)).toEqual({ current: '0.6.3' })
    release = { ...apk('0.7.0-rc.1') }
    expect(await checkAppUpdate(true)).toEqual({ current: '0.6.3' })
    release = { tag_name: 'v0.7.0', assets: [{ name: 'get.sh', browser_download_url: 'https://github.com/x/get.sh' }] }
    expect(await checkAppUpdate(true)).toEqual({ current: '0.6.3' })
  })

  test('a build from main between releases counts as its release', async () => {
    appVersion = '0.6.3-build.41'
    release = apk('0.6.3')
    expect((await checkAppUpdate(true))?.latest).toBeUndefined()
    release = apk('0.6.10')
    expect((await checkAppUpdate(true))?.latest).toBe('0.6.10')
  })

  test('outside the app it does nothing', async () => {
    delete (window as any).Capacitor
    expect(await checkAppUpdate(true)).toBeUndefined()
    expect(fetched).not.toHaveBeenCalled()
  })

  test('a failed check says so when asked for, and is quiet otherwise', async () => {
    globalThis.fetch = (async () => new Response('rate limited', { status: 403 })) as unknown as typeof fetch
    await expect(checkAppUpdate(true)).rejects.toThrow('GitHub answered 403')
  })

  test('one gentle notice per new version', async () => {
    const wait = () => new Promise((r) => setTimeout(r, 20))
    startAppUpdateCheck()
    await wait()
    expect(useStore.getState().toasts.map((t) => t.title)).toEqual(['Tether 0.6.4 is available'])
    expect(useStore.getState().toasts[0].href).toBe('/settings#updates')
    useStore.setState({ toasts: [] })
    // back to the app the next day, the same version: no second notice
    localStorage.removeItem('tether.app-update')
    document.dispatchEvent(new Event('visibilitychange'))
    await wait()
    expect(fetched).toHaveBeenCalledTimes(2)
    expect(useStore.getState().toasts).toEqual([])
  })
})

test('checks that start together share one request', async () => {
  localStorage.clear()
  ;(window as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { App: { getInfo: async () => ({ version: '0.6.3' }) } } }
  let n = 0
  globalThis.fetch = (async () => (n++, Response.json(apk('0.6.4')))) as unknown as typeof fetch
  await Promise.all([checkAppUpdate(), checkAppUpdate(), checkAppUpdate()])
  expect(n).toBe(1)
  delete (window as any).Capacitor
  globalThis.fetch = realFetch
})
