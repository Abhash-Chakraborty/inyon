import { plugin, onNative } from './native.ts'
import { toast } from './store.ts'

/**
 * The phone app staying connected in the background: a small ongoing notification (Android's
 * foreground service) stops the system from freezing the app, so sockets stay open and alerts
 * arrive at once. A per-device choice, so it lives in this device's storage.
 */
const KEY = 'tether.keepAlive'
const NOTICE = { title: 'Tether is connected', text: 'Keeping your sessions live so alerts arrive right away' }

const device = () => plugin('TetherDevice')
export const keepAliveSupported = () => !!device()?.startKeepAlive

export function keepAliveWanted() {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export async function setKeepAlive(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {}
  const d = device()
  if (!d) return
  if (!on) return void (await d.stopKeepAlive().catch(() => {}))
  // without the permission Android still runs the service, but hides its notification
  await d.requestNotificationPermission?.().catch(() => {})
  await d.startKeepAlive(NOTICE)
}

/** At launch (the app is in the foreground, which Android requires to start the service). */
export function installKeepAlive() {
  if (!keepAliveSupported()) return
  if (keepAliveWanted()) device()!.startKeepAlive(NOTICE).catch(() => {})
  // Android may stop it (a daily limit, memory); it can only be started again from the foreground
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && keepAliveWanted()) device()?.startKeepAlive(NOTICE).catch(() => {})
  })
  onNative<{ reason: string }>('TetherDevice', 'keepAliveStopped', (e) => {
    // Stop on its notification: the user turned it off, so it stays off
    if (e.reason === 'stopped') {
      try {
        localStorage.setItem(KEY, '0')
      } catch {}
      return toast({ title: 'Background connection off', body: 'Turn it back on in Settings.', tone: 'info' })
    }
    toast({
      title: 'Background connection paused',
      body: e.reason === 'timeout' ? 'Android limits how long it can run each day. It starts again when you open Tether.' : 'Android stopped it. It starts again when you open Tether.',
      tone: 'info',
    })
  })
}

export async function batteryUnrestricted(): Promise<boolean | undefined> {
  return device()?.isIgnoringBatteryOptimizations?.().then((r: { ignoring: boolean }) => r.ignoring, () => undefined)
}

export const openBatterySettings = () => device()?.openBatterySettings?.().catch(() => {})
