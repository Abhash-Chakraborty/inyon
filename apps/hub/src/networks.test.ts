import { describe, expect, test } from 'bun:test'
import { detectNetworks, fromInterfaces, fromNetbird, fromTailscale, type Probe } from './networks.ts'

// trimmed from `tailscale status --json` and `netbird status --json`
const tailscale = {
  BackendState: 'Running',
  Self: { DNSName: 'laptop.tail1234.ts.net.', TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'] },
  CertDomains: ['laptop.tail1234.ts.net'],
  CurrentTailnet: { Name: 'me@example.com', MagicDNSSuffix: 'tail1234.ts.net', MagicDNSEnabled: true },
}
const netbird = { fqdn: 'laptop.netbird.selfhosted', netbirdIp: '100.71.4.20/16', management: { url: 'https://nb.example.com:443', connected: true } }

const v4 = (address: string) => ({ address, family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }) as any

describe('networks', () => {
  test('Tailscale: name, address and HTTPS', () => {
    expect(fromTailscale(tailscale)).toEqual({ kind: 'tailscale', ip: '100.101.102.103', name: 'laptop.tail1234.ts.net', https: 'laptop.tail1234.ts.net' })
  })

  test('a tailnet without HTTPS certificates has no https', () => {
    expect(fromTailscale({ ...tailscale, CertDomains: null })?.https).toBeUndefined()
  })

  test('a name outside ts.net is a Headscale server', () => {
    const hs = { ...tailscale, Self: { ...tailscale.Self, DNSName: 'laptop.hs.example.com.' }, CertDomains: [], CurrentTailnet: { MagicDNSSuffix: 'hs.example.com' } }
    expect(fromTailscale(hs)).toEqual({ kind: 'headscale', ip: '100.101.102.103', name: 'laptop.hs.example.com' })
  })

  test('Tailscale logged out or stopped is no network', () => {
    expect(fromTailscale({ ...tailscale, BackendState: 'NeedsLogin' })).toBeUndefined()
    expect(fromTailscale({ ...tailscale, BackendState: 'Stopped' })).toBeUndefined()
  })

  test('NetBird: name and address without the prefix length', () => {
    expect(fromNetbird(netbird, true)).toEqual({ kind: 'netbird', ip: '100.71.4.20', name: 'laptop.netbird.selfhosted', expose: true })
  })

  test('NetBird not connected is no network', () => {
    expect(fromNetbird({ ...netbird, management: { connected: false } })).toBeUndefined()
    expect(fromNetbird({ ...netbird, netbirdIp: '' })).toBeUndefined()
  })

  test('ZeroTier and WireGuard by their interfaces; everything else left out', () => {
    expect(
      fromInterfaces({
        eth0: [v4('192.168.1.20')],
        ztabcdef12: [v4('10.147.17.5')],
        wg0: [v4('10.8.0.2')],
        docker0: [v4('172.17.0.1')],
        lo: [{ ...v4('127.0.0.1'), internal: true }],
      }),
    ).toEqual([
      { kind: 'zerotier', ip: '10.147.17.5' },
      { kind: 'wireguard', ip: '10.8.0.2' },
    ])
  })

  test('the programs win over the interface list, and each address shows once', async () => {
    const probe: Probe = {
      tailscale: async () => tailscale,
      netbird: async () => netbird,
      netbirdExpose: async () => false,
      interfaces: () => ({ tailscale0: [v4('100.101.102.103')], wt0: [v4('100.71.4.20')], wg0: [v4('10.8.0.2')] }),
    }
    expect(await detectNetworks(probe)).toEqual([
      { kind: 'tailscale', ip: '100.101.102.103', name: 'laptop.tail1234.ts.net', https: 'laptop.tail1234.ts.net' },
      { kind: 'netbird', ip: '100.71.4.20', name: 'laptop.netbird.selfhosted' },
      { kind: 'wireguard', ip: '10.8.0.2' },
    ])
  })

  test('nothing installed, nothing found', async () => {
    const none: Probe = { tailscale: async () => undefined, netbird: async () => undefined, netbirdExpose: async () => false, interfaces: () => ({ eth0: [v4('192.168.1.20')] }) }
    expect(await detectNetworks(none)).toEqual([])
  })
})
