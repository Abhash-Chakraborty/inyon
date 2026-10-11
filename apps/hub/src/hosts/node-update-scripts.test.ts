import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import zlib from 'node:zlib'
import { fillUpdateScript, updateLauncher } from './node-update.ts'

// The scripts the hub sends to update tether-node. The shell one runs for real, under a throwaway
// HOME, with systemctl, systemd-run, sleep and bun replaced by stubs that log what they're asked,
// and a local server standing in for the hub. Nothing touches a real service. The Windows script
// is checked for the order of its steps, and also run under PowerShell where one is installed
// (pwsh, or PWSH=<path>), with the Windows-only cmdlets replaced by stubs.

const NODE = path.resolve(import.meta.dir, '../../../node')
const SH = readFileSync(path.join(NODE, 'hub-update.sh'), 'utf8')
const PS1 = readFileSync(path.join(NODE, 'hub-update.ps1'), 'utf8')
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const REAL_SLEEP = Bun.which('sleep')!

let served = 'console.log("new tether-node")'
const server = Bun.serve({
  port: 4791,
  hostname: '127.0.0.1',
  fetch: (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/node/tether-node.ts') return new Response(served)
    if (u.pathname === '/node/tether-node.exe.gz' && u.searchParams.get('arch') === 'x64') return new Response(zlib.gzipSync('new exe'))
    return new Response('no', { status: 404 })
  },
})
afterAll(() => server.stop(true))

let root: string
let home: string
let stubs: string
const log = () => (existsSync(path.join(root, 'calls')) ? readFileSync(path.join(root, 'calls'), 'utf8') : '')
const nodeDir = () => path.join(home, '.tether-node')
const status = () => readFileSync(path.join(nodeDir(), 'update-status'), 'utf8').trim()
const installed = () => readFileSync(path.join(nodeDir(), 'tether-node.ts'), 'utf8')
const stub = (name: string, body: string) => {
  writeFileSync(path.join(stubs, name), `#!/bin/sh\necho "${name} $*" >> '${root}/calls'\n${body}\n`)
  chmodSync(path.join(stubs, name), 0o755)
}
/** what a started tether-node does: write node.json, then keep running */
const startsNode = (version: string) => `${REAL_SLEEP} 30 < /dev/null > /dev/null 2>&1 &\nprintf '{"pid":%s,"version":"${version}"}' $! > "$HOME/.tether-node/node.json"`

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'tether-hub-update-'))
  // a home with a space and a quote in it: everything must stay quoted
  home = path.join(root, "home dir/o'brien")
  stubs = path.join(root, 'stubs')
  mkdirSync(nodeDir(), { recursive: true })
  mkdirSync(stubs)
  writeFileSync(path.join(nodeDir(), 'tether-node.ts'), 'old tether-node')
  writeFileSync(path.join(nodeDir(), 'env'), 'TETHER_HUB=http://127.0.0.1:4791/\nTETHER_TOKEN=secret\n')
  served = 'console.log("new tether-node")'
  // never the real ones, whatever a test sets up
  stub('systemctl', 'exit 1')
  stub('systemd-run', 'exit 1')
  stub('launchctl', 'exit 1')
  stub('sleep', 'exit 0')
})
afterEach(() => {
  // stop the stand-in node processes this test started
  for (const f of ['node.json']) {
    try {
      process.kill(JSON.parse(readFileSync(path.join(nodeDir(), f), 'utf8')).pid)
    } catch {}
  }
  rmSync(root, { recursive: true, force: true })
})

// not spawnSync: the stand-in hub answers from this same process
const run = (script: string, env: Record<string, string> = {}) =>
  Bun.spawn(['/bin/sh', '-c', script], { env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, ...env }, stdout: 'ignore', stderr: 'ignore' }).exited
const filled = (version = '0.6.3', want = sha(served)) => fillUpdateScript(SH, { sha256: want, version, arch: 'x64' })

test('only a plain checksum, version and architecture go into a script', () => {
  const ok = { sha256: 'a'.repeat(64), version: '0.6.3', arch: 'x64' }
  expect(fillUpdateScript(SH, ok)).toContain(`WANT='${'a'.repeat(64)}'`)
  expect(fillUpdateScript(PS1, { ...ok, arch: 'arm64' })).toContain("$Arch = 'arm64'")
  expect(() => fillUpdateScript(SH, { ...ok, version: "0.6.3'; rm -rf ~; '" })).toThrow('Bad version')
  expect(() => fillUpdateScript(SH, { ...ok, sha256: 'A'.repeat(64) })).toThrow('Bad checksum')
  expect(() => fillUpdateScript(PS1, { ...ok, arch: 'x86' })).toThrow('Bad architecture')
  expect(fillUpdateScript(PS1, ok)).not.toContain('@@')
})

