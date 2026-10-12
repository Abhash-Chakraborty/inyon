import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import zlib from 'node:zlib'
import { fillUpdateScript, WINDOWS_LAUNCHER } from './node-update.ts'

// The script the hub sends to update a Windows machine still on tether-node, from before the rename
// to Inyon. It's checked for the order of its steps, and also run under PowerShell where one is
// installed (pwsh, or PWSH=<path>), with the Windows-only cmdlets replaced by stubs, a throwaway
// home, and a local server standing in for the hub. Nothing touches a real service.

const NODE = path.resolve(import.meta.dir, '../../../node')
const PS1 = readFileSync(path.join(NODE, 'hub-update.ps1'), 'utf8')
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

const server = Bun.serve({
  port: 4791,
  hostname: '127.0.0.1',
  fetch: (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/node/tether-node.exe.gz' && u.searchParams.get('arch') === 'x64') return new Response(zlib.gzipSync('new exe'))
    return new Response('no', { status: 404 })
  },
})
afterAll(() => server.stop(true))

let root: string
let home: string
const log = () => (existsSync(path.join(root, 'calls')) ? readFileSync(path.join(root, 'calls'), 'utf8') : '')

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'inyon-hub-update-'))
  // a home with a space and a quote in it: everything must stay quoted
  home = path.join(root, "home dir/o'brien")
  mkdirSync(home, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('only a plain checksum, version and architecture go into the script', () => {
  const ok = { sha256: 'a'.repeat(64), version: '0.6.3', arch: 'x64' }
  expect(fillUpdateScript(PS1, ok)).toContain(`$Want = '${'a'.repeat(64)}'`)
  expect(fillUpdateScript(PS1, { ...ok, arch: 'arm64' })).toContain("$Arch = 'arm64'")
  expect(() => fillUpdateScript(PS1, { ...ok, version: "0.6.3'; rm -rf ~; '" })).toThrow('Bad version')
  expect(() => fillUpdateScript(PS1, { ...ok, sha256: 'A'.repeat(64) })).toThrow('Bad checksum')
  expect(() => fillUpdateScript(PS1, { ...ok, arch: 'x86' })).toThrow('Bad architecture')
  expect(fillUpdateScript(PS1, ok)).not.toContain('@@')
})

test('the Windows launcher writes the script and hands it to PowerShell to start as a task', () => {
  const l = WINDOWS_LAUNCHER
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
