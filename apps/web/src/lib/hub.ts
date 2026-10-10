import { isNative } from './native.ts'

/**
 * Where the hub is. In a browser the app is served by the hub, so every path is relative. In the
 * phone apps the web app is bundled inside the app: you enter your hub's address once, and the app
 * signs in with a token (kept on the device) instead of a cookie.
 */
const HUB_KEY = 'tether.hub'
const TOKEN_KEY = 'tether.token'

const read = (k: string) => {
  try {
    return localStorage.getItem(k) ?? ''
  } catch {
    return ''
  }
}
const write = (k: string, v: string) => {
  try {
    if (v) localStorage.setItem(k, v)
    else localStorage.removeItem(k)
  } catch {}
}

/** "" in a browser (same origin), the saved hub address in the phone apps. */
export const hubBase = () => (isNative() ? read(HUB_KEY) : '')
export const setHubBase = (url: string) => write(HUB_KEY, url.trim().replace(/\/+$/, ''))
export const needsHub = () => isNative() && !read(HUB_KEY)

export const hubToken = () => (isNative() ? read(TOKEN_KEY) : '')
export const setHubToken = (t: string) => write(TOKEN_KEY, t)

export const apiUrl = (path: string) => hubBase() + path

/** Headers that sign a request in from the phone apps. */
export const authHeaders = (): Record<string, string> => {
  const t = hubToken()
  return t ? { authorization: `Bearer ${t}` } : {}
}

export function wsUrl() {
  const base = hubBase()
  if (!base) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  const u = new URL(base)
  const t = hubToken()
  return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/ws${t ? `?t=${encodeURIComponent(t)}` : ''}`
}

/** The hub's own address as the machines see it (for pairing commands). */
export const hubOrigin = () => hubBase() || location.origin

/** "http://my-server:4777", "100.64.1.2:4777" or "hub.example.ts.net" → a URL to try. */
export function normalizeHub(input: string) {
  const v = input.trim().replace(/\/+$/, '')
  if (!v) return ''
  return /^https?:\/\//i.test(v) ? v : `http://${v}`
}
