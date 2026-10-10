import type { HostConfig } from '@tether/protocol'
import { shq, type ExecResult, type HostBackend } from '../hosts/host.ts'
import type { SshPlugin } from './types.ts'

/** How a server signs in, read from the phone's keystore when a connection opens. */
export type Credentials = { password?: string; privateKey?: string; passphrase?: string; ed25519Seed?: string; ed25519Public?: string }

export const toBase64 = (data: string | Uint8Array) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

/** "user@host" → its parts (the phone has no ~/.ssh/config, so the user is always given). */
export function splitTarget(target = '') {
  const at = target.lastIndexOf('@')
  return at > 0 ? { username: target.slice(0, at), host: target.slice(at + 1) } : { username: '', host: target }
}

// a server that just refused us isn't asked again on every poll
const RETRY_MS = 8000

/**
 * Machines reached straight from the phone over SSH, through the native TetherSsh plugin. A
 * connection opens on first use and again after it drops; the plugin pools connections per server.
 */
export function sshBackend(ssh: SshPlugin, credentials: (config: HostConfig) => Promise<Credentials>) {
  const conns = new Map<string, Promise<void>>()
  const failed = new Map<string, { at: number; error: Error }>()
  const streams = new Map<string, { onLine: (line: string) => void; done: (code: number) => void }>()
  const ptys = new Map<string, { onData: (d: Uint8Array) => void; done: (code: number) => void }>()
  let seq = 0

  ssh.addListener('streamLines', (e) => {
    const s = streams.get(e.streamId)
    // the hub's own streams skip empty lines, so these do too
    if (s) for (const line of e.lines) if (line) s.onLine(line)
  })
  ssh.addListener('streamExit', (e) => streams.get(e.streamId)?.done(e.code))
  ssh.addListener('ptyData', (e) => ptys.get(e.ptyId)?.onData(fromBase64(e.data)))
  ssh.addListener('ptyExit', (e) => ptys.get(e.ptyId)?.done(e.code))
  ssh.addListener('closed', (e) => conns.delete(e.id))

  const open = async (config: HostConfig) => {
    const { username, host } = splitTarget(config.target)
    if (!username) throw new Error('Add the user name, like you@server')
    if (!config.hostKey) throw new Error("This server's key hasn't been confirmed. Edit it and check the fingerprint.")
    await ssh.connect({ id: config.id, host, port: config.port ?? 22, username, hostKey: config.hostKey, ...(await credentials(config)) })
  }

  const connect = (config: HostConfig) => {
    let p = conns.get(config.id)
    if (p) return p
    const f = failed.get(config.id)
    if (f && Date.now() - f.at < RETRY_MS) return Promise.reject(f.error)
    p = open(config).then(
      () => void failed.delete(config.id),
      (err) => {
        conns.delete(config.id)
        const error = new Error(describe(err, config))
        failed.set(config.id, { at: Date.now(), error })
        throw error
      },
    )
    conns.set(config.id, p)
    return p
  }

  const backend: HostBackend = {
    async exec(config, cmd, opts): Promise<ExecResult> {
      try {
        await connect(config)
        return await ssh.exec({
          id: config.id,
          command: `sh -c ${shq(cmd)}`,
          stdin: opts.input === undefined ? undefined : toBase64(opts.input),
          timeoutMs: opts.timeoutMs ?? 20000,
        })
      } catch (err) {
        // ssh's own "couldn't connect" code, so callers treat it like the hub's ssh failing
        return { code: 255, stdout: '', stderr: describe(err) }
      }
    },

    stream(config, cmd, onLine, opts) {
      const streamId = `s${++seq}`
      let killed = false
      let started = false
      let done!: (code: number) => void
      const exited = new Promise<number>((resolve) => (done = resolve)).finally(() => streams.delete(streamId))
      streams.set(streamId, { onLine, done })
      connect(config)
        .then(() => {
          if (killed) return done(143)
          started = true
          return ssh.stream({ id: config.id, streamId, command: `sh -c ${shq(cmd)}`, keepStdin: !!opts.keepStdin })
        })
        .catch(() => done(255))
      return {
        kill: () => {
          killed = true
          if (started) ssh.streamKill({ streamId }).catch(() => done(143))
        },
        exited,
      }
    },

    pty(config, cmd, cols, rows, onData) {
      const ptyId = `p${++seq}`
      let killed = false
      let started = false
      let done!: (code: number) => void
      const exited = new Promise<number>((resolve) => (done = resolve)).finally(() => ptys.delete(ptyId))
      ptys.set(ptyId, { onData, done })
      connect(config)
        .then(() => {
          if (killed) return done(143)
          started = true
          return ssh.pty({ id: config.id, ptyId, command: `sh -c ${shq(cmd)}`, cols, rows })
        })
        .catch((err) => {
          onData(new TextEncoder().encode(`\r\n${describe(err)}\r\n`))
          done(255)
        })
      return {
        write: (data) => void (started && ssh.ptyWrite({ ptyId, data }).catch(() => {})),
        resize: (c, r) => void (started && ssh.ptyResize({ ptyId, cols: c, rows: r }).catch(() => {})),
        kill: () => {
          killed = true
          if (started) ssh.ptyKill({ ptyId }).catch(() => done(143))
        },
        exited,
      }
    },
  }

  return {
    backend,
    /** Closes a server's connections (it was removed, or its settings changed). */
    forget(id: string) {
      conns.delete(id)
      failed.delete(id)
      return ssh.disconnect({ id }).catch(() => {})
    },
  }
}

/** The plugin's error codes as something a person can act on. */
function describe(err: unknown, config?: HostConfig) {
  const e = err as { code?: string; message?: string }
  const msg = e?.message ?? String(err)
  if (e?.code === 'HOST_KEY_MISMATCH') return `The server's key changed. If you reinstalled it, edit the server and confirm the new fingerprint. (${msg})`
  if (e?.code === 'AUTH_FAILED') {
    const check = config?.auth === 'password' ? 'the password' : config?.auth === 'key' ? 'that its public key is in ~/.ssh/authorized_keys' : "that this phone's key is in ~/.ssh/authorized_keys"
    return `The server didn't accept the sign-in. Check the user name and ${check}. (${msg})`
  }
  if (e?.code === 'UNREACHABLE') return `Can't reach the server. Check the address and that this phone is on the same network or VPN. (${msg})`
  return msg
}
