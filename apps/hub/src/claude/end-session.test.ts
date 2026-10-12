import { afterAll, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Host, shq } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { closes, endSession } from './actions.ts'

// A tmux server of the test's own, in its own folder: the real one is never touched.
const dir = mkdtempSync('/tmp/inyon-end-')
const own = `unset TMUX TMUX_PANE; export TMUX_TMPDIR='${dir}';`
const local = new Host({ id: 'end', name: 'end', kind: 'local' } as any)
const host = { ...local, config: local.config, exec: (cmd: string, o?: any) => local.exec(`${own} ${cmd}`, o) } as unknown as Host
// -f /dev/null: none of your tmux.conf (base-index and the like)
const tmux = async (args: string) => (await host.exec(`tmux -f /dev/null ${args}`)).stdout.trim()
/** Stops the test's server by its socket path, never whichever server happens to answer. */
const killOwn = () => host.exec(`tmux -S '${dir}/tmux-${process.getuid!()}/default' kill-server 2>/dev/null; true`)

/** What tmux has now: session:window → pane ids. */
async function layout() {
  const out = await tmux(`list-panes -a -F '#{session_name}:#{window_index} #{pane_id}' 2>/dev/null`)
  const m: Record<string, string[]> = {}
  for (const l of out.split('\n').filter(Boolean)) {
    const [w, p] = l.split(' ')
    ;(m[w] ??= []).push(p)
  }
  return m
}

/** The registry's view of a pane, built from tmux the way a probe would. */
async function found(pane: string, agent?: { kind: string }) {
  const out = await tmux(`list-panes -a -F '#{session_id} #{session_name} #{window_id} #{window_index} #{pane_id} #{pane_pid}'`)
  const rows = out.split('\n').map((l) => l.split(' '))
  const me = rows.find((r) => r[4] === pane)!
  const windows = [...new Set(rows.filter((r) => r[0] === me[0]).map((r) => r[2]))].map((w) => ({ id: w, panes: rows.filter((r) => r[2] === w).map((r) => ({ id: r[4] })) }))
  const window = windows.find((w) => w.id === me[2])!
  return { session: { id: me[0], name: me[1], windows }, window, pane: { id: pane, width: 80, agent }, panePid: Number(me[5]) }
}

let current: Awaited<ReturnType<typeof found>> | undefined
beforeEach(async () => {
  await killOwn()
  spyOn(registry, 'host').mockReturnValue(host)
  spyOn(registry, 'refresh').mockImplementation(() => {})
  spyOn(registry, 'findPane').mockImplementation(() => current as any)
  spyOn(registry, 'agentProc').mockImplementation(() => (current?.pane.agent ? { pid: current.panePid, panePid: current.panePid } : undefined) as any)
})

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())
afterAll(async () => {
  await killOwn()
  rmSync(dir, { recursive: true, force: true })
})

const start = async (target: string, cmd = 'sleep 600') => tmux(`${target} -P -F '#{pane_id}' ${shq(cmd)}`)

test('what closing a pane takes with it', () => {
  expect(closes({ session: { windows: [1, 2] }, window: { panes: [1, 2] } })).toBe('pane')
  expect(closes({ session: { windows: [1, 2] }, window: { panes: [1] } })).toBe('window')
  expect(closes({ session: { windows: [1] }, window: { panes: [1] } })).toBe('session')
})

test('a split window keeps its other pane, and other windows and sessions are left alone', async () => {
  const a = await start('new-session -d -s work -x 80 -y 20')
  const b = await start('split-window -t work:0')
  await start('new-window -t work')
  await start('new-session -d -s other')
  current = await found(b)
  expect(await endSession('end', b)).toEqual({ closed: 'pane' })
  expect(await layout()).toEqual({ 'work:0': [a], 'work:1': [expect.any(String)], 'other:0': [expect.any(String)] })
})

test("a window's last pane takes the window, not the session", async () => {
  await start('new-session -d -s work -x 80 -y 20')
  const b = await start('new-window -t work')
  current = await found(b)
  expect(await endSession('end', b)).toEqual({ closed: 'window' })
  expect(Object.keys(await layout())).toEqual(['work:0'])
})

test("a session's last window takes the session, and only that one", async () => {
  const a = await start('new-session -d -s work -x 80 -y 20')
  await start('new-session -d -s other')
  current = await found(a)
  expect(await endSession('end', a)).toEqual({ closed: 'session' })
  expect(Object.keys(await layout())).toEqual(['other:0'])
})

test('an agent is asked to exit first, then its pane closes', async () => {
  const log = `${dir}/agent.log`
  // a stand-in agent: reads lines, notes /exit and leaves when asked
  const agent = `sh -c 'while read l; do [ "$l" = /exit ] && echo exited > ${log} && exit 0; done'`
  const a = await start('new-session -d -s work -x 80 -y 20')
  const b = await start('split-window -t work:0', agent)
  current = await found(b, { kind: 'claude' })
  expect(await endSession('end', b)).toEqual({ closed: 'pane' })
  expect(readFileSync(log, 'utf8').trim()).toBe('exited')
  expect(await layout()).toEqual({ 'work:0': [a] })
}, 20_000)

test("an agent that won't exit goes with its pane", async () => {
  const a = await start('new-session -d -s work -x 80 -y 20')
  // ignores /exit and Ctrl+C
  const b = await start('split-window -t work:0', `sh -c 'trap "" INT; while :; do read l; done'`)
  current = await found(b, { kind: 'claude' })
  expect(await endSession('end', b)).toEqual({ closed: 'pane' })
  expect(await layout()).toEqual({ 'work:0': [a] })
}, 30_000)
