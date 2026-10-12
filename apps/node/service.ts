import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { APP_ID } from '@inyon/protocol'
import { childPath, selfCommand, WIN } from './ops.ts'
import { binDir, installedBinary, NAME, nodeDir } from './paths.ts'

/**
 * Keeps inyon running without a terminal window: a user service that starts at login and comes
 * back if it stops (systemd on Linux, launchd on macOS, a logon task on Windows). No admin rights,
 * nothing outside your home folder. The program copies itself into ~/.inyon/bin first, so the
 * download can be deleted.
 *
 * One program does three jobs, each its own service:
 * - link: the phone link (`inyon setup` or `inyon pair`)
 * - node: an outbound connection to an Inyon hub (the hub's "Add a machine" command)
 * - hub: the hub itself (`get.sh --hub`, Linux and macOS)
 */
export type Role = 'link' | 'node' | 'hub'
export const ROLES: Role[] = ['link', 'node', 'hub']

const SPEC: Record<Role, { unit: string; label: string; task?: string; args: string[]; what: string }> = {
  link: { unit: 'inyon-link', label: `${APP_ID}.link`, task: 'Inyon link', args: ['link'], what: 'Inyon phone link' },
  node: { unit: 'inyon-node', label: `${APP_ID}.node`, task: 'Inyon node', args: ['connect'], what: 'Inyon node (outbound connection to your Inyon hub)' },
  hub: { unit: 'inyon-hub', label: `${APP_ID}.hub`, args: ['hub'], what: 'Inyon hub' },
}
const UPDATE_TASK = 'Inyon update'

/**
 * How each job was set up when this program was tether-node, before the rename to Inyon. Both of
 * its installers named their systemd unit tether-node.service; what the unit runs says which job.
 */
const OLD: Record<Role, { unit?: string; label?: string; task?: string; shortcut?: string; cron?: string }> = {
  link: { unit: 'tether-node', label: 'dev.tether.node-link', task: 'Tether link', cron: '# tether-node link' },
  node: { unit: 'tether-node', label: 'dev.tether.node', task: 'Tether node', shortcut: 'Tether node.lnk' },
  hub: { unit: 'tether-hub' },
}

const unitFile = (name: string) => path.join(os.homedir(), '.config', 'systemd', 'user', `${name}.service`)
const plistFile = (label: string) => path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
/** Where a job writes its log when nothing else keeps it (launchd, nohup). */
export const logFile = (role: Role) => path.join(nodeDir(), `${role}.log`)
/** The PID of a job started in the background where there are no user services. */
const pidFile = (role: Role) => path.join(nodeDir(), `${role}.pid`)
const cronMark = (role: Role) => `# inyon ${role}`

/** The command that runs this program: the compiled binary itself, or Bun with the script. */
export const self = selfCommand

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
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const psq = (v: string) => `'${v.replace(/'/g, "''")}'`
const ps = (script: string) => run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script])

/** Copies a compiled binary into ~/.inyon/bin (a script run with Bun stays where it is). */
export function settle(cmd: string[]): string[] {
  if (cmd.length > 1) return cmd
  const target = installedBinary()
  if (path.resolve(cmd[0]!) === path.resolve(target)) return cmd
  mkdirSync(binDir(), { recursive: true })
  // a running copy can't be overwritten on Windows, but it can be renamed out of the way
  if (existsSync(target)) {
    try {
      rmSync(target, { force: true })
    } catch {
      renameSync(target, `${target}.old-${Date.now()}`)
    }
  }
  copyFileSync(cmd[0]!, `${target}.download`)
  if (!WIN) chmodSync(`${target}.download`, 0o755)
  renameSync(`${target}.download`, target)
  return [target]
}

export interface Installed {
  ok: boolean
  /** how it was set up, or why it couldn't be */
  how: string
}
const ok = (how: string): Installed => ({ ok: true, how })

