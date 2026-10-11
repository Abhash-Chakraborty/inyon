import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { installService, proc, uninstallService } from './service.ts'

// Linux with no user systemd: install falls back to a nohup process plus cron. Nothing real runs
// here. Every spawn, the crontab and the process table are fakes, and home is a throwaway folder.
afterAll(() => mock.restore())

const LINK = [process.execPath, '/opt/tether/tether-node.ts', 'link']
let home: string
let crontab: string
let processes: Map<number, string[]>
let signals: [number, string][]
let nextPid: number
let ignoreSignals: boolean
const pidFile = () => path.join(home, '.tether-node', 'link.pid')

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'tether-node-service-'))
  crontab = 'MAILTO=me\n0 * * * * backup\n'
  processes = new Map()
  signals = []
  nextPid = 4242
  ignoreSignals = false
  spyOn(os, 'homedir').mockReturnValue(home)
  spyOn(Bun, 'which').mockImplementation(((name: string) => (name === 'crontab' ? '/usr/bin/crontab' : null)) as any)
  spyOn(Bun, 'sleepSync').mockImplementation(() => {})
  spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[], opts: any) => {
    const result = (exitCode: number, stdout = '') => ({ exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from('') }) as any
    if (cmd[0] === 'sh' && cmd[2]!.startsWith('nohup ')) {
      // what the real line does: start the link and write its PID
      const pid = nextPid++
      processes.set(pid, LINK)
      writeFileSync(pidFile(), `${pid}\n`)
      return result(0)
    }
    if (cmd[0] === 'crontab' && cmd[1] === '-l') return result(0, crontab)
    if (cmd[0] === 'crontab' && cmd[1] === '-') {
      crontab = new TextDecoder().decode(opts.stdin)
      return result(0)
    }
    return result(1)
  }) as any)
  spyOn(proc, 'cmdline').mockImplementation((pid) => processes.get(pid))
  spyOn(proc, 'signal').mockImplementation((pid, sig) => {
    signals.push([pid, sig])
    if (!ignoreSignals) processes.delete(pid)
  })
})

afterEach(() => {
  mock.restore()
  rmSync(home, { recursive: true, force: true })
})

test.skipIf(process.platform !== 'linux')('uninstall stops the fallback process it started and removes the cron entry', () => {
  expect(installService().ok).toBe(true)
  expect(readFileSync(pidFile(), 'utf8').trim()).toBe('4242')
  expect(crontab).toContain('# tether-node link')
  // after a restart cron starts it again, and that copy records its PID too
  expect(crontab).toMatch(/@reboot nohup .* & echo \$! > '.*link\.pid' # tether-node link/)

  const r = uninstallService()
  expect(r).toEqual({ ok: true, how: 'the background service is removed' })
  expect(signals).toEqual([[4242, 'SIGTERM']])
  expect(processes.size).toBe(0)
  expect(existsSync(pidFile())).toBe(false)
  expect(crontab).toBe('MAILTO=me\n0 * * * * backup\n')
})

test.skipIf(process.platform !== 'linux')('a recorded PID that now belongs to another program is left alone', () => {
  installService()
  processes.set(4242, ['/usr/bin/vim', 'notes.txt'])
  expect(uninstallService().ok).toBe(true)
  expect(signals).toEqual([])
  expect(processes.get(4242)).toEqual(['/usr/bin/vim', 'notes.txt'])
})

test.skipIf(process.platform !== 'linux')('a fallback process that will not stop makes uninstall say so', () => {
  installService()
  ignoreSignals = true
  const r = uninstallService()
  expect(r.ok).toBe(false)
  expect(r.how).toContain('PID 4242')
  expect(signals.map(([, sig]) => sig)).toEqual(['SIGTERM', 'SIGKILL'])
  // still recorded, so a later uninstall can try again
  expect(existsSync(pidFile())).toBe(true)
})

test.skipIf(process.platform !== 'linux')('installing again replaces the running fallback instead of adding one', () => {
  installService()
  installService()
  expect(signals).toEqual([[4242, 'SIGTERM']])
  expect([...processes.keys()]).toEqual([4243])
  expect(crontab.match(/# tether-node link/g)).toHaveLength(1)
})
