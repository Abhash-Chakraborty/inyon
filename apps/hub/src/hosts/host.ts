import type { HostConfig } from '@inyon/protocol'

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

export interface ExecOptions {
  input?: string | Uint8Array
  timeoutMs?: number
}

export interface StreamHandle {
  kill(): void
  exited: Promise<number>
}

/**
 * How commands reach a machine. The hub runs them as processes (directly, or through the system
 * `ssh`) and over inyon links; the phone app opens its own SSH connections.
 */
export interface HostBackend {
  exec(config: HostConfig, cmd: string, opts: ExecOptions): Promise<ExecResult>
  /** Long-running command; calls onLine for each stdout line (e.g. `tail -F`). */
  stream(config: HostConfig, cmd: string, onLine: (line: string) => void, opts: { keepStdin?: boolean }): StreamHandle
  /** Interactive command in a pseudo-terminal (terminal views). */
  pty(config: HostConfig, cmd: string, cols: number, rows: number, onData: (d: Uint8Array) => void): PtyHandle
}

let pick: ((config: HostConfig) => HostBackend) | undefined
/** The platform says which backend serves each machine. */
export const setHostBackends = (choose: (config: HostConfig) => HostBackend) => void (pick = choose)
const backend = (config: HostConfig) => {
  if (!pick) throw new Error('No way to reach machines has been set up')
  return pick(config)
}

/**
 * tmux only writes UTF-8 when the locale says so, and a non-interactive SSH shell often has no
 * locale at all: then its field separator and every non-ASCII character come out as "_", and a
 * machine with sessions running lists none. -u makes it write UTF-8 whatever the locale. Only for
 * the real binary: on Windows `tmux` is already a shell function around psmux.
 */
export const UTF8_TMUX = `case "$(command -v tmux 2>/dev/null)" in /*) tmux() { command tmux -u "$@"; };; esac\n`

/** Runs POSIX shell snippets on one machine, whichever way it's reached. */
export class Host {
  constructor(public config: HostConfig) {}

  get id() {
    return this.config.id
  }

  exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return backend(this.config).exec(this.config, UTF8_TMUX + cmd, opts)
  }

  stream(cmd: string, onLine: (line: string) => void, opts: { keepStdin?: boolean } = {}): StreamHandle {
    return backend(this.config).stream(this.config, UTF8_TMUX + cmd, onLine, opts)
  }

  pty(cmd: string, cols: number, rows: number, onData: (d: Uint8Array) => void): PtyHandle {
    return backend(this.config).pty(this.config, cmd, cols, rows, onData)
  }
}
