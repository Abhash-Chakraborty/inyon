import { absoluteLink } from './pages.ts'
import type { ShareLink, ShareList } from './api.ts'

/** A hub's answer as a list, also when parts are missing. */
export const asShareList = (l: Partial<ShareList> | undefined): ShareList => ({ address: l?.address ?? null, fromEnv: !!l?.fromEnv, links: l?.links ?? [] })

/** A hub from before shared links answers their routes with a bare "Not found". */
export const shareError = (e: Error) => (e.message === 'Not found' ? "This hub can't share blueprints yet. Update it first." : e.message)

/** How long a shared link may last, as the Share sheet offers it. */
export const SHARE_DAYS = [
  { v: '1', label: '1 day' },
  { v: '7', label: '7 days' },
  { v: '30', label: '30 days' },
] as const

/** The link to hand out: a link for your network is a path on the page's hub, put after the address this app reached it at. */
export const shareUrl = (host: string, url: string) => (url.startsWith('/') ? absoluteLink(host, url) : url)

/** "in 6 days", "in 5 h", "in 12 min", or "now" once it ran out. */
export function expiresIn(expires: number, now = Date.now()) {
  const m = Math.floor((expires - now) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `in ${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `in ${h} h`
  return `in ${Math.round(h / 24)} days`
}

/** Who a link is for, in a few words. */
export const audience = (s: Pick<ShareLink, 'public'>) => (s.public ? 'Anyone with the link' : 'Your network')

/** A link's line under its audience: when it ends, how often it was opened and when it was made. */
export function shareMeta(s: ShareLink, now = Date.now()) {
  const made = new Date(s.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `ends ${expiresIn(s.expires, now)} · ${s.opens === 1 ? '1 open' : `${s.opens} opens`} · made ${made}`
}
