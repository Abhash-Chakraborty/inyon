import { absoluteLink } from './pages.ts'
import type { ShareCheck, ShareLink, ShareList } from './api.ts'

/** A hub's answer as a list, also when parts are missing. */
export const asShareList = (l: Partial<ShareList> | undefined): ShareList => ({ address: l?.address ?? null, fromEnv: !!l?.fromEnv, upstream: l?.upstream, links: l?.links ?? [] })

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

// ---- setting up the public address ----

/** The host name someone typed, as an address: `share.example.com` → `https://share.example.com`. */
export function addressOf(input: string) {
  const t = input.trim().replace(/\/+$/, '')
  if (!t) return ''
  return /^[a-z]+:\/\//i.test(t) ? t : `https://${t}`
}

/** The host name in an address, lowercase, without a port. */
export function nameOf(address: string) {
  try {
    return new URL(addressOf(address)).hostname.toLowerCase()
  } catch {
    return ''
  }
}

// the second-level names a country uses under its code (example.co.uk is a main domain)
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'ne', 'or', 'go'])

/** The main domain a name sits under: share.example.co.uk → example.co.uk. */
export function mainDomainOf(name: string) {
  const parts = name.split('.').filter(Boolean)
  if (parts.length < 2) return name
  const take = parts.length >= 3 && parts.at(-1)!.length === 2 && SECOND_LEVEL.has(parts.at(-2)!) ? 3 : 2
  return parts.slice(-take).join('.')
}

/** Why a name isn't a good one for shared links, or '' when it is: a subdomain kept for this. */
export function nameAdvice(name: string, appName = location.hostname) {
  if (!name) return ''
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name) || name.includes(':')) return 'Use a name, not an IP address: links need a certificate made out to a name.'
  if (!name.includes('.')) return 'Use a full name, such as share.example.com.'
  if (name === appName.toLowerCase()) return "That's the address you open Inyon at. Shared links need a name of their own."
  if (mainDomainOf(name) === name) return `That's a main domain. Use a subdomain you keep for this, such as share.${name}, so nothing else on ${name} changes.`
  return ''
}

/** The DNS record to add for a name: its label under the main domain, an A record to the proxy's IP. */
export function dnsRecord(name: string) {
  const main = mainDomainOf(name)
  const label = name === main ? '@' : name.slice(0, -(main.length + 1))
  return { type: 'A', name: label, zone: main }
}

export type ProxyKind = 'caddy' | 'traefik' | 'nginx'

/** A proxy's config that forwards only /share/ on `name` to the hub at `upstream`, keeping the Host header. */
export function proxyConfig(kind: ProxyKind, name: string, upstream = '127.0.0.1:4777') {
  if (kind === 'caddy') {
    return `${name} {\n\thandle /share/* {\n\t\treverse_proxy ${upstream}\n\t}\n\thandle {\n\t\trespond 404\n\t}\n}\n`
  }
  if (kind === 'traefik') {
    return [
      'http:',
      '  routers:',
      '    inyon-share:',
      `      rule: "Host(\`${name}\`) && PathPrefix(\`/share/\`)"`,
      '      entryPoints: [websecure]',
      '      middlewares: [inyon-share-rate]',
      '      service: inyon-share',
      '      tls:',
      '        certResolver: letsencrypt',
      '  middlewares:',
      '    inyon-share-rate:',
      '      rateLimit:',
      '        average: 20',
      '        burst: 40',
      '  services:',
      '    inyon-share:',
      '      loadBalancer:',
      '        passHostHeader: true',
      '        servers:',
      `          - url: "http://${upstream}"`,
      '',
    ].join('\n')
  }
  return [
    'server {',
    '    listen 443 ssl;',
    `    server_name ${name};`,
    `    ssl_certificate     /etc/letsencrypt/live/${name}/fullchain.pem;`,
    `    ssl_certificate_key /etc/letsencrypt/live/${name}/privkey.pem;`,
    '',
    '    location /share/ {',
    `        proxy_pass http://${upstream};`,
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '    }',
    '',
    '    location / {',
    '        return 404;',
    '    }',
    '}',
    '',
  ].join('\n')
}

export type CheckLine = { ok: boolean; title: string; body?: string }

/** A check's result as lines for the setup: the name, reaching this hub, and nothing else answering. */
export function checkLines(c: ShareCheck): CheckLine[] {
  const name = nameOf(c.address)
  const dns: CheckLine = c.dns.ok
    ? { ok: true, title: `${name} points at ${c.dns.addresses.join(', ')}` }
    : { ok: false, title: `${name} doesn't point anywhere yet`, body: 'Add the DNS record. A new record can take a few minutes to show up.' }
  if (!c.dns.ok) return [dns]
  const r = c.reach
  const reach: CheckLine = r.ok
    ? { ok: true, title: 'Links reach this hub', body: 'The name, its certificate and the proxy all lead here.' }
    : r.fault === 'tls'
      ? { ok: false, title: `The certificate for ${name} isn't valid`, body: 'Your proxy gets one once the name points at it. Behind Cloudflare, set the record to DNS only, or use Full (strict) SSL.' }
      : r.fault === 'refused' || r.fault === 'timeout'
        ? { ok: false, title: `Nothing answers at ${name}`, body: 'Check the proxy is running and that ports 80 and 443 are open on its machine.' }
        : r.fault === 'not-hub'
          ? { ok: false, title: `${name} answered ${r.status ?? ''}, but not from this hub`.replace('  ', ' '), body: 'Forward /share/ to the hub and keep the Host header, as in the example above.' }
          : { ok: false, title: `Couldn't reach ${name}`, body: r.error }
  if (!r.ok) return [dns, reach]
  const wall: CheckLine = c.wall.ok
    ? { ok: true, title: 'Nothing else answers there', body: 'Only /share/ links get through; the rest is a 404.' }
    : { ok: false, title: `${c.wall.open.map((o) => o.path).join(' and ')} answer${c.wall.open.length === 1 ? 's' : ''} there too`, body: 'Forward only /share/ to the hub. The hub still refuses the rest on that name, but keep both walls.' }
  return [dns, reach, wall]
}