/** Whether `role` is set up to run in the background here, under its own name or the old one. */
export function hasService(role: Role, platform: NodeJS.Platform = process.platform) {
  const s = SPEC[role]
  const old = OLD[role]
  if (platform === 'linux') return existsSync(unitFile(s.unit)) || !!oldUnitFor(role) || existsSync(pidFile(role))
  if (platform === 'darwin') return existsSync(plistFile(s.label)) || (!!old.label && existsSync(plistFile(old.label)))
  if (platform === 'win32' && s.task) {
    const names = [s.task, old.task].filter(Boolean).map((t) => psq(t!)).join(', ')
    const startup = `(Test-Path (Join-Path ([Environment]::GetFolderPath('Startup')) ${psq(`${s.task}.lnk`)}))`
    return ps(`if ((${names} | ForEach-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue }) -or ${startup}) { exit 0 } else { exit 1 }`).ok
  }
  return false
}

/** Installs and starts `role` as a user service; `restart` replaces a copy that's already running. */
export function installService(role: Role, restart = false): Installed {
  const s = SPEC[role]
  const cmd = settle(self())
  const args = [...cmd, ...s.args]
  if (process.platform === 'linux') {
    if (!run(['systemctl', '--user', 'show-environment']).ok) return background(role, args)
    mkdirSync(path.dirname(unitFile(s.unit)), { recursive: true })
    writeFileSync(unitFile(s.unit), `[Unit]
Description=${s.what}
After=network-online.target

[Service]
ExecStart=${args.map(sdq).join(' ')}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`)
    run(['systemctl', '--user', 'daemon-reload'])
    const r = run(['systemctl', '--user', 'enable', '--now', `${s.unit}.service`])
    if (!r.ok) return { ok: false, how: r.out || 'systemctl refused' }
    // enable --now leaves a running unit alone
    if (restart) run(['systemctl', '--user', 'restart', `${s.unit}.service`])
    // keeps it running while you're logged out (allowed for your own user on most systems)
    run(['loginctl', 'enable-linger', os.userInfo().username])
    return ok(`a user service that starts again by itself after a restart (systemctl --user status ${s.unit})`)
  }
  if (process.platform === 'darwin') {
    const file = plistFile(s.label)
    mkdirSync(path.dirname(file), { recursive: true })
    mkdirSync(nodeDir(), { recursive: true })
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${s.label}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile(role))}</string>
  <key>StandardErrorPath</key><string>${xml(logFile(role))}</string>
</dict></plist>
`)
    run(['launchctl', 'unload', file])
    const r = run(['launchctl', 'load', '-w', file])
    if (!r.ok) return { ok: false, how: r.out || 'launchctl refused' }
    return ok('a login item that starts again by itself when you sign in')
  }
  if (WIN && s.task) {
    // a logon task, started hidden through PowerShell so no console window shows. Start-Process
    // waits for it either way: a hub builds its copies without a console (see build.ts)
    const [exe, ...rest] = args
    const argument = `-NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath ${psq(exe!)} -ArgumentList ${rest.map(psq).join(', ')} -WindowStyle Hidden -Wait"`
    const shortcut = `(Join-Path ([Environment]::GetFolderPath('Startup')) ${psq(`${s.task}.lnk`)})`
    const r = ps(`$ErrorActionPreference='Stop'
${restart ? `Stop-ScheduledTask -TaskName ${psq(s.task)} -ErrorAction SilentlyContinue
${stopCopies(role)}
` : ''}try {
  $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psq(argument)}
  $t = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"
  $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  $p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName ${psq(s.task)} -Action $a -Trigger $t -Settings $s -Principal $p -Description ${psq(s.what)} -Force | Out-Null
  Start-ScheduledTask -TaskName ${psq(s.task)}
  'task'
} catch {
  # tasks blocked by policy: a shortcut in the Startup folder, and started now
  $l = (New-Object -ComObject WScript.Shell).CreateShortcut(${shortcut})
  $l.TargetPath = 'powershell.exe'
  $l.Arguments = ${psq(argument)}
  $l.WindowStyle = 7
  $l.Save()
  Start-Process -FilePath ${psq(exe!)} -ArgumentList ${rest.map(psq).join(', ')} -WindowStyle Hidden
  'startup'
}`)
    if (!r.ok) return { ok: false, how: r.out.split('\n')[0] || 'Task Scheduler refused' }
    return ok(r.out.trim().endsWith('startup') ? 'a program that starts when you sign in (Task Scheduler is blocked here, so from the Startup folder)' : `a task that starts again by itself when you sign in ("${s.task}" in Task Scheduler)`)
  }
  if (WIN) return { ok: false, how: 'the hub runs on Linux and macOS (on Windows, use WSL)' }
  return { ok: false, how: `${process.platform} isn't supported for a background service` }
}

