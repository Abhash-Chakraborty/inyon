import { newerRelease, parseRelease, RELEASES_API } from '@inyon/protocol'
import { isNative, plugin } from './native.ts'
import { toast } from './store.ts'

/**
 * The Android app checks inyon-releases for a newer APK: at most once a day on its own, and
 * whenever Settings opens. It never installs anything. Download opens the APK in the browser and
 * Android asks before installing it.
 */
export { RELEASES_API }

const CHECKED = 'inyon.app-update'
const TOLD = 'inyon.app-update-told'
const DAY = 24 * 60 * 60_000
const HOUR = 60 * 60_000

export interface AppUpdate {
  current: string
  latest?: string
  url?: string
}

interface Checked {
  at: number
  version?: string
  url?: string
}

const read = <T,>(k: string): T | undefined => {
  try {
    const raw = localStorage.getItem(k)
    return raw ? (JSON.parse(raw) as T) : undefined
  } catch {
    return undefined
  }
}
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {}
}

async function appVersion(): Promise<string | undefined> {
  const info = await plugin('App')?.getInfo().catch(() => undefined)
  return typeof info?.version === 'string' ? info.version : undefined
}

/**
 * The newest release that has an APK. inyon-releases carries tether-node too, so a release
 * without an APK doesn't count.
 */
export async function latestApk(): Promise<{ version: string; url: string } | undefined> {
  const res = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const r = (await res.json()) as { tag_name?: string; prerelease?: boolean; draft?: boolean; assets?: { name?: string; browser_download_url?: string }[] }
  const version = String(r.tag_name ?? '').replace(/^v/, '')
  if (r.prerelease || r.draft || !parseRelease(version)) return undefined
  const apks = (r.assets ?? []).filter((a) => /\.apk$/i.test(a.name ?? '') && /^https:\/\//.test(a.browser_download_url ?? ''))
  const apk = apks.find((a) => a.name === `inyon-${version}.apk`) ?? apks[0]
  return apk ? { version, url: apk.browser_download_url! } : undefined
}

/**
 * This app's version and, when there is one, the newer release and its APK. `force` asks GitHub
 * now (Settings opening); otherwise the last answer is used for a day. Undefined outside the app.
 */
export function checkAppUpdate(force = false, now = Date.now()): Promise<AppUpdate | undefined> {
  // a start and a return to the app at the same moment share one request
  if (force) return check(true, now)
  return (checking ??= check(false, now).finally(() => (checking = undefined)))
}
let checking: Promise<AppUpdate | undefined> | undefined

async function check(force: boolean, now: number): Promise<AppUpdate | undefined> {
  if (!isNative()) return undefined
  const current = await appVersion()
  if (!current) return undefined
  let saved = read<Checked>(CHECKED)
  if (force || !saved || now - saved.at >= DAY) {
    try {
      const apk = await latestApk()
      saved = { at: now, version: apk?.version, url: apk?.url }
      write(CHECKED, saved)
    } catch (err) {
      // offline: try again in an hour, not on every return to the app
      write(CHECKED, { ...saved, at: now - DAY + HOUR })
      if (force || !saved) throw err
    }
  }
  return saved.version && saved.url && newerRelease(saved.version, current) ? { current, latest: saved.version, url: saved.url } : { current }
}

/** One gentle notice per new version, at start and on return to the app. */
export function startAppUpdateCheck() {
  if (!isNative()) return
  const run = () =>
    checkAppUpdate().then((u) => {
      if (!u?.latest || read<string>(TOLD) === u.latest) return
      write(TOLD, u.latest)
      toast({ title: `Inyon ${u.latest} is available`, body: 'Download it from Settings.', tone: 'info', href: '/settings#updates' })
    }, () => {})
  void run()
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void run())
}
