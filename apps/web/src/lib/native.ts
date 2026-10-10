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
}

/** Keeps the status bar text readable on the current theme. */
export function nativeTheme(theme: 'light' | 'dark') {
  plugin('StatusBar')?.setStyle({ style: theme === 'dark' ? 'DARK' : 'LIGHT' }).catch(() => {})
}

let notifyId = 1
/** A system notification from the phone apps (the app is in the background, its link still open). */
export async function nativeNotify(title: string, body: string, href: string) {
  const ln = plugin('LocalNotifications')
  if (!ln) return false
  try {
    const perm = await ln.checkPermissions()
    if (perm.display !== 'granted') return false
    await ln.schedule({ notifications: [{ id: notifyId++ % 2147483647, title, body, extra: { href } }] })
    return true
  } catch {
    return false
  }
}

export async function askNativeNotifications() {
  const ln = plugin('LocalNotifications')
  if (!ln) return undefined
  try {
    return (await ln.requestPermissions()).display === 'granted'
  } catch {
    return false
  }
}
