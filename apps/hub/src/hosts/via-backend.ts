import type { HostConfig } from '@tether/protocol'
import { shq, type HostBackend } from './host.ts'
import { nodeBackend } from './node-backend.ts'

/**
 * Servers reached over SSH from a paired computer rather than from the phone: a jump box, or a
 * laptop on the company VPN, that can already ssh to them. It runs `ssh` for each command with its
 * own keys, ~/.ssh/config and known_hosts, so nothing is installed on the server and the phone
 * needs no route to it and no key for it. One shared connection per server keeps commands cheap.
 */
export function viaCommand(c: HostConfig, cmd: string, tty = false) {
  const opts = [
    'BatchMode=yes',
    'ControlMaster=auto',
    '"ControlPath=$HOME/.cache/tether-ssh/%C"',
    'ControlPersist=600',
    'ServerAliveInterval=15',
    'ServerAliveCountMax=3',
    'ConnectTimeout=10',
    'StrictHostKeyChecking=accept-new',
  ].map((o) => `-o ${o}`)
  const port = c.port ? ` -p ${c.port}` : ''
  return `mkdir -p "$HOME/.cache/tether-ssh" 2>/dev/null; exec ssh ${opts.join(' ')}${port} ${tty ? '-tt' : '-T'} -- ${shq(c.target!)} ${shq(`sh -c ${shq(cmd)}`)}`
}

/** `lookup` finds the paired computer a server names in `via`. */
export function viaBackend(lookup: (id: string) => HostConfig | undefined): HostBackend {
  const through = (c: HostConfig) => {
    const v = c.via ? lookup(c.via) : undefined
    return v?.kind === 'link' || v?.kind === 'node' ? v : undefined
  }
  const gone = 'The computer this server is reached through is no longer paired. Edit the server and pick another.'
  // the server itself runs nothing of Tether's: when the computer isn't there, say so by name
  const away = (v: HostConfig) => `${v.name} isn't connected right now, and this server is reached through it.`
  return {
    async exec(config, cmd, opts) {
      const v = through(config)
      if (!v) return { code: 255, stdout: '', stderr: gone }
      try {
        return await nodeBackend.exec(v, viaCommand(config, cmd), opts)
      } catch {
        return { code: 255, stdout: '', stderr: away(v) }
      }
    },
    stream(config, cmd, onLine, opts) {
      const v = through(config)
      if (!v) return { kill() {}, exited: Promise.resolve(255) }
      return nodeBackend.stream(v, viaCommand(config, cmd), onLine, opts)
    },
    pty(config, cmd, cols, rows, onData) {
      const v = through(config)
      if (!v) throw new Error(gone)
      try {
        return nodeBackend.pty(v, viaCommand(config, cmd, true), cols, rows, onData)
      } catch {
        throw new Error(away(v))
      }
    },
  }
}
