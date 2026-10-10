#!/usr/bin/env bun
/**
 * tether-node: lets a Tether hub reach this machine without opening any ports.
 *
 * It keeps one outbound WebSocket to the hub and runs what the hub asks for (shell commands,
 * streams, terminals) as the current user. Pair it from the hub's "Add a machine" screen:
 *
 *   bun tether-node.ts <hub-url> <token>
 *
 * Plain http:// is only accepted for private addresses (localhost, LAN, Tailscale/NetBird);
 * anything else must be https://.
 */
import os from 'node:os'
import path from 'node:path'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import WIN_PRELUDE from './win-prelude.sh' with { type: 'text' }

const VERSION = '0.3.0'
const WIN = process.platform === 'win32'

// a compiled Windows build has no console, so it logs to node.log next to its .env
if (WIN) {
  const log = path.join(os.homedir(), '.tether-node', 'node.log')
  const write = (...a: unknown[]) => {
    try {
      appendFileSync(log, `${new Date().toISOString()} ${a.map(String).join(' ')}\n`)
    } catch {}
  }
  console.log = write
  console.error = write
}
const [hubArg, tokenArg] = process.argv.slice(2)
// the installers keep the hub address and token in ~/.tether-node/env (mode 600), so the token
// never sits in the process list where other users could read it
const saved = readEnvFile(path.join(os.homedir(), '.tether-node', 'env'))
const hub = (hubArg ?? process.env.TETHER_HUB ?? saved.TETHER_HUB ?? '').replace(/\/+$/, '')
const token = tokenArg ?? process.env.TETHER_TOKEN ?? saved.TETHER_TOKEN ?? ''

function readEnvFile(file: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(file, 'utf8').split(/\r?\n/).flatMap((l) => {
        const m = l.match(/^(\w+)=(.*)$/)
        return m ? [[m[1], m[2]]] : []
      }),
    )
  } catch {
    return {}
  }
}

if (!hub || !token) {
  console.error('usage: tether-node <hub-url> <token>')
  process.exit(2)
}

function isPrivate(url: URL) {
  const h = url.hostname
  // IPv6 literals: loopback, unique-local (fc00::/7, Tailscale uses fd7a:115c:a1e0::/48), link-local
  if (h.startsWith('[')) return /^\[(::1|f[cd][0-9a-f]{0,2}:|fe[89ab][0-9a-f]?:)/i.test(h)
  if (h === 'localhost' || h === '::1' || /^127\./.test(h)) return true
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true // CGNAT range used by Tailscale and NetBird
  if (/\.(ts\.net|netbird\.cloud|netbird\.selfhosted|local|lan|internal)$/.test(h)) return true
  return !h.includes('.') // single-label names on your private network
}

const url = new URL(hub)
if (url.protocol === 'http:' && !isPrivate(url) && !process.env.TETHER_ALLOW_INSECURE) {
  console.error(`Refusing to send the token over plain http to ${url.hostname}. Use https, or a private network address.`)
  process.exit(2)
}
const wsUrl = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/node`

type Proc = { kill(): void; write?(d: string): void; resize?(c: number, r: number): void }
const running = new Map<string, Proc>()


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

function connect(attempt = 0) {
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } } as any)
  const send = (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))

  ws.onopen = () => {
    attempt = 0
    console.log(`connected to ${url.host}`)
    send({ type: 'hello', version: VERSION, os: `${os.platform()} ${os.arch()}`, hostname: os.hostname(), platform: os.platform(), mux: WIN ? 'psmux' : 'tmux' })
  }

  ws.onmessage = async (e) => {
    let m: any
    try {
      m = JSON.parse(String(e.data))
    } catch {
      return
    }
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
  }

  ws.onclose = (e) => {
    for (const p of running.values()) p.kill()
    running.clear()
    if (e.code === 4001) {
      console.log('This machine was removed from Tether. Exiting.')
      process.exit(0)
    }
    if (e.code === 4003) {
      console.error('The hub rejected the token. Pair this machine again from the hub.')
      process.exit(1)
    }
    const delay = Math.min(30_000, 1000 * 2 ** attempt)
    console.log(`disconnected (${e.code}); retrying in ${Math.round(delay / 1000)}s`)
    setTimeout(() => connect(attempt + 1), delay)
  }
  ws.onerror = () => {}
}

connect()
