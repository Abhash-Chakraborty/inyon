import os from 'node:os'

/**
 * Which names the hub answers to. A web page on a domain its author controls can repoint that
 * domain at your machine (DNS rebinding) and then talk to the hub as its own site; the browser
 * still sends the attacker's name in Host. So browser requests are only answered under names a
 * stranger can't publish in public DNS:
 *
 *  - IP addresses (127.0.0.1, [::1], your Tailscale or NetBird address) and localhost
 *  - single-label names such as `my-server`, which only your own network resolves
 *  - private DNS suffixes: Tailscale (.ts.net), NetBird (.netbird.cloud, .netbird.selfhosted),
 *    mDNS and home networks (.local, .lan, .internal, .home.arpa, .localhost)
 *  - this machine's hostname, the BIND address, and the hosts in INYON_ALLOWED_ORIGINS
 *  - anything listed in INYON_ALLOWED_HOSTS (comma-separated, like `inyon.example.com`).
 *    Behind a reverse proxy on a public domain, add that domain here. `*` turns the check off.
 */

const PRIVATE_SUFFIX = /\.(ts\.net|netbird\.cloud|netbird\.selfhosted|local|lan|internal|home\.arpa|localhost)$/

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

/** "Example.com:4777" or "[::1]:4777" → "example.com" / "[::1]"; undefined if it isn't a host. */
export function hostnameOf(host: string): string | undefined {
  try {
    const u = new URL(`http://${host}`)
    return u.host === host.toLowerCase() || u.host === host.toLowerCase().replace(/:80$/, '') ? u.hostname : undefined
  } catch {
    return
  }
}

export function allowedHosts(env: Record<string, string | undefined> = process.env, bind = env.BIND ?? '') {
  const names = new Set([...list(env.INYON_ALLOWED_HOSTS), os.hostname().toLowerCase(), bind.toLowerCase()].filter(Boolean))
  for (const origin of list(env.INYON_ALLOWED_ORIGINS)) {
    try {
      names.add(new URL(origin).hostname)
    } catch {}
  }
  const any = names.has('*')
  return (host: string | null | undefined) => {
    if (any) return true
    const name = host ? hostnameOf(host) : undefined
    if (!name) return false
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.startsWith('[')) return true
    if (name === 'localhost' || !name.includes('.') || PRIVATE_SUFFIX.test(name)) return true
    return names.has(name)
  }
}
