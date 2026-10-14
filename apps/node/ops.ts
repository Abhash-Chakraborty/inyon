import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import WIN_PRELUDE from './win-prelude.sh' with { type: 'text' }
// before the commands' environment is made, so TETHER_* variables count as their INYON_* names
import { binDir, inyonCommand, nodeDir } from './paths.ts'

/**
 * What a hub or a phone can ask a machine to do: run a shell command, stream one's output line by
 * line, or run one in a terminal. Each connection (the hub's socket, or one phone session) gets
 * its own set, so closing it ends everything it started.
 */

export const WIN = process.platform === 'win32'

// Run in the background on Windows, the engine has no console, so a console program it starts
// (psmux, PowerShell, the shell) would get a window of its own and flash it open. Every spawn
// hides that window unless it says otherwise, whichever part of the program starts it.
if (WIN) {
  const b = Bun as unknown as Record<string, (cmd: unknown, opts?: Record<string, unknown>) => unknown>
  for (const name of ['spawn', 'spawnSync'] as const) {
    const real = b[name]!
    try {
      b[name] = (cmd, opts) => real(cmd, { windowsHide: true, ...opts })
    } catch {}
  }
}

type Proc = { kill(): void; write?(d: string): void; resize?(c: number, r: number): void }


/** The command that runs this program: the compiled binary itself, or Bun with the script. */
export function selfCommand(): string[] {
  const script = process.argv[1]
  const compiled = !script || script.startsWith('/$bunfs/') || /^[A-Z]:\\~BUN\\/i.test(script) || /^(inyon|tether-node)/.test(path.basename(process.execPath))
  if (!compiled) return [process.execPath, path.resolve(script)]
  // run as the engine (0.13 and on), the inyon command next to it is what services, the hub's
  // update and the app's start: it forwards here, and it's the one file an update replaces
  const cli = inyonCommand()
  return cli ? [cli] : [process.execPath]
}

/** busybox-w32, the small sh Windows runs Inyon's commands with (pinned, as the hub's installer). */
const BUSYBOX: Record<string, { file: string; sha256: string }> = {
  x64: { file: 'busybox-w64u-FRP-6075-g169694ebd.exe', sha256: '6e263d154d8548d1eb936f65d1d8312c80df31c45974e48d6335e4dcc0f4f34c' },
  arm64: { file: 'busybox-w64a-FRP-6075-g169694ebd.exe', sha256: 'e67f873d19d58c535cc9f0c4965ffd622e19b7bab87e3da89cb2185fb54464d7' },
}

/** On Windows, finds busybox (or fetches it once) and points INYON_SH at it. */
export async function ensureShell() {
  if (!WIN || (process.env.INYON_SH && existsSync(process.env.INYON_SH))) return
  const local = path.join(binDir(), 'busybox.exe')
  // install.ps1 put it in the node's folder before the rename
  const found = Bun.which('busybox') ?? [local, path.join(nodeDir(), 'bin', 'busybox.exe')].find((f) => existsSync(f))
  if (found) return void (process.env.INYON_SH = found)
  const pick = BUSYBOX[os.arch() === 'arm64' ? 'arm64' : 'x64']!
  console.log('downloading busybox-w32 (the shell Inyon runs commands with)…')
  const res = await fetch(`https://frippery.org/files/busybox/${pick.file}`)
  if (!res.ok) throw new Error(`couldn't download busybox-w32: ${res.status}`)
  const data = new Uint8Array(await res.arrayBuffer())
  if (crypto.createHash('sha256').update(data).digest('hex') !== pick.sha256) throw new Error("busybox-w32 didn't match its pinned checksum")
  mkdirSync(binDir(), { recursive: true })
  writeFileSync(`${local}.tmp`, data)
  renameSync(`${local}.tmp`, local)
  process.env.INYON_SH = local
}