test("a download that doesn't match the checksum leaves everything as it was", async () => {
  stub('systemctl', 'exit 0')
  mkdirSync(path.join(home, '.config/systemd/user'), { recursive: true })
  writeFileSync(path.join(home, '.config/systemd/user/tether-node.service'), '')
  await run(filled('0.6.3', sha('what the hub meant to send')))
  expect(installed()).toBe('old tether-node')
  expect(status()).toBe("failed: the download didn't match the hub's checksum, so nothing was changed")
  expect(readdirSync(nodeDir()).sort()).toEqual(['env', 'tether-node.ts', 'update-status', 'update.log'])
  expect(log()).not.toContain('systemctl')
})

test('with a systemd unit: replaced, restarted, and done once the new version runs', async () => {
  mkdirSync(path.join(home, '.config/systemd/user'), { recursive: true })
  writeFileSync(path.join(home, '.config/systemd/user/tether-node.service'), '')
  stub('systemctl', startsNode('0.6.3'))
  await run(filled())
  expect(installed()).toBe(served)
  expect(log()).toContain('systemctl --user restart tether-node')
  expect(status()).toBe('done 0.6.3')
  // the old copy is gone once the new one runs
  expect(readdirSync(nodeDir()).filter((f) => f.includes('.old-'))).toEqual([])
})

test("a new version that doesn't stay up is swapped back out", async () => {
  mkdirSync(path.join(home, '.config/systemd/user'), { recursive: true })
  writeFileSync(path.join(home, '.config/systemd/user/tether-node.service'), '')
  // it starts and dies at once: node.json names a process that isn't there
  stub('systemctl', `printf '{"pid":%s,"version":"0.6.3"}' 4194000 > "$HOME/.tether-node/node.json"`)
  await run(filled())
  expect(installed()).toBe('old tether-node')
  expect(log().match(/systemctl --user restart tether-node/g)).toHaveLength(2)
  expect(status()).toBe("failed: the new version didn't start, so the previous one is running again")
})

test('without a service manager: stops the tether-node that ran it and starts the new one with nohup', async () => {
  // the running node, as `ps` shows it: a program whose name has tether-node in it
  writeFileSync(path.join(root, 'tether-node-running'), `while :; do ${REAL_SLEEP} 1; done`)
  const old = Bun.spawn(['/bin/sh', path.join(root, 'tether-node-running')], { stdout: 'ignore', stderr: 'ignore' })
  stub('bun', startsNode('0.6.3'))
  await run(filled(), { TETHER_NODE_PID: String(old.pid) })
  expect(installed()).toBe(served)
  expect(log()).toContain(`bun ${nodeDir()}/tether-node.ts`)
  expect(status()).toBe('done 0.6.3')
  await Promise.race([old.exited, Bun.sleep(3000)])
  expect(old.signalCode).toBe('SIGTERM')
})

test('a pid that no longer belongs to tether-node is not stopped', async () => {
  const other = Bun.spawn([REAL_SLEEP, '30'], { stdout: 'ignore', stderr: 'ignore' })
  stub('bun', startsNode('0.6.3'))
  await run(filled(), { TETHER_NODE_PID: String(other.pid) })
  expect(other.exitCode).toBeNull()
  other.kill()
})

