import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { childPath, WIN } from './ops.ts'

/**
 * Keeps the phone link running without a terminal window: a user service that starts at login and
 * comes back if it stops (systemd on Linux, launchd on macOS, a logon task on Windows). No admin
 * rights, nothing outside your home folder. The program copies itself into ~/.tether-node/bin
 * first, so the download can be deleted.
 */

// worked out on use, so tests can point them at a throwaway home
const NAME = 'tether-node'
const dir = () => path.join(os.homedir(), '.tether-node')
const bin = () => path.join(dir(), 'bin')
const unit = () => path.join(os.homedir(), '.config', 'systemd', 'user', `${NAME}.service`)
const plist = () => path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.tether.node-link.plist')
/** The PID of the background process started where there are no user services. */
const pidFile = () => path.join(dir(), 'link.pid')
const TASK = 'Tether link'

/** The command that runs this program: the compiled binary itself, or Bun with the script. */
function self(): string[] {
  const script = process.argv[1]
  const compiled = !script || script.startsWith('/$bunfs/') || /^[A-Z]:\\~BUN\\/i.test(script) || path.basename(process.execPath).startsWith(NAME)
  return compiled ? [process.execPath] : [process.execPath, path.resolve(script)]
}

/** A missing program (no systemctl in a container, say) is a failure like any other, not a crash. */
export const run = (cmd: string[]) => {
  try {
    const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
    return { ok: p.exitCode === 0, out: `${p.stdout}${p.stderr}`.trim() }
  } catch (err) {
    return { ok: false, out: `${cmd[0]} isn't available here (${(err as Error).message})` }
  }
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** systemd splits ExecStart on spaces; quote each argument */
const sdq = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Copies a compiled binary into ~/.tether-node/bin (a script run with Bun stays where it is). */
function settle(cmd: string[]): string[] {
  if (cmd.length > 1) return cmd
  const target = path.join(bin(), WIN ? `${NAME}.exe` : NAME)
  if (path.resolve(cmd[0]!) === path.resolve(target)) return cmd
  mkdirSync(bin(), { recursive: true })
  // a running copy can't be overwritten on Windows, but it can be renamed out of the way
  if (existsSync(target)) {
    try {
      rmSync(target, { force: true })
    } catch {
      renameSync(target, `${target}.old-${Date.now()}`)
    }
  }
  copyFileSync(cmd[0]!, target)
  if (!WIN) chmodSync(target, 0o755)
  return [target]
}

export interface Installed {
  ok: boolean
  /** how it was set up, or why it couldn't be */
  how: string
}

/** Installs and starts the link as a user service. */
export function installService(): Installed {
  const cmd = settle(self())
  const args = [...cmd, 'link']
  if (process.platform === 'linux') {
    if (!run(['systemctl', '--user', 'show-environment']).ok) return background(args)
    mkdirSync(path.dirname(unit()), { recursive: true })
    writeFileSync(unit(), `[Unit]
Description=Tether phone link
After=network-online.target

[Service]
ExecStart=${args.map(sdq).join(' ')}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`)
    run(['systemctl', '--user', 'daemon-reload'])
    const r = run(['systemctl', '--user', 'enable', '--now', `${NAME}.service`])
    if (!r.ok) return { ok: false, how: r.out || 'systemctl refused' }
    // keeps it running while you're logged out (allowed for your own user on most systems)
    run(['loginctl', 'enable-linger', os.userInfo().username])
    return { ok: true, how: `a user service that starts again by itself after a restart (systemctl --user status ${NAME})` }
  }
  if (process.platform === 'darwin') {
    mkdirSync(path.dirname(plist()), { recursive: true })
    writeFileSync(plist(), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.tether.node-link</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(dir(), 'link.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(dir(), 'link.log'))}</string>
</dict></plist>
`)
    run(['launchctl', 'unload', plist()])
    const r = run(['launchctl', 'load', '-w', plist()])
    if (!r.ok) return { ok: false, how: r.out || 'launchctl refused' }
    return { ok: true, how: 'a login item that starts again by itself when you sign in' }
  }
  if (WIN) {
    // a logon task, started hidden through PowerShell so no console window stays open
    const q = (v: string) => `'${v.replace(/'/g, "''")}'`
    const argument = `-NoProfile -WindowStyle Hidden -Command "& ${args.map(q).join(' ')}"`
    const ps = `$ErrorActionPreference='Stop'
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${q(argument)}
$t = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName '${TASK}' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null
Start-ScheduledTask -TaskName '${TASK}'`
    const r = run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ps])
    if (!r.ok) return { ok: false, how: r.out.split('\n')[0] || 'Task Scheduler refused' }
    return { ok: true, how: `a task that starts again by itself when you sign in ("${TASK}" in Task Scheduler)` }
  }
  return { ok: false, how: `${process.platform} isn't supported for a background service` }
}

