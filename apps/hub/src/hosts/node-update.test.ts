import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { newerRelease, VERSION, type HostState } from '@tether/protocol'
import type { Host, ExecResult } from './host.ts'
import { nodeLinks } from './node-link.ts'
import { LINK_UPDATE, NodeUpdates, nodeUpdates, updateLauncher } from './node-update.ts'
import { registry } from './registry.ts'

afterAll(() => mock.restore())

const fast = { pollMs: 5, timeoutMs: 2000, keepMs: 50, failedMs: 1000 }
const socket = () => ({ sent: [] as any[], send(d: string) { this.sent.push(JSON.parse(d)) }, close() {} })
const state = (id: string, more: Partial<HostState> & { kind?: 'node' | 'link' | 'ssh' } = {}): HostState => {
  const { kind = 'node', ...rest } = more
  return { config: { id, name: id, kind } as any, status: 'online', integration: 'unknown', tmux: 'ok', agents: [], sessions: [], updatedAt: 0, ...rest }
}
/** A machine connected over the node link, saying hello with this version. */
const connect = (id: string, version: string, os = 'linux x64') => {
  nodeLinks.attach(id, socket())
  nodeLinks.receive(id, { type: 'hello', version, os })
}
/** A fake machine: answers the launcher, then the status file with whatever `status` says. */
const fakeHost = (id: string, launch: Partial<ExecResult> = {}) => {
  const calls: { cmd: string; input?: unknown }[] = []
  const h = { status: 'running', calls, host: undefined as unknown as Host }
  h.host = {
    id,
    exec: async (cmd: string, o: { input?: unknown } = {}) => {
      calls.push({ cmd, input: o.input })
      if (cmd.includes('update-status" 2>/dev/null')) return { code: 0, stdout: `${h.status}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '', ...launch }
    },
  } as unknown as Host
  return h
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

test('tether-node versions compare by number', () => {
  expect(newerRelease('0.6.3', '0.3.0')).toBe(true)
  expect(newerRelease('0.10.0', '0.9.12')).toBe(true)
  expect(newerRelease('0.6.3', '0.6.3')).toBe(false)
  expect(newerRelease('garbage', '0.1.0')).toBe(false)
})

test('a machine paired with the hub that runs an older tether-node shows an update', () => {
  const u = new NodeUpdates(fast)
  expect(u.view(state('old', { nodeVersion: '0.3.0' }))).toEqual({ latest: VERSION, supported: true })
  expect(u.view(state('same', { nodeVersion: VERSION }))).toBeUndefined()
  expect(u.view(state('ssh', { kind: 'ssh', nodeVersion: '0.1.0' }))).toBeUndefined()
  // phone-paired laptops compare with the newest release, once it's known
  expect(u.view(state('laptop', { kind: 'link', nodeVersion: '0.6.3' }))).toBeUndefined()
  u.latestRelease = '0.7.0'
  // too old to have `tether-node update`: the app says to run setup again instead
  expect(u.view(state('laptop', { kind: 'link', nodeVersion: '0.6.3' }))).toEqual({ latest: '0.7.0', supported: false })
  expect(u.view(state('laptop', { kind: 'link', nodeVersion: '0.6.4' }))).toEqual({ latest: '0.7.0', supported: true })
})

test('refusals say why', () => {
  const u = new NodeUpdates(fast)
  u.useScripts(async () => 'script')
  const host = fakeHost('r').host
  expect(u.start(host, state('r', { kind: 'ssh' }))).toBe('Only machines running tether-node can be updated from here.')
  expect(u.start(host, state('r', { status: 'connecting', nodeVersion: '0.3.0' }))).toBe("r isn't connected. Update it once it's back online.")
  // the registry still thinks it's online, but the link just dropped
  expect(u.start(host, state('r', { nodeVersion: '0.3.0' }))).toBe("r isn't connected. Update it once it's back online.")
  connect('r', VERSION)
  expect(u.start(host, state('r', { nodeVersion: VERSION }))).toBe('tether-node on r is already up to date.')
  connect('r', '0.3.0')
  expect(new NodeUpdates(fast).start(host, state('r', { nodeVersion: '0.3.0' }))).toBe("This hub can't send tether-node updates.")
  expect(u.start(host, state('r', { nodeVersion: '0.3.0' }))).toBeUndefined()
  expect(u.start(host, state('r', { nodeVersion: '0.3.0' }))).toBe('tether-node on r is already updating.')
  connect('l', '0.6.3')
  u.latestRelease = '0.7.0'
  expect(u.start(host, state('l', { kind: 'link', nodeVersion: '0.6.3' }))).toBe("tether-node 0.6.3 can't update itself. Run its setup command on l again.")
})

test('an old Windows machine gets the script through exec, and the update ends when it is back on the new version', async () => {
  const u = new NodeUpdates(fast)
  const asked: string[][] = []
  u.useScripts(async (platform, arch) => (asked.push([platform, arch]), 'the ps1 with its checksum'))
  let changes = 0
  u.onChange(() => changes++)
  connect('win', '0.3.0', 'win32 x64')
  const m = fakeHost('win')
  expect(u.start(m.host, state('win', { nodeVersion: '0.3.0' }))).toBeUndefined()
  expect(u.view(state('win', { nodeVersion: '0.3.0' }))).toEqual({ latest: VERSION, supported: true, state: 'updating' })
  await until(() => m.calls.length >= 2)
  expect(asked).toEqual([['win32', 'x64']])
  expect(m.calls[0]).toEqual({ cmd: updateLauncher('win32'), input: 'the ps1 with its checksum' })
  expect(m.calls[0]!.cmd).toContain('-File "$d/update.ps1" -Launch')

  // the node restarts and comes back with the hub's version
  nodeLinks.detach('win', {} as any)
  connect('win', VERSION, 'win32 x64')
  await until(() => u.view(state('win', { nodeVersion: VERSION }))?.state === 'updated')
  expect(changes).toBeGreaterThanOrEqual(2)
  // a minute later (here 50 ms) it's just current again
  await until(() => u.view(state('win', { nodeVersion: VERSION })) === undefined)
})

test('a failure the script reports is shown, and the next try starts over', async () => {
  const u = new NodeUpdates(fast)
  u.useScripts(async () => 'script')
  connect('bad', '0.3.0')
  const m = fakeHost('bad')
  u.start(m.host, state('bad', { nodeVersion: '0.3.0' }))
  await until(() => m.calls.length >= 2)
  m.status = "failed: the download didn't match the hub's checksum, so nothing was changed"
  await until(() => u.view(state('bad', { nodeVersion: '0.3.0' }))?.state === 'failed')
  expect(u.view(state('bad', { nodeVersion: '0.3.0' }))?.error).toBe("The download didn't match the hub's checksum, so nothing was changed")
  m.status = 'running'
  expect(u.start(m.host, state('bad', { nodeVersion: '0.3.0' }))).toBeUndefined()
  expect(u.view(state('bad', { nodeVersion: '0.3.0' }))?.state).toBe('updating')
})

test("a launcher that can't start fails at once, with its last line of output", async () => {
  const u = new NodeUpdates(fast)
  u.useScripts(async () => 'script')
  connect('nolaunch', '0.3.0')
  const m = fakeHost('nolaunch', { code: 1, stderr: 'powershell.exe: not found\n' })
  u.start(m.host, state('nolaunch', { nodeVersion: '0.3.0' }))
  await until(() => u.view(state('nolaunch', { nodeVersion: '0.3.0' }))?.state === 'failed')
  expect(u.view(state('nolaunch', { nodeVersion: '0.3.0' }))?.error).toBe('powershell.exe: not found')
})

test('an update that never finishes times out', async () => {
  const u = new NodeUpdates({ ...fast, timeoutMs: 30 })
  u.useScripts(async () => 'script')
  connect('slow', '0.3.0')
  u.start(fakeHost('slow').host, state('slow', { nodeVersion: '0.3.0' }))
  await until(() => u.view(state('slow', { nodeVersion: '0.3.0' }))?.state === 'failed')
  expect(u.view(state('slow', { nodeVersion: '0.3.0' }))?.error).toContain('taking too long')
})

test('a laptop paired with the phone runs its own tether-node update, detached', async () => {
  const u = new NodeUpdates(fast)
  u.latestRelease = '0.7.0'
  connect('lap', '0.6.4', 'darwin arm64')
  const m = fakeHost('lap')
  expect(u.start(m.host, state('lap', { kind: 'link', nodeVersion: '0.6.4' }))).toBeUndefined()
  await until(() => m.calls.length >= 1)
  expect(m.calls[0]).toEqual({ cmd: LINK_UPDATE, input: undefined })
  expect(LINK_UPDATE).toBe('"$TETHER_NODE_EXE" ${TETHER_NODE_SCRIPT:+"$TETHER_NODE_SCRIPT"} update --background')
})

test('the phone learns the newest release from the GitHub API', async () => {
  const u = new NodeUpdates(fast)
  const urls: string[] = []
  const get = (async (url: string) => (urls.push(url), Response.json({ tag_name: 'v0.7.2' }))) as unknown as typeof fetch
  clearInterval(u.watchReleases(get))
  await until(() => u.latestRelease === '0.7.2')
  expect(urls).toEqual(['https://api.github.com/repos/Abhash-Chakraborty/tether-releases/releases/latest'])
})

test('the API refuses machines it cannot update, with a clear 409', async () => {
  const { coreRoutes } = await import('../core.ts')
  const post = (coreRoutes['/api/hosts/:id/node/update'] as any).POST
  const ask = async (id: string) => {
    const res = await post(Object.assign(new Request(`http://hub/api/hosts/${id}/node/update`, { method: 'POST' }), { params: { id } }))
    return { status: res.status, error: (await res.json()).error }
  }
  const rts: Record<string, any> = {
    box: { host: fakeHost('box').host, state: state('box', { kind: 'ssh' }) },
    away: { host: fakeHost('away').host, state: state('away', { status: 'error', nodeVersion: '0.3.0' }) },
    fine: { host: fakeHost('fine').host, state: state('fine', { nodeVersion: VERSION }) },
  }
  const get = spyOn(registry, 'get').mockImplementation(((id: string) => rts[id]) as any)
  connect('fine', VERSION)
  expect(await ask('nope')).toEqual({ status: 404, error: 'Unknown machine' })
  expect(await ask('box')).toEqual({ status: 409, error: 'Only machines running tether-node can be updated from here.' })
  expect(await ask('away')).toEqual({ status: 409, error: "away isn't connected. Update it once it's back online." })
  expect(await ask('fine')).toEqual({ status: 409, error: 'tether-node on fine is already up to date.' })
  get.mockRestore()
})

test('the overview carries the update state', () => {
  const add = { config: { id: 'ov', name: 'ov', kind: 'node' }, status: 'online', nodeVersion: '0.3.0' }
  const hosts = (registry as any).hosts as Map<string, any>
  hosts.set('ov', { state: add })
  try {
    expect(registry.overview().find((h) => h.config.id === 'ov')?.nodeUpdate).toEqual({ latest: VERSION, supported: true })
  } finally {
    hosts.delete('ov')
  }
  expect(nodeUpdates).toBeInstanceOf(NodeUpdates)
})
