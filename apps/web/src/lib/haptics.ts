import { useStore } from './store.ts'
import { plugin } from './native.ts'

export type HapticKind = 'tap' | 'select' | 'success' | 'warning' | 'error'

const PATTERNS: Record<HapticKind, number | number[]> = {
  tap: 8,
  select: 12,
  success: [10, 40, 14],
  warning: [18, 60, 18],
  error: [28, 50, 28, 50, 28],
}

let iosSwitch: HTMLLabelElement | null = null
const isIOS = typeof navigator !== 'undefined' && /iP(hone|ad|od)/.test(navigator.userAgent)

/**
 * Haptic feedback on the web. Android browsers implement the Vibration API; iOS Safari doesn't,
 * but toggling a native `<input type="checkbox" switch>` produces the system haptic (iOS 17.4+),
 * which works inside a user gesture.
 */
export function haptic(kind: HapticKind = 'tap') {
  if (!useStore.getState().settings.haptics) return
  // the phone apps use the system haptic engine (Taptic Engine on iPhone)
  const native = plugin('Haptics')
  if (native) {
    const run =
      kind === 'tap' ? native.impact({ style: 'LIGHT' })
      : kind === 'select' ? native.selectionChanged()
      : native.notification({ type: kind === 'success' ? 'SUCCESS' : kind === 'warning' ? 'WARNING' : 'ERROR' })
    run?.catch(() => {})
    return
  }
  try {
    if ('vibrate' in navigator && !isIOS) {
      navigator.vibrate(PATTERNS[kind])
      return
    }
    if (isIOS) {
      if (!iosSwitch) {
        iosSwitch = document.createElement('label')
        iosSwitch.ariaHidden = 'true'
        iosSwitch.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.setAttribute('switch', '')
        iosSwitch.appendChild(input)
        document.body.appendChild(iosSwitch)
      }
      iosSwitch.click()
      if (kind === 'success' || kind === 'warning' || kind === 'error') setTimeout(() => iosSwitch?.click(), 90)
    }
  } catch {}
}

/** Haptics on every button press in the app (light tap), installed once. */
export function installTapHaptics() {
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType !== 'touch') return
      const el = (e.target as HTMLElement)?.closest?.('button, a, [role="switch"], [role="radio"], [role="tab"], [role="option"], [role="menuitem"]')
      if (el && !(el as HTMLButtonElement).disabled) haptic('tap')
    },
    { passive: true, capture: true },
  )
}