/**
 * No user services (a container, a minimal server): start it detached now, and from cron at boot
 * when cron is there. Our crontab line is marked so it can be found and removed again. Each start
 * writes its PID to ~/.tether-node/link.pid, so uninstall can stop that process and no other.
 */
const CRON_MARK = '# tether-node link'
function background(args: string[]): Installed {
  const log = path.join(dir(), 'link.log')
  mkdirSync(dir(), { recursive: true })
  // installing again replaces the copy started last time instead of adding another
  const before = stopBackground()
  if (!before.ok) return { ok: false, how: before.note! }
  const line = `nohup ${args.map(shq).join(' ')} >> ${shq(log)} 2>&1 & echo $! > ${shq(pidFile())}`
  const started = run(['sh', '-c', line]).ok
  if (!started) return { ok: false, how: "this system has no user services and the link couldn't start in the background" }
  if (!Bun.which('crontab')) return { ok: true, how: `a background process (no user services or cron here, so run \`tether-node pair\` again after a restart)` }
  const current = run(['crontab', '-l']).out
  const kept = current.split('\n').filter((l) => l && !l.includes(CRON_MARK) && !/^no crontab/i.test(l))
  const p = Bun.spawnSync(['crontab', '-'], { stdin: new TextEncoder().encode([...kept, `@reboot ${line} ${CRON_MARK}`, ''].join('\n')), stdout: 'pipe', stderr: 'pipe' })
  return p.exitCode === 0
    ? { ok: true, how: 'a background process that cron starts again after a restart' }
    : { ok: true, how: 'a background process (cron refused the restart entry, so run `tether-node pair` after a restart)' }
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** How uninstall looks at and stops a process (tests swap these out). */
export const proc = {
  cmdline(pid: number): string[] | undefined {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    } catch {
      return undefined
    }
  },
  signal(pid: number, sig: NodeJS.Signals) {
    process.kill(pid, sig)
  },
}

/** True while `pid` is a running `tether-node link` (a PID can be reused once it has exited). */
export function isLinkProcess(pid: number) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  const args = proc.cmdline(pid)
  return !!args && args.at(-1) === 'link' && args.some((a) => path.basename(a).startsWith(NAME))
}

/** Stops the background process recorded in link.pid, after checking it's still the link. */
function stopBackground(): { ok: boolean; note?: string } {
  let pid: number
  try {
    pid = Number(readFileSync(pidFile(), 'utf8').trim())
  } catch {
    return { ok: true }
  }
  const stopWith = (sig: NodeJS.Signals, ms: number) => {
    try {
      proc.signal(pid, sig)
    } catch {}
    for (let waited = 0; waited < ms && isLinkProcess(pid); waited += 100) Bun.sleepSync(100)
  }
  if (isLinkProcess(pid)) stopWith('SIGTERM', 3000)
  if (isLinkProcess(pid)) stopWith('SIGKILL', 1000)
  if (isLinkProcess(pid)) return { ok: false, note: `the background link (PID ${pid}) didn't stop` }
  rmSync(pidFile(), { force: true })
  return { ok: true }
}