/**
 * PowerShell that stops the other copies of this program doing `role`'s job (every job when none
 * is given), under either program name and renamed aside by an update or not. Never this process.
 * tether-node's installers started the hub connection with no arguments.
 */
function stopCopies(role?: Role) {
  const line = '(Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine'
  const job = role === 'node' ? ` -and ${line} -notmatch '\\s"?(link|hub|migrate|update)"?(\\s|$)'` : role ? ` -and ${line} -match '\\s"?${SPEC[role].args[0]}"?\\s*$'` : ''
  return `Get-Process -Name '${NAME}', 'tether-node' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne ${process.pid}${job} } | Stop-Process -Force -ErrorAction SilentlyContinue`
}

/**
 * No user services (a container, a minimal server): start it detached now, and from cron at boot
 * when cron is there. Our crontab line is marked so it can be found and removed again. Each start
 * writes its PID to ~/.inyon/node/<role>.pid, so uninstall can stop that process and no other.
 */
function background(role: Role, args: string[]): Installed {
  mkdirSync(nodeDir(), { recursive: true })
  // installing again replaces the copy started last time instead of adding another
  const before = stopBackground(role)
  if (!before.ok) return { ok: false, how: before.note! }
  const line = `nohup ${args.map(shq).join(' ')} >> ${shq(logFile(role))} 2>&1 < /dev/null & echo $! > ${shq(pidFile(role))}`
  if (!run(['sh', '-c', line]).ok) return { ok: false, how: "this system has no user services and inyon couldn't start in the background" }
  const again = role === 'hub' ? '`inyon hub install`' : role === 'link' ? '`inyon pair`' : '`inyon install node`'
  if (!Bun.which('crontab')) return ok(`a background process (no user services or cron here, so run ${again} again after a restart)`)
  const current = run(['crontab', '-l']).out
  const kept = current.split('\n').filter((l) => l && !l.includes(cronMark(role)) && !/^no crontab/i.test(l))
  const p = Bun.spawnSync(['crontab', '-'], { stdin: new TextEncoder().encode([...kept, `@reboot ${line} ${cronMark(role)}`, ''].join('\n')), stdout: 'pipe', stderr: 'pipe' })
  return p.exitCode === 0 ? ok('a background process that cron starts again after a restart') : ok(`a background process (cron refused the restart entry, so run ${again} again after a restart)`)
}

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

/** True while `pid` runs this program as `role` (a PID can be reused once it has exited). */
export function isRoleProcess(pid: number, role: Role) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  const args = proc.cmdline(pid)
  if (!args?.some((a) => /^(inyon|tether-node)/.test(path.basename(a)))) return false
  const last = args.at(-1)
  // tether-node's installers started the hub connection with no arguments
  if (role === 'node') return last === 'connect' || !['link', 'hub', 'migrate', 'update'].includes(last!)
  return last === SPEC[role].args.at(-1)
}
export const isLinkProcess = (pid: number) => isRoleProcess(pid, 'link')

function stopPid(pid: number, role: Role): { ok: boolean; note?: string } {
  const stopWith = (sig: NodeJS.Signals, ms: number) => {
    try {
      proc.signal(pid, sig)
    } catch {}
    for (let waited = 0; waited < ms && isRoleProcess(pid, role); waited += 100) Bun.sleepSync(100)
  }
  if (isRoleProcess(pid, role)) stopWith('SIGTERM', 3000)
  if (isRoleProcess(pid, role)) stopWith('SIGKILL', 1000)
  if (isRoleProcess(pid, role)) return { ok: false, note: `the background ${role} (PID ${pid}) didn't stop` }
  return { ok: true }
}

