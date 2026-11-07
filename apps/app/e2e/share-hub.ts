// The hub's shared-link routes (crates/inyon-hub/src/shares.rs), for the stand-in hubs: a page's
// links, every link, revoking, the public address and its check. Each link's `url` is shown once,
// as the hub does; a link for your network is a path, one for anyone a full address.

type Link = { id: string; host: string; slug: string; public: boolean; created: number; expires: number; opens: number }
type Check = Record<string, unknown>

export const shares = {
  address: null as string | null,
  fromEnv: false,
  upstream: '127.0.0.1:4777',
  links: [] as Link[],
  /** what the next check finds: by default everything passes */
  check: undefined as undefined | ((address: string) => Check),
  /** the next address saved answers this refusal */
  refuse: undefined as undefined | string,
  calls: [] as string[],
  made: 0,
}

/** The hub as it starts: no address, no links. */
export function resetShares() {
  Object.assign(shares, { address: null, fromEnv: false, upstream: '127.0.0.1:4777', links: [], check: undefined, refuse: undefined, calls: [], made: 0 })
}

export const passed = (address: string): Check => ({ address, dns: { ok: true, addresses: ['203.0.113.4'] }, reach: { ok: true }, wall: { ok: true, open: [], unsure: [] } })

const listing = (links: Link[]) => ({ address: shares.address, fromEnv: shares.fromEnv, upstream: shares.upstream, links })
const json = (body: unknown, status = 200) => Response.json(body, { status })

/** Answers a share route, or undefined for any other. `body` is the request's JSON, already read. */
export function shareRoute(method: string, p: string, body: any): Response | undefined {
  const page = /^\/api\/pages\/([^/]+)\/([^/]+)\/shares(?:\/([^/]+))?$/.exec(p)
  if (page) {
    const [host, slug] = [decodeURIComponent(page[1]!), decodeURIComponent(page[2]!)]
    shares.calls.push(`${method} page ${slug}${page[3] ? ` ${page[3]}` : ''}`)
    if (method === 'GET') return json(listing(shares.links.filter((l) => l.host === host && l.slug === slug)))
    if (method === 'POST') {
      if (![1, 7, 30].includes(body?.days)) return json({ error: 'Pick 1, 7 or 30 days.' }, 400)
      if (body.public && !shares.address) return json({ error: 'Set an address for shared links first.' }, 409)
      const now = Date.now()
      const id = `s${++shares.made}`
      const link: Link = { id, host, slug, public: !!body.public, created: now, expires: now + body.days * 86_400_000, opens: 0 }
      shares.links.push(link)
      const path = `/share/tok${shares.made}/`
      return json({ ...link, url: link.public ? `${shares.address}${path}` : path })
    }
    if (method === 'DELETE' && page[3]) {
      const before = shares.links.length
      shares.links = shares.links.filter((l) => l.id !== decodeURIComponent(page[3]!))
      return before === shares.links.length ? json({ error: 'No such link' }, 404) : json({ ok: true })
    }
  }
  if (p === '/api/shares') {
    shares.calls.push(`${method} all`)
    if (method === 'GET') return json(listing(shares.links))
    if (method === 'DELETE') {
      const revoked = shares.links.length
      shares.links = []
      return json({ revoked })
    }
  }
  const one = /^\/api\/shares\/([^/]+)$/.exec(p)
  if (one && method === 'DELETE') {
    shares.calls.push(`DELETE ${one[1]}`)
    shares.links = shares.links.filter((l) => l.id !== decodeURIComponent(one[1]!))
    return json({ ok: true })
  }
  if (p === '/api/share-address' && method === 'PUT') {
    shares.calls.push(`PUT address ${body?.address}`)
    if (shares.refuse) {
      const e = shares.refuse
      shares.refuse = undefined
      return json({ error: e }, 400)
    }
    shares.address = body?.address || null
    return json(listing(shares.links))
  }
  if (p === '/api/share-address/check' && method === 'POST') {
    shares.calls.push('check')
    if (!shares.address) return json({ error: 'Set an address for shared links first.' }, 409)
    return json((shares.check ?? passed)(shares.address))
  }
  return undefined
}
