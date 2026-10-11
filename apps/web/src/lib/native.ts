/**
 * The Tether phone apps run this same web app inside a native shell (Capacitor). The shell injects
 * `window.Capacitor`, whose `Plugins` proxy calls straight into native code, so the web app needs
 * no extra packages and does nothing different in a normal browser.
 */
type Plugin = Record<string, (...args: any[]) => Promise<any>>

const cap = () => (window as any).Capacitor as { isNativePlatform?: () => boolean; getPlatform?: () => string; Plugins?: Record<string, Plugin> } | undefined

export const isNative = () => !!cap()?.isNativePlatform?.()
export const platform = () => (isNative() ? cap()!.getPlatform!() : 'web') as 'ios' | 'android' | 'web'
export const plugin = (name: string): Plugin | undefined => (isNative() ? cap()?.Plugins?.[name] : undefined)

const go = (href: string) => {
  window.history.pushState({}, '', href)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** Native behaviour for the phone apps: back button, notification taps, status bar. */
export function installNative() {
  if (!isNative()) return
  document.documentElement.dataset.native = platform()
  // Android's back button walks back through the app, and leaves it from the first screen
  plugin('App')?.addListener('backButton', ({ canGoBack }: { canGoBack: boolean }) => {
    if (canGoBack && window.history.length > 1) window.history.back()
    else plugin('App')?.exitApp()
  })
  // tapping a notification opens the session it's about
  plugin('LocalNotifications')?.addListener('localNotificationActionPerformed', (e: { notification?: { extra?: { href?: string } } }) => {
    const href = e.notification?.extra?.href
    if (href) go(href)
  })
  plugin('StatusBar')?.setOverlaysWebView({ overlay: true }).catch(() => {})
  // a tether://pair link (a laptop's code scanned with the camera) opens the pairing sheet
  plugin('App')?.addListener('appUrlOpen', ({ url }: { url: string }) => {
    if (/^tether:\/\/pair\?/.test(url)) go(`/machines?pair=${encodeURIComponent(url)}`)
  })
  // back from the background: sockets may have died while the phone slept, so check them now
  const resume = () => {
    if (document.visibilityState === 'visible') import('./phone.ts').then(({ phone }) => phone()).then((r) => r.resume(), () => {})
  }
  plugin('App')?.addListener('resume', resume)
  document.addEventListener('visibilitychange', resume)
}

/** Keeps the status bar text readable on the current theme. */
export function nativeTheme(theme: 'light' | 'dark') {
  plugin('StatusBar')?.setStyle({ style: theme === 'dark' ? 'DARK' : 'LIGHT' }).catch(() => {})
}

let notifyId = 1
/** A system notification from the phone apps (the app is in the background, its link still open). */
/**
 * A notification from the phone app, with Tether's logo. `tag` names the session or machine: its
 * next notification replaces this one, and opening it clears it.
 */
export async function nativeNotify(title: string, body: string, href: string, tag?: string, kind?: string) {
  const device = plugin('TetherDevice')
  if (device?.postNotification) {
    try {
      await device.postNotification({ title, body, href, tag, kind })
      return true
    } catch {}
  }
  const ln = plugin('LocalNotifications')
  if (!ln) return false
  try {
    const perm = await ln.checkPermissions()
    if (perm.display !== 'granted') return false
    await ln.schedule({ notifications: [{ id: notifyId++ % 2147483647, title, body, smallIcon: 'ic_stat_tether', extra: { href } }] })
    return true
  } catch {
    return false
  }
}

/** You're looking at it now: take its notification away. */
export function clearNativeNotification(tag: string) {
  void Promise.resolve(plugin('TetherDevice')?.clearNotification?.({ tag })).catch(() => {})
}

export async function askNativeNotifications() {
  const device = plugin('TetherDevice')
  try {
    if (device?.requestNotificationPermission) return !!(await device.requestNotificationPermission()).granted
    const ln = plugin('LocalNotifications')
    if (!ln) return undefined
    return (await ln.requestPermissions()).display === 'granted'
  } catch {
    return false
  }
}

/** Whether the phone app may post notifications (permission given and not turned off for Tether). */
export async function nativeNotificationsOn(): Promise<boolean | undefined> {
  const device = plugin('TetherDevice')
  try {
    if (device?.notificationsEnabled) return !!(await device.notificationsEnabled()).enabled
    const p = await plugin('LocalNotifications')?.checkPermissions()
    return p ? p.display === 'granted' : undefined
  } catch {
    return undefined
  }
}

/** A file the phone app handed over (keyboard image, clipboard), as base64. */
export interface NativeFile {
  name: string
  type: string
  data: string
}

export const nativeFile = (f: NativeFile) => new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name || 'pasted', { type: f.type || 'application/octet-stream' })

/** Listens to a native plugin event; returns a function that stops listening. */
export function onNative<T>(name: string, event: string, fn: (e: T) => void) {
  const handle = plugin(name)?.addListener(event, fn) as Promise<{ remove(): void }> | { remove(): void } | undefined
  return () => void Promise.resolve(handle).then((h) => h?.remove())
}
