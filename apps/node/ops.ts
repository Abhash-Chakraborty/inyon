import os from 'node:os'
import path from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import WIN_PRELUDE from './win-prelude.sh' with { type: 'text' }

/**
 * What a hub or a phone can ask a machine to do: run a shell command, stream one's output line by
 * line, or run one in a terminal. Each connection (the hub's socket, or one phone session) gets
 * its own set, so closing it ends everything it started.
 */

export const WIN = process.platform === 'win32'

type Proc = { kill(): void; write?(d: string): void; resize?(c: number, r: number): void }


const shellFor = (cmd: string) => (WIN ? [process.env.TETHER_SH || 'busybox.exe', 'sh', '-c', `${WIN_PRELUDE}\n${cmd}`] : ['/bin/sh', '-c', cmd])

/** Child environment on Windows: a Unix-style HOME, the usual install folders on PATH, no SHELL. */
function winEnv(): Record<string, string | undefined> {
  const home = os.homedir()
  const env: Record<string, string | undefined> = { ...process.env, HOME: home.replace(/\\/g, '/') }
  // psmux would start new panes in $SHELL (busybox) instead of PowerShell
  delete env.SHELL
  const extra = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, 'scoop', 'shims'),
    path.join(home, '.cargo', 'bin'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
  ].filter(Boolean)
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path'
  env[key] = [...extra, env[key]].join(';')
  return env
}
const childEnv = WIN ? winEnv() : process.env

/** Ends a command and everything it started (on Windows, killing sh alone leaves tmux clients behind). */
function killTree(p: { pid: number; kill(): void }) {
  if (WIN) Bun.spawn(['taskkill', '/PID', String(p.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true } as any)
  else p.kill()
}
const lf = (s: string) => (WIN ? s.replace(/\r\n/g, '\n') : s)

/**
 * Windows process list (pid ppid age name args, like `ps -e -o pid=,ppid=,etimes=,comm=,args=`)
 * from one PowerShell kept running, since starting one per probe costs about a second of CPU.
 */
const PS_QUERY =
  "$n=Get-Date; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,CommandLine | % { $c=$_.CommandLine; if (-not $c) { $c=$_.Name }; $a=0; if ($_.CreationDate) { $a=[int]($n-$_.CreationDate).TotalSeconds }; '{0} {1} {2} {3} {4}' -f $_.ProcessId,$_.ParentProcessId,$a,($_.Name -replace '\\.exe$',''),($c -replace '[\\r\\n]+',' ') }; '@@DONE'"
let psHelper: { p: ReturnType<typeof Bun.spawn>; out: string; wake?: () => void } | undefined
let psQueue: Promise<unknown> = Promise.resolve()
function winProcs(): Promise<string> {
  const run = async () => {
    if (!psHelper || psHelper.p.exitCode !== null) {
      const p = Bun.spawn(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], {
        stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: childEnv, windowsHide: true,
      } as any)
      const h = (psHelper = { p, out: '' as string, wake: undefined as undefined | (() => void) })
      ;(async () => {
        const dec = new TextDecoder()
        for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
          h.out += dec.decode(chunk, { stream: true })
          h.wake?.()
        }
      })().catch(() => {})
      ;(p.stdin as any).write('[Console]::OutputEncoding=[Text.Encoding]::UTF8\n')
    }
    const h = psHelper
    h.out = ''
    ;(h.p.stdin as any).write(PS_QUERY + '\n')
    ;(h.p.stdin as any).flush?.()
    const deadline = Date.now() + 10_000
    while (!/^@@DONE\r?$/m.test(h.out)) {
      if (Date.now() > deadline || h.p.exitCode !== null) {
        killTree(h.p)
        psHelper = undefined
        return ''
      }
      await new Promise<void>((r) => {
        h.wake = r
        setTimeout(r, 250)
      })
    }
    return lf(h.out).split('\n@@DONE')[0].replace(/^@@DONE[\s\S]*/, '')
  }
  const next = psQueue.then(run, run)
  psQueue = next.catch(() => {})
  return next
}

/** psmux's control mode numbers panes per session; tell the hub which session they belong to. */
function winLine(cmd: string): ((l: string) => string) | undefined {
  const sid = WIN && cmd.match(/tmux -C attach-session -t '?\$(\d+)/)?.[1]
  if (!sid) return
  return (l) => l.replace(/^(%(?:extended-)?output) %(\d+) /, `$1 %${sid}.$2 `)
}

export function serveOps(send: (m: unknown) => void) {
  const running = new Map<string, Proc>()
  return {
    async message(m: any) {
      const id = m.id
      switch (m.op) {
        case 'exec': {
          let env = childEnv
          let snapshot: string | undefined
          // the hub's process listing: answer it from Windows' own process table
          if (WIN && /\bps -e -o /.test(m.cmd)) {
            snapshot = path.join(os.tmpdir(), `tether-ps-${process.pid}-${id}.txt`)
            writeFileSync(snapshot, await winProcs())
            env = { ...childEnv, TETHER_PS: snapshot }
          }
          const p = Bun.spawn(shellFor(m.cmd), {
            stdin: m.input ? Buffer.from(m.input, 'base64') : 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
            env,
            windowsHide: true,
          } as any)
          running.set(id, { kill: () => killTree(p) })
          const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
          running.delete(id)
          if (snapshot) rmSync(snapshot, { force: true })
          send({ id, type: 'exit', code, stdout: lf(stdout), stderr: lf(stderr) })
          break
        }
        case 'stream': {
          const p = Bun.spawn(shellFor(m.cmd), { stdin: m.keepStdin ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'ignore', env: childEnv, windowsHide: true } as any)
          running.set(id, { kill: () => killTree(p) })
          const map = winLine(m.cmd)
          const emit = (l: string) => {
            if (WIN) l = l.replace(/\r$/, '')
            if (l) send({ id, type: 'line', data: map ? map(l) : l })
          }
          ;(async () => {
            const dec = new TextDecoder()
            let carry = ''
            for await (const chunk of p.stdout) {
              const text = carry + dec.decode(chunk, { stream: true })
              const lines = text.split('\n')
              carry = lines.pop() ?? ''
              for (const l of lines) emit(l)
            }
            if (carry) emit(carry)
          })().catch(() => {})
          p.exited.then((code) => {
            running.delete(id)
            send({ id, type: 'exit', code })
          })
          break
        }
        case 'pty': {
          const p = Bun.spawn(shellFor(m.cmd), {
            env: { ...childEnv, TERM: 'xterm-256color' },
            windowsHide: true,
            terminal: { cols: m.cols ?? 80, rows: m.rows ?? 24, data: (_t: unknown, d: Uint8Array) => send({ id, type: 'data', data: Buffer.from(d).toString('base64') }) },
          } as any)
          running.set(id, {
            kill: () => (killTree(p), (p as any).terminal?.close()),
            write: (d) => (p as any).terminal?.write(d),
            resize: (c, r) => (p as any).terminal?.resize(c, r),
          })
          p.exited.then((code) => {
            running.delete(id)
            send({ id, type: 'exit', code })
          })
          break
        }
        case 'write':
          running.get(id)?.write?.(m.data)
          break
        case 'resize':
          running.get(id)?.resize?.(m.cols, m.rows)
          break
        case 'kill':
          running.get(id)?.kill()
          running.delete(id)
          break
      }
    },
    close() {
      for (const p of running.values()) p.kill()
      running.clear()
    },
  }
}
