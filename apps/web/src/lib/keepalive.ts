import { plugin, onNative } from './native.ts'
import { toast, useStore } from './store.ts'

/**
 * The phone app staying connected in the background: a small ongoing notification (Android's
 * foreground service) stops the system from freezing the app, so sockets stay open and alerts
 * arrive at once. On unless turned off; a per-device choice, so it lives in this device's storage.
 */
const KEY = 'tether.keepAlive'
/** set once Android's "let Tether run in the background?" prompt has been shown, so it's asked only once */
const ASKED = 'tether.batteryAsked'
const NOTICE = { title: 'Tether is connected', text: 'Keeping your sessions live so alerts arrive right away' }

const device = () => plugin('TetherDevice')
export const keepAliveSupported = () => !!device()?.startKeepAlive

export function keepAliveWanted() {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
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
  if (keepAliveWanted()) {
    // alerts need the permission anyway; Android asks at most twice, then answers by itself
    const d = device()!
    Promise.resolve(d.requestNotificationPermission?.())
      .catch(() => {})
      .then(() => d.startKeepAlive(NOTICE))
      .catch(() => {})
  }
  // once there's a machine to stay connected to, ask Android not to put Tether to sleep
  const off = useStore.subscribe((s) => {
    if (!s.hosts.length) return
    off()
    void askBatteryOnce()
  })
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

/**
 * Android's one-tap prompt to stop restricting Tether in the background (without it the screen
 * going off cuts the connection after a while), or its settings list on an older app. True once
 * Tether is unrestricted.
 */
export async function allowBackground(): Promise<boolean | undefined> {
  const d = device()
  if (typeof d?.requestBatteryExemption !== 'function') {
    await openBatterySettings()
    return undefined
  }
  return d.requestBatteryExemption().then((r: { ignoring?: boolean }) => r?.ignoring, () => undefined)
}

let asking = false

/** The prompt, asked once ever while Stay connected is on, and only while Tether is restricted. */
export async function askBatteryOnce() {
  if (asking || !keepAliveWanted() || typeof device()?.requestBatteryExemption !== 'function') return
  try {
    if (localStorage.getItem(ASKED)) return
  } catch {
    return
  }
  asking = true
  try {
    if ((await batteryUnrestricted()) !== false || document.visibilityState !== 'visible') return
    try {
      localStorage.setItem(ASKED, '1')
    } catch {}
    await allowBackground()
  } finally {
    asking = false
  }
}
