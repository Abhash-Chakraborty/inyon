import path from 'node:path'
import type { HostConfig } from '@tether/protocol'
import { shq, type HostBackend } from './host.ts'

/**
 * The hub's machines reached as processes: the local machine runs commands directly; remote
 * machines go through the system `ssh` binary so ~/.ssh/config, agents, jump hosts and
 * known_hosts all just work. A ControlMaster socket keeps one connection per machine, so each
 * command is cheap.
 */
export function processBackend(controlDir: string): HostBackend {
  const sshArgs = (c: HostConfig, tty: boolean): string[] => {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${path.join(controlDir, '%C')}`,
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
  const argv = (c: HostConfig, cmd: string, tty = false): string[] =>
    c.kind === 'local' ? ['/bin/sh', '-c', cmd] : ['ssh', ...sshArgs(c, tty), `sh -c ${shq(cmd)}`]

  return {
    async exec(config, cmd, opts) {
      // its own process group, so a timeout kills the whole pipeline: killing only /bin/sh leaves
      // children holding the output open, the call never returns and the host stops being polled
      const proc = Bun.spawn(argv(config, cmd), {
        stdin: opts.input === undefined ? 'ignore' : typeof opts.input === 'string' ? new TextEncoder().encode(opts.input) : opts.input,
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          process.kill(-proc.pid, 'SIGKILL')
        } catch {
          proc.kill('SIGKILL')
        }
      }, opts.timeoutMs ?? 20000)
      try {
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
        return { code: timedOut ? 124 : code, stdout, stderr: timedOut ? `${stderr}timed out` : stderr }
      } finally {
        clearTimeout(timer)
      }
    },

    stream(config, cmd, onLine, opts) {
      // control-mode tmux exits when stdin closes, so it gets a pipe we never write to
      const proc = Bun.spawn(argv(config, cmd), { stdin: opts.keepStdin ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'ignore' })
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
    },

    pty(config, cmd, cols, rows, onData) {
      const proc = Bun.spawn(argv(config, cmd, true), {
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
    },
  }
}