const shellFor = (cmd: string) => (WIN ? [process.env.INYON_SH || 'busybox.exe', 'sh', '-c', `${WIN_PRELUDE}\n${cmd}`] : ['/bin/sh', '-c', cmd])

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
// how a command can run this program, as in "$INYON_EXE" ${INYON_SCRIPT:+"$INYON_SCRIPT"} update. Hubs
// and apps from before the rename to Inyon ask with the TETHER_NODE_* names.
const [selfExe, selfScript] = selfCommand()
const childEnv = Object.assign(WIN ? winEnv() : process.env, {
  INYON_EXE: selfExe,
  INYON_SCRIPT: selfScript ?? '',
  TETHER_NODE_EXE: selfExe,
  TETHER_NODE_SCRIPT: selfScript ?? '',
})
/** PATH the commands run with, which also covers the usual per-user install folders. */
export const childPath = () => childEnv[Object.keys(childEnv).find((k) => k.toLowerCase() === 'path') ?? 'PATH'] ?? ''

/**
 * Ends a command and everything it started. Commands run in their own process group (detached),
 * so on Unix the whole group goes: killing sh alone leaves a pipeline's other commands running and
 * holding its output open. On Windows, taskkill /T does the same for the process tree.
 */
function killTree(p: { pid: number; kill(): void }) {
  if (WIN) return void Bun.spawn(['taskkill', '/PID', String(p.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true } as any)
  try {
    process.kill(-p.pid, 'SIGTERM')
  } catch {
    p.kill()
  }
}

/** Collects a stream's bytes, so what arrived so far can be read without waiting for its end. */
function collect(s: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = []
  const done = (async () => {
    for await (const c of s) chunks.push(c)
  })().catch(() => {})
  return { done, text: () => Buffer.concat(chunks).toString('utf8') }
}

/** How long output may stay open after the shell exited (a child that escaped its group can hold it). */
const OUTPUT_GRACE_MS = 1000
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

// commands have process groups of their own, so they would outlive inyon: end them as it exits
const everyConnection = new Set<Map<string, Proc>>()
process.on('exit', () => {
  for (const running of everyConnection) for (const p of running.values()) p.kill()
})

export function serveOps(send: (m: unknown) => void) {
  const running = new Map<string, Proc>()
  everyConnection.add(running)
  return {
    async message(m: any) {
      const id = m.id
      switch (m.op) {
        case 'exec': {
          let env = childEnv
          let snapshot: string | undefined
          // the hub's process listing: answer it from Windows' own process table
          if (WIN && /\bps -e -o /.test(m.cmd)) {
            snapshot = path.join(os.tmpdir(), `inyon-ps-${process.pid}-${id}.txt`)
            writeFileSync(snapshot, await winProcs())
            env = { ...childEnv, INYON_PS: snapshot }
          }
          const p = Bun.spawn(shellFor(m.cmd), {
            stdin: m.input ? Buffer.from(m.input, 'base64') : 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
            env,
            windowsHide: true,
            detached: !WIN,
          } as any)
          running.set(id, { kill: () => killTree(p) })
          const out = collect(p.stdout as unknown as ReadableStream<Uint8Array>)
          const err = collect(p.stderr as unknown as ReadableStream<Uint8Array>)
          const code = await p.exited
          // a timed-out or killed command answers even if something it started still holds the output
          await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(OUTPUT_GRACE_MS)])
          running.delete(id)
          if (snapshot) rmSync(snapshot, { force: true })
          send({ id, type: 'exit', code, stdout: lf(out.text()), stderr: lf(err.text()) })
          break
        }
        case 'stream': {
          const p = Bun.spawn(shellFor(m.cmd), { stdin: m.keepStdin ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'ignore', env: childEnv, windowsHide: true, detached: !WIN } as any)
          running.set(id, { kill: () => killTree(p) })
          const map = winLine(m.cmd)
          const emit = (l: string) => {
            if (WIN) l = l.replace(/\r$/, '')
            if (l) send({ id, type: 'line', data: map ? map(l) : l })
          }
          const pumped = (async () => {
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
          p.exited.then(async (code) => {
            running.delete(id)
            // the hub stops listening at exit, so the last lines go first
            await Promise.race([pumped, Bun.sleep(OUTPUT_GRACE_MS)])
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
      everyConnection.delete(running)
    },
  }
}
