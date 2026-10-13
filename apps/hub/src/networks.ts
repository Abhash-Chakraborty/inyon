import os from 'node:os'

/**
 * The private networks this machine is on: Tailscale (or a Headscale server), NetBird, ZeroTier
 * and plain WireGuard. Their addresses only reach devices on the same network, which the network
 * itself lets in and encrypts, so they're a direct way in that needs no tunnel. The phone link
 * answers on them, and `inyon hub start` says which address or command to use.
 *
 * The Tailscale and NetBird programs know the most (the machine's name on the network, whether
 * Tailscale can issue HTTPS certificates, whether NetBird can expose a port), so they're asked
 * first. Anything else is recognised by its network interface.
 */

export type NetKind = 'tailscale' | 'headscale' | 'netbird' | 'zerotier' | 'wireguard'

export interface Network {
  kind: NetKind
  /** this machine's IPv4 address on the network */
  ip: string
  /** this machine's name on the network, like `laptop.tail1234.ts.net` */
  name?: string
  /** Tailscale can serve HTTPS for this name (`tailscale serve`) */
  https?: string
  /** this NetBird has `netbird expose`, which publishes a port through its reverse proxy */
  expose?: boolean
}

export const LABEL: Record<NetKind, string> = { tailscale: 'Tailscale', headscale: 'Headscale', netbird: 'NetBird', zerotier: 'ZeroTier', wireguard: 'WireGuard' }

const ipv4 = (s: string | undefined) => (s ?? '').replace(/\/\d+$/, '').match(/^\d{1,3}(\.\d{1,3}){3}$/)?.[0]
const trimDot = (s: string | undefined) => (s ?? '').replace(/\.$/, '').toLowerCase() || undefined

/** `tailscale status --json`, when it's logged in and running. */
export function fromTailscale(status: any): Network | undefined {
  if (!status || status.BackendState !== 'Running') return
  const ip = (status.Self?.TailscaleIPs ?? status.TailscaleIPs ?? []).map(ipv4).find(Boolean)
  if (!ip) return
  const name = trimDot(status.Self?.DNSName)
  const suffix = trimDot(status.CurrentTailnet?.MagicDNSSuffix ?? status.MagicDNSSuffix)
  // Tailscale's own servers hand out names under ts.net; any other suffix is a Headscale server
  const kind: NetKind = suffix && !suffix.endsWith('ts.net') ? 'headscale' : 'tailscale'
  const https = (status.CertDomains ?? []).map(trimDot).find((d: string | undefined) => d && d === name)
  return { kind, ip, name, ...(https ? { https } : {}) }
}

/** `netbird status --json`, when it's connected. */
export function fromNetbird(status: any, expose = false): Network | undefined {
  if (!status || status.management?.connected === false) return
  const ip = ipv4(status.netbirdIp)
  if (!ip) return
  return { kind: 'netbird', ip, name: trimDot(status.fqdn), ...(expose ? { expose } : {}) }
}

/** Interfaces each network names its own way, on Linux, macOS and Windows. */
const IFACE: [RegExp, NetKind][] = [
  [/^tailscale\d*$|^Tailscale$/i, 'tailscale'],
  [/^wt\d+$|^NetBird/i, 'netbird'],
  [/^zt|^feth\d|^ZeroTier/i, 'zerotier'],
  [/^wg\d*$|^wg-|WireGuard/i, 'wireguard'],
]

/** The networks the interface list shows, for whatever the programs above didn't report. */
export function fromInterfaces(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): Network[] {
  const found: Network[] = []
  for (const [iface, list] of Object.entries(ifaces)) {
    const kind = IFACE.find(([re]) => re.test(iface))?.[1]
    const ip = (list ?? []).find((a) => a.family === 'IPv4' && !a.internal)?.address
    if (kind && ip) found.push({ kind, ip })
  }
  return found
}

/** Runs a program and parses what it prints as JSON; undefined if it's missing, slow or fails. */
async function json(cmd: string[], ms = 3000): Promise<any> {
  try {
    const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', windowsHide: true } as any)
    const timer = setTimeout(() => p.kill(), ms)
    const out = await new Response(p.stdout).text()
    clearTimeout(timer)
    return (await p.exited) === 0 ? JSON.parse(out) : undefined
  } catch {
    return
  }
}

async function succeeds(cmd: string[], ms = 3000) {
  try {
    const p = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore', windowsHide: true } as any)
    const timer = setTimeout(() => p.kill(), ms)
    const code = await p.exited
    clearTimeout(timer)
    return code === 0
  } catch {
    return false
  }
}

// the macOS app keeps its command line inside the bundle
const TAILSCALE = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']

export interface Probe {
  tailscale(): Promise<any>
  netbird(): Promise<any>
  netbirdExpose(): Promise<boolean>
  interfaces(): NodeJS.Dict<os.NetworkInterfaceInfo[]>
}

const system: Probe = {
  async tailscale() {
    for (const bin of TAILSCALE) {
      const s = await json([bin, 'status', '--json'])
      if (s) return s
    }
  },
  netbird: () => json(['netbird', 'status', '--json']),
  netbirdExpose: () => succeeds(['netbird', 'expose', '--help']),
  interfaces: () => os.networkInterfaces(),
}

/** Every private network this machine is on, one entry per address. */
export async function detectNetworks(probe: Probe = system): Promise<Network[]> {
  const [ts, nb] = await Promise.all([probe.tailscale(), probe.netbird()])
  const nets: Network[] = []
  const tailscale = fromTailscale(ts)
  if (tailscale) nets.push(tailscale)
  const netbird = fromNetbird(nb)
  if (netbird) nets.push({ ...netbird, ...((await probe.netbirdExpose()) ? { expose: true } : {}) })
  for (const n of fromInterfaces(probe.interfaces())) if (!nets.some((m) => m.ip === n.ip)) nets.push(n)
  return nets
}