/** Stops and removes the service (pairings and keys stay; `forget` unpairs phones). */
export function uninstallService(): Installed {
  if (process.platform === 'linux') {
    run(['systemctl', '--user', 'disable', '--now', `${NAME}.service`])
    rmSync(unit(), { force: true })
    run(['systemctl', '--user', 'daemon-reload'])
    const problems: string[] = []
    const stopped = stopBackground()
    if (!stopped.ok) problems.push(stopped.note!)
    if (Bun.which('crontab')) {
      const current = run(['crontab', '-l']).out
      if (current.includes(CRON_MARK)) {
        const kept = current.split('\n').filter((l) => l && !l.includes(CRON_MARK))
        const p = Bun.spawnSync(['crontab', '-'], { stdin: new TextEncoder().encode(kept.length ? `${kept.join('\n')}\n` : ''), stdout: 'pipe', stderr: 'pipe' })
        if (p.exitCode !== 0) problems.push("its restart entry couldn't be removed from your crontab (crontab -e)")
      }
    }
    if (problems.length) return { ok: false, how: problems.join('; ') }
    return { ok: true, how: 'the background service is removed' }
  }
  if (process.platform === 'darwin') {
    run(['launchctl', 'unload', '-w', plist()])
    rmSync(plist(), { force: true })
    return { ok: true, how: 'the login item is removed' }
  }
  if (WIN) {
    run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Stop-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false -ErrorAction SilentlyContinue`])
    return { ok: true, how: 'the logon task is removed' }
  }
  return { ok: false, how: 'nothing to remove' }
}

/** busybox-w32, the small sh Windows runs Tether's commands with (pinned, as the hub's installer). */
const BUSYBOX: Record<string, { file: string; sha256: string }> = {
  x64: { file: 'busybox-w64u-FRP-6075-g169694ebd.exe', sha256: '6e263d154d8548d1eb936f65d1d8312c80df31c45974e48d6335e4dcc0f4f34c' },
  arm64: { file: 'busybox-w64a-FRP-6075-g169694ebd.exe', sha256: 'e67f873d19d58c535cc9f0c4965ffd622e19b7bab87e3da89cb2185fb54464d7' },
}

/** On Windows, finds busybox (or fetches it once) and points TETHER_SH at it. */
export async function ensureShell() {
  if (!WIN || process.env.TETHER_SH) return
  const local = path.join(bin(), 'busybox.exe')
  const found = Bun.which('busybox') ?? (existsSync(local) ? local : undefined)
  if (found) return void (process.env.TETHER_SH = found)
  const pick = BUSYBOX[os.arch() === 'arm64' ? 'arm64' : 'x64']!
  console.log('downloading busybox-w32 (the shell Tether runs commands with)…')
  const res = await fetch(`https://frippery.org/files/busybox/${pick.file}`)
  if (!res.ok) throw new Error(`couldn't download busybox-w32: ${res.status}`)
  const data = new Uint8Array(await res.arrayBuffer())
  if (crypto.createHash('sha256').update(data).digest('hex') !== pick.sha256) throw new Error("busybox-w32 didn't match its pinned checksum")
  mkdirSync(bin(), { recursive: true })
  writeFileSync(`${local}.tmp`, data)
  renameSync(`${local}.tmp`, local)
  process.env.TETHER_SH = local
}

/** What the phone needs on this machine besides the link: tmux (psmux on Windows). */
export function missingMux(): string | undefined {
  if (WIN) {
    // the folders commands run with, not just this window's PATH (a PATH entry can be stale)
    const PATH = childPath()
    if (Bun.which('psmux', { PATH }) || Bun.which('tmux', { PATH })) return undefined
    const winget = Bun.which('winget')
    if (winget) {
      console.log('Installing psmux (tmux for Windows) with winget…')
      if (run([winget, 'install', 'psmux', '--silent', '--accept-source-agreements', '--accept-package-agreements']).ok) return undefined
    }
    return 'psmux (tmux for Windows) is missing. Install it with: winget install psmux'
  }
  if (Bun.which('tmux') || ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].some(existsSync)) return undefined
  if (process.platform === 'darwin') {
    return Bun.which('brew') || existsSync('/opt/homebrew/bin/brew')
      ? 'tmux is missing. Install it with: brew install tmux'
      : 'tmux is missing. Install Homebrew from https://brew.sh, then run: brew install tmux'
  }
  const pm = ['apt-get', 'dnf', 'pacman', 'zypper', 'apk'].find((p) => Bun.which(p))
  const cmd = pm === 'apt-get' ? 'sudo apt-get install -y tmux' : pm === 'dnf' ? 'sudo dnf install -y tmux' : pm === 'pacman' ? 'sudo pacman -S tmux' : pm === 'zypper' ? 'sudo zypper install -y tmux' : pm === 'apk' ? 'sudo apk add tmux' : undefined
  return `tmux is missing. ${cmd ? `Install it with: ${cmd}` : 'Install it with your package manager.'}`
}
