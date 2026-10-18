import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

/**
 * The hub under test, as a process: a temp data folder, a temp home, a free port on 127.0.0.1,
 * and a PATH where `tmux`, `git` and the agents are stubs, so the hub's own machine ("local") looks
 * the same on every computer and nothing reaches the network or your tmux.
 *
 * Any hub can be dropped in with --hub '<command line>': it gets the same environment variables
 * (INYON_DATA_DIR, PORT, BIND, HOME, PATH, NODE_ENV, INYON_HUB_NAME), and has to write the
 * setup code to $INYON_DATA_DIR/setup-code on a first run, as the Bun hub does.
 */

export const REPO = path.resolve(import.meta.dir, '../..')
export const DEFAULT_HUB = `'${process.execPath}' '${path.join(REPO, 'apps/hub/src/index.ts')}'`

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

/** Stub programs on the hub's own PATH: its "local" machine has no tmux server and no git checkout. */
function hubStubs(bin: string) {
  fs.mkdirSync(bin, { recursive: true })
  const write = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  write('tmux', 'echo "no server running on /tmp/tmux-conformance/default" >&2; exit 1')
  // the hub's update check runs git in its checkout: here it isn't one, so the check is offline
  write('git', 'echo "fatal: not a git repository (or any of the parent directories): .git" >&2; exit 128')
  write('hostname', 'echo conformance-hub')
  write('uname', 'case "$1" in -m) echo x86_64;; *) echo Linux;; esac')
  write('pgrep', 'exit 1')
  write('curl', 'echo "curl: (7) Failed to connect (conformance hub has no network)" >&2; exit 7')
  write('node', 'exit 1')
  for (const name of ['claude', 'codex', 'opencode', 'copilot', 'gemini', 'agy']) write(name, 'exit 1')
}

export interface HubOptions {
  /** the command line that starts the hub (default: the Bun hub from this checkout) */
  command?: string
  /** writes records into the data folder before the hub starts (machines, settings) */
  seed?: (dataDir: string) => void
  log?: (line: string) => void
}

export class Hub {
  readonly dataDir: string
  readonly home: string
  base = ''
  port = 0
  private proc?: ReturnType<typeof Bun.spawn>
  private output: string[] = []

  constructor(
    readonly root: string,
    private o: HubOptions = {},
  ) {
    this.dataDir = path.join(root, 'data')
    this.home = path.join(root, 'hub-home')
  }

  get command() {
    return this.o.command ?? DEFAULT_HUB
  }

  /** The hub's last lines of output, for when it fails. */
  tail(n = 40) {
    return this.output.slice(-n).join('')
  }

  async start() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    const bin = path.join(this.home, '.local', 'bin')
    hubStubs(bin)
    // the same line the probe would work out from /sys, so "local" is a server everywhere
    fs.mkdirSync(path.join(this.home, '.inyon'), { recursive: true })
    fs.writeFileSync(path.join(this.home, '.inyon', 'machine-kind'), 'Linux|1||kvm|0|0|Conformance VM|\n')
    const noCli = path.join(this.root, 'no-cli-dist')
    fs.mkdirSync(noCli, { recursive: true })
    this.o.seed?.(this.dataDir)
    if (this.o.command === undefined) seedEngines(this.dataDir)
    this.port = await freePort()
    this.base = `http://127.0.0.1:${this.port}`
    const env: Record<string, string> = {
      HOME: this.home,
      PATH: `${bin}:/usr/bin:/bin`,
      INYON_DATA_DIR: this.dataDir,
      PORT: String(this.port),
      BIND: '127.0.0.1',
      NODE_ENV: 'test',
      INYON_HUB_NAME: 'Conformance hub',
      // a checkout's apps/cli/dist would change what node-dist hands out
      INYON_CLI_DIST: noCli,
      // anything that still reaches a real tmux finds a private, empty server folder
      TMUX_TMPDIR: path.join(this.root, 'tmux'),
      LANG: 'C.UTF-8',
      TZ: 'UTC',
    }
    fs.mkdirSync(env.TMUX_TMPDIR!, { recursive: true, mode: 0o700 })
    this.proc = Bun.spawn(['/bin/sh', '-c', `exec ${this.command}`], { cwd: this.root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true })
    for (const s of [this.proc.stdout, this.proc.stderr] as ReadableStream<Uint8Array>[]) {
      void (async () => {
        const dec = new TextDecoder()
        for await (const chunk of s) {
          const text = dec.decode(chunk, { stream: true })
          this.output.push(text)
          this.o.log?.(text)
        }
      })().catch(() => {})
    }
    const until = Date.now() + 30_000
    while (Date.now() < until) {
      if (this.proc.exitCode !== null) throw new Error(`the hub exited (${this.proc.exitCode}):\n${this.tail()}`)
      try {
        const r = await fetch(`${this.base}/api/session`)
        if (r.ok) return
      } catch {}
      await Bun.sleep(100)
    }
    throw new Error(`the hub did not answer on ${this.base} within 30 s:\n${this.tail()}`)
  }

  /** The first-run setup code, from the data folder. */
  setupCode() {
    return fs.readFileSync(path.join(this.dataDir, 'setup-code'), 'utf8').trim()
  }

  /** The token the inyon command on the hub's own machine reads to ask the hub (local-token). */
  localToken() {
    return fs.readFileSync(path.join(this.dataDir, 'local-token'), 'utf8').trim()
  }

  /** The hub's signing secret, from its records, to check the cookies it issues. */
  secret(): string | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dataDir, 'hub.json'), 'utf8')).secret
    } catch {
      return undefined
    }
  }

  async stop() {
    const p = this.proc
    if (!p || p.exitCode !== null) return
    // the hub and whatever it started in its process group (it was started detached, by us)
    try {
      process.kill(-p.pid, 'SIGTERM')
    } catch {
      p.kill()
    }
    const done = await Promise.race([p.exited.then(() => true), Bun.sleep(5000).then(() => false)])
    if (!done) {
      try {
        process.kill(-p.pid, 'SIGKILL')
      } catch {}
    }
  }
}

/**
 * The Bun hub run from a checkout builds the machine programs it hands out on the first "Add a
 * machine" (Bun's runtime for five systems, about 20 s and a download). For the default hub the
 * harness puts small placeholder files where that build lands, named the way the hub names its
 * build (features/node-dist.ts), so pairing answers at once and offline.
 */
function seedEngines(dataDir: string) {
  const script = "import { tag } from './apps/hub/src/features/node-dist.ts'; import { HUB_TARGETS, engineFile } from './apps/node/targets.ts'; console.log(JSON.stringify({ tag: tag(), files: HUB_TARGETS.map(engineFile) }))"
  const r = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: REPO,
    env: { ...process.env, INYON_DATA_DIR: dataDir, NODE_ENV: 'test' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const line = r.stdout.toString().trim().split('\n').at(-1)
  if (r.exitCode !== 0 || !line) throw new Error(`could not read the hub's build tag: ${r.stderr.toString()}`)
  const { tag, files } = JSON.parse(line) as { tag: string; files: string[] }
  const out = path.join(dataDir, 'node-dist')
  fs.mkdirSync(out, { recursive: true })
  for (const name of files) fs.writeFileSync(path.join(out, `${tag}-${name}`), `placeholder ${name} for the conformance harness\n`)
}
