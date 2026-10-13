import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { detachUpdate, moveOldService, oldServices, proc, restartService } from './service.ts'

// How `inyon update` restarts each job, and how tether-node's services move to inyon's. Nothing runs: every command goes to a
// fake that records it, the process table is a fake, and home is a throwaway folder.
afterAll(() => mock.restore())

let home: string
let ran: string[][]
let spawned: { cmd: string[]; opts: any }[]
let processes: Map<number, string[]>
let signals: [number, string][]
const BIN = '/home/me/.inyon/bin/inyon'

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'inyon-restart-'))
  ran = []
  spawned = []
  processes = new Map()
  signals = []
  spyOn(os, 'homedir').mockReturnValue(home)
  spyOn(Bun, 'sleepSync').mockImplementation(() => {})
  spyOn(Bun, 'which').mockImplementation(((name: string) => (name === 'systemd-run' ? '/usr/bin/systemd-run' : null)) as any)
  spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[]) => {
    ran.push(cmd)
    return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') } as any
  }) as any)
  spyOn(Bun, 'spawn').mockImplementation(((cmd: string[], opts: any) => {
    spawned.push({ cmd, opts })
    return { unref() {} } as any
  }) as any)
  spyOn(proc, 'cmdline').mockImplementation((pid) => processes.get(pid))
  spyOn(proc, 'signal').mockImplementation((pid, sig) => {
    signals.push([pid, sig])
    processes.delete(pid)
  })
})

afterEach(() => {
  mock.restore()
  rmSync(home, { recursive: true, force: true })
})

const put = (rel: string, text = '') => {
  mkdirSync(path.dirname(path.join(home, rel)), { recursive: true })
  writeFileSync(path.join(home, rel), text)
}

const unit = (name: string, exec: string) => put(`.config/systemd/user/${name}.service`, `[Service]\nExecStart=${exec}\n`)

test("Linux: systemctl restarts the job's own unit, or tether-node's while it hasn't moved", () => {
  unit('inyon-link', `"${BIN}" "link"`)
  expect(restartService('link', [BIN], 'linux').ok).toBe(true)
  expect(ran).toEqual([['systemctl', '--user', 'restart', 'inyon-link.service']])

  // both of tether-node's installers called their unit tether-node: what it runs says which job
  ran = []
  unit('tether-node', '"/home/me/.tether-node/bin/tether-node" "link"')
  expect(restartService('node', [BIN], 'linux').ok).toBe(false)
  expect(ran).toEqual([])
  unit('tether-node', '/home/me/.bun/bin/bun /home/me/.tether-node/tether-node.ts')
  expect(restartService('node', [BIN], 'linux').ok).toBe(true)
  expect(ran).toEqual([['systemctl', '--user', 'restart', 'tether-node.service']])
})

test('macOS: launchd restarts the job under its own label, or the old one', () => {
  put('Library/LaunchAgents/dev.tether.node.plist')
  expect(restartService('node', [BIN], 'darwin').ok).toBe(true)
  expect(ran).toEqual([['launchctl', 'kickstart', '-k', `gui/${os.userInfo().uid}/dev.tether.node`]])
  ran = []
  put('Library/LaunchAgents/tech.abhashchakraborty.inyon.node.plist')
  restartService('node', [BIN], 'darwin')
  expect(ran).toEqual([['launchctl', 'kickstart', '-k', `gui/${os.userInfo().uid}/tech.abhashchakraborty.inyon.node`]])
  // the phone link isn't set up here
  ran = []
  expect(restartService('link', [BIN], 'darwin').ok).toBe(false)
  expect(ran).toEqual([])
})

test('Windows: the logon task is stopped and started, and the old copy stopped, never the updater itself', () => {
  const exe = 'C:\\Users\\me\\.tether-node\\tether-node.exe'
  expect(restartService('node', [exe], 'win32').ok).toBe(true)
  const ps = ran[0]!.at(-1)!
  expect(ran[0]!.slice(0, 1)).toEqual(['powershell.exe'])
  expect(ps).toContain(`$exe = 'C:\\Users\\me\\.tether-node\\tether-node.exe'`)
  expect(ps).toContain(`'Inyon node', 'Tether node' | ForEach-Object`)
  expect(ps).toContain(`Get-Process -Name 'inyon', 'inyon-engine', 'tether-node'`)
  expect(ps).toContain(`$_.Id -ne ${process.pid}`)
  expect(ps.indexOf('Stop-ScheduledTask')).toBeLessThan(ps.indexOf('Start-ScheduledTask'))
  // install.ps1's Startup-folder fallback has no task: start it the way that does
  expect(ps).toContain('Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden')
  ran = []
  restartService('link', ["C:\\Users\\o'brien\\.inyon\\bin\\inyon.exe"], 'win32')
  expect(ran[0]!.at(-1)).toContain(`'Inyon link', 'Tether link'`)
  expect(ran[0]!.at(-1)).toContain(`$exe = 'C:\\Users\\o''brien\\.inyon\\bin\\inyon.exe'`)
  expect(ran[0]!.at(-1)).toContain(`-ArgumentList 'link'`)
})

