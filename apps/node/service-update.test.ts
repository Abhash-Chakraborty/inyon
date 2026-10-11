import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { detachUpdate, proc, restartService } from './service.ts'

// How `tether-node update` restarts each kind of install. Nothing runs: every command goes to a
// fake that records it, the process table is a fake, and home is a throwaway folder.
afterAll(() => mock.restore())

let home: string
let ran: string[][]
let spawned: { cmd: string[]; opts: any }[]
let processes: Map<number, string[]>
let signals: [number, string][]
const BIN = '/home/me/.tether-node/bin/tether-node'

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'tether-node-restart-'))
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

test('Linux with a user unit: systemctl restarts it', () => {
  put('.config/systemd/user/tether-node.service')
  expect(restartService('link', [BIN], 'linux').ok).toBe(true)
  expect(ran).toEqual([['systemctl', '--user', 'restart', 'tether-node.service']])
})

test('macOS: launchd restarts the job of the right install', () => {
  put('Library/LaunchAgents/dev.tether.node.plist')
  expect(restartService('hub', ['/opt/bun', '/x/tether-node.ts'], 'darwin').ok).toBe(true)
  expect(ran).toEqual([['launchctl', 'kickstart', '-k', `gui/${os.userInfo().uid}/dev.tether.node`]])
  // the phone link's job has a different label, and isn't set up here
  ran = []
  expect(restartService('link', [BIN], 'darwin').ok).toBe(false)
  expect(ran).toEqual([])
})

test('Windows: the logon task is stopped and started, and the old copy stopped, never the updater itself', () => {
  const exe = 'C:\\Users\\me\\.tether-node\\tether-node.exe'
  expect(restartService('hub', [exe], 'win32').ok).toBe(true)
  const ps = ran[0]!.at(-1)!
  expect(ran[0]!.slice(0, 1)).toEqual(['powershell.exe'])
  expect(ps).toContain(`$exe = 'C:\\Users\\me\\.tether-node\\tether-node.exe'`)
  expect(ps).toContain(`Stop-ScheduledTask -TaskName 'Tether node'`)
  expect(ps).toContain(`$_.Id -ne ${process.pid}`)
  expect(ps).toContain('$_.Path -like "$exe.old-*"')
  expect(ps.indexOf('Stop-ScheduledTask')).toBeLessThan(ps.indexOf('Start-ScheduledTask'))
  // install.ps1's Startup-folder fallback has no task: start it the way that does
  expect(ps).toContain('Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden')
  ran = []
  restartService('link', ["C:\\Users\\o'brien\\.tether-node\\bin\\tether-node.exe"], 'win32')
  expect(ran[0]!.at(-1)).toContain(`'Tether link'`)
  expect(ran[0]!.at(-1)).toContain(`$exe = 'C:\\Users\\o''brien\\.tether-node\\bin\\tether-node.exe'`)
})

test('no service manager, hub install: the copy named in node.json is stopped and the new one started', () => {
  put('.tether-node/node.json', JSON.stringify({ pid: 777, version: '0.6.3' }))
  processes.set(777, ['/home/me/.bun/bin/bun', '/home/me/.tether-node/tether-node.ts'])
  expect(restartService('hub', ['/home/me/.bun/bin/bun', '/home/me/.tether-node/tether-node.ts'], 'linux').ok).toBe(true)
  expect(signals).toEqual([[777, 'SIGTERM']])
  expect(ran.at(-1)).toEqual(['sh', '-c', `nohup '/home/me/.bun/bin/bun' '/home/me/.tether-node/tether-node.ts' >> '${home}/.tether-node/node.log' 2>&1 < /dev/null &`])
})

test('a pid in node.json that now belongs to another program is left alone', () => {
  put('.tether-node/node.json', JSON.stringify({ pid: 777 }))
  processes.set(777, ['/usr/bin/vim'])
  expect(restartService('hub', ['/bun', '/x/tether-node.ts'], 'linux').ok).toBe(false)
  expect(signals).toEqual([])
  expect(ran).toEqual([])
})

test('the app starts the update on its own: a transient unit on Linux with systemd', () => {
  put('.config/systemd/user/tether-node.service')
  expect(detachUpdate([BIN], 'linux').ok).toBe(true)
  expect(ran[0]!.slice(0, 4)).toEqual(['systemd-run', '--user', '--collect', '--quiet'])
  expect(ran[0]!.slice(-2)).toEqual([BIN, 'update'])
  expect(spawned).toEqual([])
})

test('without systemd the update runs detached, in a session of its own, logging to a file', () => {
  expect(detachUpdate([BIN], 'linux').ok).toBe(true)
  expect(ran).toEqual([])
  expect(spawned[0]!.cmd).toEqual([BIN, 'update'])
  expect(spawned[0]!.opts.detached).toBe(true)
  expect(spawned[0]!.opts.stdin).toBe('ignore')
  expect(typeof spawned[0]!.opts.stdout).toBe('number')
})

test('on Windows the update becomes a one-off task, outside the task it was asked from', () => {
  expect(detachUpdate(['C:\\t\\tether-node.exe'], 'win32').ok).toBe(true)
  const ps = ran[0]!.at(-1)!
  expect(ps).toContain(`New-ScheduledTaskAction -Execute 'C:\\t\\tether-node.exe' -Argument '"update"'`)
  expect(ps).toContain(`Start-ScheduledTask -TaskName 'Tether update'`)
})
