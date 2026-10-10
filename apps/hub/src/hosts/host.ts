import path from 'node:path'
import type { HostConfig } from '@tether/protocol'
import { DATA_DIR } from '../config.ts'
import { nodeLinks } from './node-link.ts'

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')

/** POSIX single-quote a string for a shell command line. */
export const shq = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface PtyHandle {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  exited: Promise<number>
}

/**
 * Runs commands on a machine. The local machine runs them directly; remote machines go through
 * the system `ssh` binary so ~/.ssh/config, agents, jump hosts and known_hosts all just work.
 * A ControlMaster socket keeps one connection per machine, so each command is cheap.
 */
export class Host {
  constructor(public config: HostConfig) {}

  get id() {
    return this.config.id
  }

  private sshArgs(tty: boolean): string[] {
    const c = this.config
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${path.join(DATA_DIR, 'cm', '%C')}`,
      '-o', 'ControlPersist=600',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
    ]
    if (c.port) args.push('-p', String(c.port))
    if (c.identityFile) args.push('-i', c.identityFile)
    args.push(tty ? '-tt' : '-T', c.target!)
    return args
  }

  /** argv that runs `cmd` (a POSIX shell snippet) on this host. */
  private argv(cmd: string, tty = false): string[] {
    if (this.config.kind === 'local') return ['/bin/sh', '-c', cmd]
    return ['ssh', ...this.sshArgs(tty), `sh -c ${shq(cmd)}`]
  }

  private get isNode() {
    return this.config.kind === 'node'
  }

  /** exec over a tether-node connection */
  private nodeExec(cmd: string, opts: { input?: string | Uint8Array; timeoutMs?: number }): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const input = opts.input === undefined ? undefined : typeof opts.input === 'string' ? b64(new TextEncoder().encode(opts.input)) : b64(opts.input)
      let op: ReturnType<typeof nodeLinks.start>
      const timer = setTimeout(() => {
        op?.send({ op: 'kill' })
        op?.done()
        resolve({ code: 124, stdout: '', stderr: 'timed out' })
      }, opts.timeoutMs ?? 20000)
      try {
        op = nodeLinks.start(this.config.id, { op: 'exec', cmd, input }, (m) => {
          if (m.type === 'exit' || m.type === 'error') {
            clearTimeout(timer)
            op.done()
            if (m.type === 'error') resolve({ code: 255, stdout: '', stderr: m.error ?? 'node error' })
            else resolve({ code: m.code ?? 1, stdout: m.stdout ?? '', stderr: m.stderr ?? '' })
          }
        })
      } catch (e) {
        clearTimeout(timer)
        reject(e)
      }
    })
  }

  async exec(cmd: string, opts: { input?: string | Uint8Array; timeoutMs?: number } = {}): Promise<ExecResult> {
    if (this.isNode) return this.nodeExec(cmd, opts)
    const proc = Bun.spawn(this.argv(cmd), {
      stdin: opts.input === undefined ? 'ignore' : typeof opts.input === 'string' ? new TextEncoder().encode(opts.input) : opts.input,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: opts.timeoutMs ?? 20000,
      killSignal: 'SIGKILL',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code: proc.signalCode ? 124 : code, stdout, stderr: proc.signalCode ? `${stderr}timed out` : stderr }
  }

  /** Long-running command; calls onLine for each stdout line (e.g. `tail -F`). */
  stream(cmd: string, onLine: (line: string) => void, opts: { keepStdin?: boolean } = {}): { kill(): void; exited: Promise<number> } {
    if (this.isNode) {
      let finish!: (code: number) => void
      const exited = new Promise<number>((r) => (finish = r))
      try {
        const op = nodeLinks.start(this.config.id, { op: 'stream', cmd, keepStdin: !!opts.keepStdin }, (m) => {
          if (m.type === 'line') onLine(m.data)
          else if (m.type === 'exit' || m.type === 'error') {
            op.done()
            finish(m.code ?? 1)
          }
        })
        return { kill: () => (op.send({ op: 'kill' }), op.done(), finish(143)), exited }
      } catch {
        finish(255)
        return { kill() {}, exited }
      }
    }
    // control-mode tmux exits when stdin closes, so it gets a pipe we never write to
    const proc = Bun.spawn(this.argv(cmd), { stdin: opts.keepStdin ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'ignore' })
    ;(async () => {
      // split on newlines without re-copying the buffer per line (transcripts can hold MB-sized lines)
      const decoder = new TextDecoder()
      let carry = ''
      for await (const chunk of proc.stdout) {
        const text = carry + decoder.decode(chunk, { stream: true })
        let start = 0
        let i: number
        while ((i = text.indexOf('\n', start)) >= 0) {
          if (i > start) onLine(text.slice(start, i))
          start = i + 1
        }
        carry = start < text.length ? text.slice(start) : ''
      }
      if (carry) onLine(carry)
    })().catch(() => {})
    return { kill: () => proc.kill(), exited: proc.exited }
  }

  /** Interactive command in a pseudo-terminal (terminal views). */
  pty(cmd: string, cols: number, rows: number, onData: (d: Uint8Array) => void): PtyHandle {
    if (this.isNode) {
      let finish!: (code: number) => void
      const exited = new Promise<number>((r) => (finish = r))
      const op = nodeLinks.start(this.config.id, { op: 'pty', cmd, cols, rows }, (m) => {
        if (m.type === 'data') onData(Buffer.from(m.data, 'base64'))
        else if (m.type === 'exit' || m.type === 'error') {
          op.done()
          finish(m.code ?? 1)
        }
      })
      return {
        write: (d) => op.send({ op: 'write', data: d }),
        resize: (c, r) => op.send({ op: 'resize', cols: c, rows: r }),
        kill: () => (op.send({ op: 'kill' }), op.done(), finish(143)),
        exited,
      }
    }
    const proc = Bun.spawn(this.argv(cmd, true), {
      env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'C.UTF-8' },
      terminal: { cols, rows, data: (_t, d) => onData(d) },
    })
    return {
      write: (d) => proc.terminal?.write(d),
      resize: (c, r) => proc.terminal?.resize(c, r),
      kill: () => {
        proc.kill()
        proc.terminal?.close()
      },
      exited: proc.exited,
    }
  }
}