test('no service manager: the node named in node.json is stopped and the new one started with nohup', () => {
  put('.inyon/node/node.json', JSON.stringify({ pid: 777, version: '0.6.3' }))
  processes.set(777, ['/home/me/.bun/bin/bun', '/home/me/.tether-node/tether-node.ts'])
  expect(restartService('node', [BIN], 'linux').ok).toBe(true)
  expect(signals).toEqual([[777, 'SIGTERM']])
  const pid = path.join(home, '.inyon', 'node', 'node.pid')
  expect(ran.at(-1)).toEqual(['sh', '-c', `nohup '${BIN}' 'connect' >> '${home}/.inyon/node/node.log' 2>&1 < /dev/null & echo $! > '${pid}'`])
})

test('a pid in node.json that now belongs to another program is left alone', () => {
  put('.inyon/node/node.json', JSON.stringify({ pid: 777 }))
  processes.set(777, ['/usr/bin/vim'])
  expect(restartService('node', [BIN], 'linux').ok).toBe(false)
  expect(signals).toEqual([])
  expect(ran).toEqual([])
})

test('the app starts the update on its own: a transient unit on Linux with systemd', () => {
  expect(detachUpdate([BIN], 'linux').ok).toBe(true)
  expect(ran.at(-1)!.slice(0, 4)).toEqual(['systemd-run', '--user', '--collect', '--quiet'])
  expect(ran.at(-1)!.slice(-2)).toEqual([BIN, 'update'])
  expect(spawned).toEqual([])
})

test('without systemd the update runs detached, in a session of its own, logging to a file', () => {
  spyOn(Bun, 'which').mockImplementation((() => null) as any)
  expect(detachUpdate([BIN], 'linux').ok).toBe(true)
  expect(ran).toEqual([])
  expect(spawned[0]!.cmd).toEqual([BIN, 'update'])
  expect(spawned[0]!.opts.detached).toBe(true)
  expect(spawned[0]!.opts.stdin).toBe('ignore')
  expect(typeof spawned[0]!.opts.stdout).toBe('number')
})

test('on Windows the update becomes a one-off task, outside the task it was asked from', () => {
  expect(detachUpdate(['C:\\t\\inyon.exe'], 'win32').ok).toBe(true)
  const ps = ran[0]!.at(-1)!
  expect(ps).toContain(`New-ScheduledTaskAction -Execute 'C:\\t\\inyon.exe' -Argument '"update"'`)
  expect(ps).toContain(`Start-ScheduledTask -TaskName 'Inyon update'`)
})

test.skipIf(process.platform !== 'linux')("tether-node's systemd unit moves to inyon's: stopped first, removed once the new one runs", () => {
  unit('tether-node', '"/home/me/.tether-node/bin/tether-node" "link"')
  expect(oldServices('linux')).toEqual(['link'])
  const r = moveOldService('link', 'linux')
  expect(r.ok).toBe(true)
  const at = (cmd: string[]) => ran.findIndex((c) => c.join(' ') === cmd.join(' '))
  const stop = at(['systemctl', '--user', 'stop', 'tether-node.service'])
  const start = at(['systemctl', '--user', 'enable', '--now', 'inyon-link.service'])
  const disable = at(['systemctl', '--user', 'disable', 'tether-node.service'])
  expect(stop).toBeGreaterThan(-1)
  expect(start).toBeGreaterThan(stop)
  expect(disable).toBeGreaterThan(start)
  expect(readFileSync(path.join(home, '.config/systemd/user/inyon-link.service'), 'utf8')).toMatch(/^ExecStart=.* "link"$/m)
  expect(existsSync(path.join(home, '.config/systemd/user/tether-node.service'))).toBe(false)
  expect(oldServices('linux')).toEqual([])
})

test.skipIf(process.platform !== 'linux')("if inyon's own unit won't start, tether-node's is started again and kept", () => {
  unit('tether-node', '/home/me/.bun/bin/bun /home/me/.tether-node/tether-node.ts')
  spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[]) => {
    ran.push(cmd)
    const refused = cmd[1] === '--user' && cmd[2] === 'enable'
    return { exitCode: refused ? 1 : 0, stdout: Buffer.from(refused ? 'Failed to enable' : ''), stderr: Buffer.from('') } as any
  }) as any)
  expect(oldServices('linux')).toEqual(['node'])
  const r = moveOldService('node', 'linux')
  expect(r).toEqual({ ok: false, how: 'Failed to enable' })
  expect(ran.at(-1)).toEqual(['systemctl', '--user', 'start', 'tether-node.service'])
  expect(existsSync(path.join(home, '.config/systemd/user/tether-node.service'))).toBe(true)
})