test('the launcher returns at once and the update carries on detached', async () => {
  // the "update" here waits a moment, then leaves a mark
  const script = `${REAL_SLEEP} 1; echo done > "$HOME/mark"`
  const started = Date.now()
  const p = Bun.spawn(['/bin/sh', '-c', updateLauncher('linux')], {
    env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin` },
    stdin: new TextEncoder().encode(script),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // tether-node 0.3.0 waits for the output to close, not just for the shell: both must end now
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  expect(p.exitCode).toBe(0)
  expect(out).toBe('')
  expect(Date.now() - started).toBeLessThan(800)
  expect(readFileSync(path.join(nodeDir(), 'update.sh'), 'utf8')).toBe(script)
  expect(status()).toBe('running')
  expect(existsSync(path.join(home, 'mark'))).toBe(false)
  for (let i = 0; i < 40 && !existsSync(path.join(home, 'mark')); i++) await Bun.sleep(100)
  expect(existsSync(path.join(home, 'mark'))).toBe(true)
  // no systemd unit here, so no transient unit either
  expect(log()).not.toContain('systemd-run')
})

test('with a systemd unit the update runs as a transient unit, outside the one it restarts', () => {
  mkdirSync(path.join(home, '.config/systemd/user'), { recursive: true })
  writeFileSync(path.join(home, '.config/systemd/user/tether-node.service'), '')
  stub('systemd-run', 'exit 0')
  const r = Bun.spawnSync(['/bin/sh', '-c', updateLauncher('linux')], { env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }, stdin: new TextEncoder().encode('true') })
  expect(r.exitCode).toBe(0)
  expect(log()).toBe(`systemd-run --user --collect --quiet /bin/sh ${nodeDir()}/update.sh\n`)
})

test('the Windows launcher writes the script and hands it to PowerShell to start as a task', () => {
  const l = updateLauncher('win32')
  expect(l).toContain('cat > "$d/update.ps1"')
  expect(l).toContain(`printf 'running\\n' > "$d/update-status"`)
  expect(l).toContain('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$d/update.ps1" -Launch')
})

test('the Windows script: plain ASCII, launches as its own task, checks the download before touching the .exe', () => {
  // Windows PowerShell 5.1 reads a file without a BOM as the local code page
  expect(/^[\x00-\x7f]*$/.test(PS1)).toBe(true)
  const at = (s: string) => {
    const i = PS1.indexOf(s)
    expect(i).toBeGreaterThan(-1)
    return i
  }
  // -Launch only re-starts it as a one-off task, then ends
  const launch = at('if ($Launch) {')
  expect(at("Register-ScheduledTask -TaskName $UpdateTask")).toBeGreaterThan(launch)
  expect(at('exit 0')).toBeLessThan(at('function Get-Hub'))
  // download, then the checksum, and only then the swap and restart
  const download = at('Get-File "$hub/node/tether-node.exe.gz?arch=$Arch" $gz')
  const check = at('(Get-FileHash -Algorithm SHA256 $new).Hash.ToLower() -ne $Want')
  const swap = at('Move-Retry $Exe $old')
  expect(download).toBeLessThan(check)
  expect(check).toBeLessThan(swap)
  expect(at('Stop-Node\n  Start-Node')).toBeGreaterThan(swap)
  // a new copy that doesn't come up, or anything failing after the swap, brings the old one back,
  // and tether-node is left running
  const failed = at('} catch {\n  $msg')
  expect(failed).toBeGreaterThan(at('if (-not (Test-Started)) { throw'))
  expect(at('Move-Retry $old $Exe')).toBeGreaterThan(failed)
  expect(at('if (-not (Get-Node)) { try { Start-Node }')).toBeGreaterThan(at('Move-Retry $old $Exe'))
  // the task removes itself, however it ended
  expect(at('Unregister-ScheduledTask -TaskName $UpdateTask')).toBeGreaterThan(at('} finally {'))
  // the hub address comes from install.ps1's .env; nothing from the hub is put into a command
  expect(PS1).toContain("Get-Content (Join-Path $Dir '.env')")
})

// Windows-only cmdlets as stubs that log what they're asked. Starting tether-node writes node.json
// for the new copy when NEW_STARTS=1, and throws when FAIL_START=1.
const PS_STUBS = `
function Node-Started {
  $d = Join-Path $env:USERPROFILE '.tether-node'
  $isNew = (Get-Content (Join-Path $d 'tether-node.exe') -Raw) -match 'new'
  if ($isNew -and $env:FAIL_START -eq '1') { throw 'task start blocked' }
  if ($isNew -and $env:NEW_STARTS -eq '1') { Set-Content (Join-Path $d 'node.json') ('{"pid":' + $PID + ',"version":"0.6.3"}') }
}
function Get-ScheduledTask { param($TaskName, $ErrorAction) if ($TaskName -eq 'Tether node') { 'task' } }
function Stop-ScheduledTask { param($TaskName, $ErrorAction) Add-Content $env:CALLS "stop $TaskName" }
function Start-ScheduledTask { param($TaskName) Add-Content $env:CALLS "start $TaskName"; if ($TaskName -eq 'Tether node') { Node-Started } }
function Start-Process { param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle) Add-Content $env:CALLS "start-process $FilePath" }
function Register-ScheduledTask { param($TaskName, $Action, $Principal, $Settings, [switch]$Force) Add-Content $env:CALLS "register $TaskName $($Action.Argument)" }
function New-ScheduledTaskAction { param($Execute, $Argument) [pscustomobject]@{ Execute = $Execute; Argument = $Argument } }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) 'principal' }
function New-ScheduledTaskSettingsSet { param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, $ExecutionTimeLimit) 'settings' }
function Unregister-ScheduledTask { param($TaskName, $Confirm, $ErrorAction) Add-Content $env:CALLS "unregister $TaskName" }
function Get-Process { param($Name, $Id, $ErrorAction) if ($Id -and $Id -eq $PID) { [pscustomobject]@{ Id = $PID } } }
function Stop-Process { param([switch]$Force, $ErrorAction) }
function Start-Sleep { param($Seconds, $Milliseconds) }
`
const PWSH = process.env.PWSH || Bun.which('pwsh')

/** Runs the filled-in Windows script under a throwaway USERPROFILE whose tether-node.exe is "old exe". */
const runPs1 = async (o: { want?: string; env?: Record<string, string>; launch?: boolean } = {}) => {
  const profile = path.join(home, 'profile')
  const dir = path.join(profile, '.tether-node')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'tether-node.exe'), 'old exe')
  writeFileSync(path.join(dir, '.env'), 'TETHER_HUB=http://127.0.0.1:4791/\r\nTETHER_TOKEN=secret\r\n')
  writeFileSync(path.join(dir, 'update-status'), 'running\n')
  writeFileSync(path.join(root, 'stubs.ps1'), PS_STUBS)
  const script = path.join(dir, 'update.ps1')
  writeFileSync(script, fillUpdateScript(PS1, { sha256: o.want ?? sha('new exe'), version: '0.6.3', arch: 'x64' }))
  const cmd = `. '${path.join(root, 'stubs.ps1').replaceAll("'", "''")}'; & '${script.replaceAll("'", "''")}'${o.launch ? ' -Launch' : ''}`
  await Bun.spawn([PWSH!, '-NoProfile', '-NonInteractive', '-Command', cmd], {
    env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: profile, CALLS: path.join(root, 'calls'), ...o.env },
    stdout: 'ignore',
    stderr: 'ignore',
  }).exited
  const read = (f: string) => readFileSync(path.join(dir, f), 'utf8').trim()
  return { exe: read('tether-node.exe'), status: read('update-status'), files: readdirSync(dir).sort(), calls: log().trim().split('\n') }
}

test.skipIf(!PWSH)('Windows script, under PowerShell: a mismatched download changes nothing', async () => {
  const r = await runPs1({ want: sha('what the hub meant to send'), env: { NEW_STARTS: '1' } })
  expect(r.exe).toBe('old exe')
  expect(r.status).toBe("failed: The download didn't match the hub's checksum, so nothing was changed")
  expect(r.files).toEqual(['.env', 'tether-node.exe', 'update-status', 'update.log', 'update.ps1'])
  expect(r.calls).not.toContain('stop Tether node')
}, 30_000)

test.skipIf(!PWSH)('Windows script, under PowerShell: replaced, restarted, and done once the new version runs', async () => {
  const r = await runPs1({ env: { NEW_STARTS: '1' } })
  expect(r.exe).toBe('new exe')
  expect(r.status).toBe('done 0.6.3')
  expect(r.files.filter((f) => f.includes('.old-') || f.endsWith('.new') || f.endsWith('.gz'))).toEqual([])
  expect(r.calls).toEqual(['stop Tether node', 'start Tether node', 'unregister Tether update'])
}, 30_000)

test.skipIf(!PWSH)("Windows script, under PowerShell: a new version that doesn't start, or a restart that throws, puts the old one back", async () => {
  for (const env of [{}, { NEW_STARTS: '1', FAIL_START: '1' }] as Record<string, string>[]) {
    const r = await runPs1({ env })
    expect(r.exe).toBe('old exe')
    expect(r.status).toMatch(/^failed: (The new version didn't start, so the previous one is running again|task start blocked)$/)
    expect(r.files.filter((f) => f.includes('.old-'))).toEqual([])
    expect(r.calls.at(-2)).toBe('start Tether node')
    rmSync(path.join(root, 'calls'), { force: true })
  }
}, 60_000)

test.skipIf(!PWSH)('Windows script, under PowerShell: -Launch only starts itself as a one-off task', async () => {
  const r = await runPs1({ launch: true })
  expect(r.exe).toBe('old exe')
  expect(r.status).toBe('running')
  expect(r.calls).toHaveLength(2)
  expect(r.calls[0]).toMatch(/^register Tether update -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ".*update\.ps1"$/)
  expect(r.calls[1]).toBe('start Tether update')
}, 30_000)
