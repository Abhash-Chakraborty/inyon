import { describe, expect, test } from 'bun:test'
import { MACHINE_KIND_SH, machineKind } from './machine-kind.ts'

describe('machine kind', () => {
  test('a cloud VM is a server (this kind of box: KVM, no display)', () => {
    expect(machineKind('Linux|1|vm|kvm|0|0|KVM Virtual Machine|')).toBe('server')
  })

  test('containers and server chassis are servers', () => {
    expect(machineKind('Linux|||docker|0|0||')).toBe('server')
    expect(machineKind('Linux|23|server|none|0|0|PowerEdge R640|')).toBe('server')
  })

  test('Linux with no graphical session is a server, even on desktop hardware', () => {
    expect(machineKind('Linux|3|desktop|none|0|0|OptiPlex 7090|')).toBe('server')
  })

  test('Linux laptops by chassis type, hostnamectl or battery', () => {
    for (const ct of ['8', '9', '10', '14']) expect(machineKind(`Linux|${ct}||none|1|0|ThinkPad|`)).toBe('laptop')
    expect(machineKind('Linux|||none|1|0||')).toBe('desktop')
    expect(machineKind('Linux||convertible|none|1|0||')).toBe('laptop')
    expect(machineKind('Linux|||none|1|1||')).toBe('laptop')
  })

  test('a Linux desktop with a display is a desktop', () => {
    expect(machineKind('Linux|3|desktop|none|1|0|B550 AORUS|')).toBe('desktop')
  })

  test('WSL takes after the PC it runs on', () => {
    expect(machineKind('Linux|||wsl|0|0||')).toBe('desktop')
    expect(machineKind('Linux|||wsl|0|1||')).toBe('laptop')
  })

  test('macOS: a battery or a MacBook model is a laptop', () => {
    expect(machineKind('Darwin||||1|1|Mac14,2|')).toBe('laptop')
    expect(machineKind('Darwin||||1|0|MacBookPro18,3|')).toBe('laptop')
    expect(machineKind('Darwin||||1|0|Mac14,3|')).toBe('desktop')
    expect(machineKind('Darwin||||1|0|VirtualMac2,1|')).toBe('server')
  })

  test('Windows: server editions and VMs, then chassis or battery', () => {
    expect(machineKind('Windows|3|||1|0|OptiPlex|3')).toBe('server')
    expect(machineKind('Windows|1|||1|0|Virtual Machine|1')).toBe('server')
    expect(machineKind('Windows|10|||1|1|XPS 13|1')).toBe('laptop')
    expect(machineKind('Windows|3,9|||1|0|Surface|1')).toBe('laptop')
    expect(machineKind('Windows|3|||1|0|Custom PC|1')).toBe('desktop')
  })

  test('no facts (an older probe) is unknown', () => {
    expect(machineKind('')).toBeUndefined()
  })

  test('the probe script runs here and caches what it found', async () => {
    const home = `${process.env.TMPDIR ?? '/tmp'}/inyon-kind-${process.pid}`
    const run = async () => {
      const p = Bun.spawn(['sh', '-c', MACHINE_KIND_SH], { env: { ...process.env, HOME: home, DISPLAY: '', WAYLAND_DISPLAY: '' }, stdout: 'pipe' })
      return (await new Response(p.stdout).text()).trim()
    }
    try {
      const out = await run()
      expect(out).toMatch(/^@@KIND (Linux|Darwin)\|/)
      expect(machineKind(out.slice(7))).toBeDefined()
      expect(await Bun.file(`${home}/.inyon/machine-kind`).text()).toBe(`${out.slice(7)}\n`)
      // the second run reads the file instead of looking again
      await Bun.write(`${home}/.inyon/machine-kind`, 'Linux|||none|1|1||\n')
      expect(await run()).toBe('@@KIND Linux|||none|1|1||')
    } finally {
      await Bun.$`rm -rf ${home}`.quiet()
    }
  })
})