/** Stops the background process recorded for `role`, after checking it's still that job. */
function stopBackground(role: Role): { ok: boolean; note?: string } {
  let pid: number
  try {
    pid = Number(readFileSync(pidFile(role), 'utf8').trim())
  } catch {
    return { ok: true }
  }
  const r = stopPid(pid, role)
  if (r.ok) rmSync(pidFile(role), { force: true })
  return r
}

/** Removes the crontab lines carrying `mark`; says why when crontab refuses. */
function dropCron(mark: string): string | undefined {
  if (!Bun.which('crontab')) return
  const current = run(['crontab', '-l']).out
  if (!current.includes(mark)) return
  const kept = current.split('\n').filter((l) => l && !l.includes(mark) && !/^no crontab/i.test(l))
  const p = Bun.spawnSync(['crontab', '-'], { stdin: new TextEncoder().encode(kept.length ? `${kept.join('\n')}\n` : ''), stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) return "its restart entry couldn't be removed from your crontab (crontab -e)"
}

/** Stops and removes `role`'s service (pairings and keys stay; `inyon forget` unpairs phones). */
export function uninstallService(role: Role): Installed {
  const s = SPEC[role]
  if (process.platform === 'linux') {
    run(['systemctl', '--user', 'disable', '--now', `${s.unit}.service`])
    rmSync(unitFile(s.unit), { force: true })
    run(['systemctl', '--user', 'daemon-reload'])
    const problems: string[] = []
    const stopped = stopBackground(role)
    if (!stopped.ok) problems.push(stopped.note!)
    const cron = dropCron(cronMark(role))
    if (cron) problems.push(cron)
    if (problems.length) return { ok: false, how: problems.join('; ') }
    return ok('the background service is removed')
  }
  if (process.platform === 'darwin') {
    run(['launchctl', 'unload', '-w', plistFile(s.label)])
    rmSync(plistFile(s.label), { force: true })
    return ok('the login item is removed')
  }
  if (WIN && s.task) {
    ps(`Stop-ScheduledTask -TaskName ${psq(s.task)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${psq(s.task)} -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path ([Environment]::GetFolderPath('Startup')) ${psq(`${s.task}.lnk`)})
${stopCopies(role)}`)
    return ok('the logon task is removed')
  }
  return { ok: false, how: 'nothing to remove' }
}

/**
 * Restarts `role`'s service so a new file runs. `cmd` is how the installed program runs (the
 * binary, or Bun and the script). A job still set up under its name from before the rename to
 * Inyon is restarted under that name.
 */
export function restartService(role: Role, cmd: string[], platform: NodeJS.Platform = process.platform): Installed {
  const s = SPEC[role]
  const old = OLD[role]
  if (platform === 'linux') {
    for (const unit of [s.unit, oldUnitFor(role)]) {
      if (!unit || !existsSync(unitFile(unit))) continue
      const r = run(['systemctl', '--user', 'restart', `${unit}.service`])
      return r.ok ? ok(`systemctl --user restart ${unit}`) : { ok: false, how: r.out || 'systemctl refused' }
    }
  }
  if (platform === 'darwin') {
    for (const label of [s.label, old.label]) {
      if (!label || !existsSync(plistFile(label))) continue
      if (run(['launchctl', 'kickstart', '-k', `gui/${os.userInfo().uid}/${label}`]).ok) return ok(`launchctl kickstart ${label}`)
      run(['launchctl', 'unload', plistFile(label)])
      const r = run(['launchctl', 'load', '-w', plistFile(label)])
      return r.ok ? ok(`launchctl load ${label}`) : { ok: false, how: r.out || 'launchctl refused' }
    }
  }
  if (platform === 'win32' && s.task) {
    // a running copy of the old program (renamed aside or not) is stopped, never this process.
    // Started without a task (install.ps1's Startup shortcut), it's started the same way.
    const exe = cmd[0]!
    const tasks = [s.task, old.task].filter(Boolean).map((t) => psq(t!)).join(', ')
    const start = role === 'node' && path.win32.basename(exe).startsWith('tether-node')
      ? 'Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden'
      : `Start-Process -FilePath $exe -ArgumentList ${s.args.map(psq).join(', ')} -WindowStyle Hidden`
    const r = ps(`$ErrorActionPreference='Stop'
$exe = ${psq(exe)}
$t = ${tasks} | ForEach-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if ($t) { Stop-ScheduledTask -TaskName $t.TaskName -ErrorAction SilentlyContinue }
${stopCopies(role)}
Start-Sleep -Milliseconds 500
if ($t) { Start-ScheduledTask -TaskName $t.TaskName } else { ${start} }`)
    return r.ok ? ok('restarted its logon task') : { ok: false, how: r.out.split('\n')[0] || 'Task Scheduler refused' }
  }
  // no service manager: a process started in the background (nohup), recorded by its pid
  if (existsSync(pidFile(role))) return background(role, [...cmd, ...s.args])
  if (role === 'node') return restartNodeProcess(cmd)
  return { ok: false, how: 'no background service or process found' }
}

/** install.sh's fallback before the rename: the node started with nohup, recorded in node.json. */
function restartNodeProcess(cmd: string[]): Installed {
  let pid: number | undefined
  try {
    pid = JSON.parse(readFileSync(path.join(nodeDir(), 'node.json'), 'utf8')).pid
  } catch {}
  if (!pid || !isRoleProcess(pid, 'node')) return { ok: false, how: 'no background service or process found' }
  const stopped = stopPid(pid, 'node')
  if (!stopped.ok) return { ok: false, how: stopped.note! }
  return background('node', [...cmd, ...SPEC.node.args])
}

/**
 * The systemd unit tether-node made for `role`, if this machine still has it. Both of its
 * installers named it tether-node.service; the phone link's runs `… link`.
 */
function oldUnitFor(role: Role): string | undefined {
  const unit = OLD[role].unit
  if (!unit) return
  let text: string
  try {
    text = readFileSync(unitFile(unit), 'utf8')
  } catch {
    return
  }
  if (role === 'hub') return unit
  const exec = text.match(/^ExecStart=(.*)$/m)?.[1]?.trim() ?? ''
  return /(^|\s)"?link"?$/.test(exec) === (role === 'link') ? unit : undefined
}

/**
 * The jobs still set up under their names from before the rename to Inyon. A hub installed with
 * git clone keeps its unit (its own update restarts either name), so it isn't listed.
 */
export function oldServices(platform: NodeJS.Platform = process.platform): Role[] {
  const found: Role[] = []
  for (const role of ['link', 'node'] as const) {
    const old = OLD[role]
    if (platform === 'linux') {
      if (oldUnitFor(role) || (old.cron && Bun.which('crontab') && run(['crontab', '-l']).out.includes(old.cron))) found.push(role)
    } else if (platform === 'darwin') {
      if (old.label && existsSync(plistFile(old.label))) found.push(role)
    } else if (platform === 'win32' && old.task) {
      const startup = old.shortcut ? `(Test-Path (Join-Path ([Environment]::GetFolderPath('Startup')) ${psq(old.shortcut)}))` : '$false'
      if (ps(`if ((Get-ScheduledTask -TaskName ${psq(old.task)} -ErrorAction SilentlyContinue) -or ${startup}) { exit 0 } else { exit 1 }`).ok) found.push(role)
    }
  }
  return found
}

/**
 * Moves `role` from the service tether-node set up to inyon's own. The old one is stopped first, so
 * two copies never run at once, then the new one is set up and started, and only then is the old
 * one removed. If the new one can't be set up, the old one is started again. Run from a process of
 * its own (see detach): stopping the old service ends everything it started.
 */
export function moveOldService(role: Role, platform: NodeJS.Platform = process.platform): Installed {
  const old = OLD[role]
  if (platform === 'linux') {
    const unit = oldUnitFor(role)
    if (unit) run(['systemctl', '--user', 'stop', `${unit}.service`])
    // the nohup fallback: the old copy recorded its PID in link.pid or node.json
    if (!unit) stopOldBackground(role)
    const r = installService(role, true)
    if (!r.ok) {
      if (unit) run(['systemctl', '--user', 'start', `${unit}.service`])
      return r
    }
    if (unit) {
      run(['systemctl', '--user', 'disable', `${unit}.service`])
      rmSync(unitFile(unit), { force: true })
      run(['systemctl', '--user', 'daemon-reload'])
    }
    if (old.cron) dropCron(old.cron)
    return r
  }
  if (platform === 'darwin' && old.label) {
    const file = plistFile(old.label)
    run(['launchctl', 'unload', '-w', file])
    const r = installService(role, true)
    if (!r.ok) {
      run(['launchctl', 'load', '-w', file])
      return r
    }
    rmSync(file, { force: true })
    return r
  }
  if (platform === 'win32' && old.task) {
    const shortcut = old.shortcut ? `(Join-Path ([Environment]::GetFolderPath('Startup')) ${psq(old.shortcut)})` : undefined
    ps(`Stop-ScheduledTask -TaskName ${psq(old.task)} -ErrorAction SilentlyContinue
${stopCopies(role)}`)
    const r = installService(role, true)
    if (!r.ok) {
      ps(`Start-ScheduledTask -TaskName ${psq(old.task)} -ErrorAction SilentlyContinue`)
      return r
    }
    ps(`Unregister-ScheduledTask -TaskName ${psq(old.task)} -Confirm:$false -ErrorAction SilentlyContinue
${shortcut ? `Remove-Item -Force -ErrorAction SilentlyContinue ${shortcut}` : ''}`)
    return r
  }
  return { ok: false, how: 'nothing to move' }
}

/** The old copy started with nohup where there were no user services. */
function stopOldBackground(role: Role) {
  const file = role === 'link' ? 'link.pid' : 'node.json'
  let pid: number | undefined
  try {
    const text = readFileSync(path.join(nodeDir(), file), 'utf8')
    pid = role === 'link' ? Number(text.trim()) : JSON.parse(text).pid
  } catch {
    return
  }
  if (pid && pid !== process.pid) stopPid(pid, role)
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

/**
 * Runs `args` (this program and a command) on its own: restarting a service ends everything the
 * service started, the command that asked included. On Linux it becomes a transient systemd unit,
 * on Windows a one-off task, elsewhere a process in a session of its own.
 */
export function detach(args: string[], platform: NodeJS.Platform = process.platform): Installed {
  if (platform === 'linux' && Bun.which('systemd-run') && run(['systemctl', '--user', 'show-environment']).ok) {
    const env = ['INYON_DOWNLOAD', 'INYON_DATA_DIR'].flatMap((k) => (process.env[k] ? [`--setenv=${k}=${process.env[k]}`] : []))
    if (run(['systemd-run', '--user', '--collect', '--quiet', ...env, ...args]).ok) return ok('a transient systemd unit')
  }
  if (platform === 'win32') {
    const [exe, ...rest] = args
    const r = ps(`$ErrorActionPreference='Stop'
$a = New-ScheduledTaskAction -Execute ${psq(exe!)} -Argument ${psq(rest.map((a) => `"${a}"`).join(' '))}
$p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName '${UPDATE_TASK}' -Action $a -Principal $p -Settings $s -Force | Out-Null
Start-ScheduledTask -TaskName '${UPDATE_TASK}'`)
    if (r.ok) return ok('a one-off task')
  }
  try {
    mkdirSync(nodeDir(), { recursive: true })
    const log = openSync(path.join(nodeDir(), 'update.log'), 'a')
    Bun.spawn(args, { stdin: 'ignore', stdout: log, stderr: log, detached: true, windowsHide: true } as any).unref()
    closeSync(log)
    return ok('a background process')
  } catch (err) {
    return { ok: false, how: (err as Error).message }
  }
}

/** `inyon update`, started on its own (the app asks for it from inside the service it restarts). */
export const detachUpdate = (cmd: string[], platform: NodeJS.Platform = process.platform) => detach([...cmd, 'update'], platform)

/** The one-off task removes itself when it's done (Windows only). */
export function forgetUpdateTask() {
  if (!WIN) return
  ps(`Unregister-ScheduledTask -TaskName '${UPDATE_TASK}' -Confirm:$false -ErrorAction SilentlyContinue`)
}
