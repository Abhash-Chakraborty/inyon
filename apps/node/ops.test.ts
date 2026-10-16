import { afterAll, expect, test } from 'bun:test'
import { serveOps, WIN, winLine } from './ops.ts'

test('on Windows, live output from a hub attach gets its session in front of the pane', () => {
  // what apps/hub/src/tmux/live.ts runs (attach), and the plain form from before it
  const attach = `exec tmux $([ "$(command -v tmux)" = tmux ] || echo -u) -C attach-session -t '$3' -f read-only,ignore-size`
  const plain = `tmux -C attach-session -t $3`
  for (const cmd of [attach, plain]) {
    const map = winLine(cmd, true)
    expect(map).toBeDefined()
    expect(map!('%output %1 aGVsbG8=')).toBe('%output %3.1 aGVsbG8=')
    expect(map!('%extended-output %12 0 : x')).toBe('%extended-output %3.12 0 : x')
    expect(map!('%window-add @1')).toBe('%window-add @1')
  }
  expect(winLine('tmux list-panes -a', true)).toBeUndefined()
  expect(winLine(attach, false)).toBeUndefined()
})

// a sleep only these tests start, so they can tell whether it is still running
const MARK = `${4000 + Math.floor(Math.random() * 999)}.${process.pid}`
const ESCAPED = `${MARK}9`
const left = (mark = MARK) =>
  Bun.spawnSync(['ps', '-eo', 'pid=,args=']).stdout.toString().split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m) => m?.[2] === `sleep ${mark}`)
    .map((m) => Number(m![1]))
afterAll(() => {
  for (const pid of [...left(), ...left(ESCAPED)]) process.kill(pid, 'SIGKILL')
})

function ops() {
  const msgs: any[] = []
  const waiters: (() => void)[] = []
  const o = serveOps((m) => (msgs.push(m), waiters.splice(0).forEach((w) => w())))
  const next = async (id: string, type: string, ms = 5000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const m = msgs.find((x) => x.id === id && x.type === type)
      if (m) return m
      await new Promise<void>((r) => (waiters.push(r), setTimeout(r, 50)))
    }
    throw new Error(`no ${type} for ${id}`)
  }
  return { o, next }
}

test.skipIf(WIN)('killing a command stops its whole pipeline, and the exec still answers', async () => {
  const { o, next } = ops()
  o.message({ op: 'exec', id: 'a', cmd: `sleep ${MARK} | cat` })
  for (let i = 0; i < 40 && !left().length; i++) await Bun.sleep(50)
  expect(left().length).toBeGreaterThan(0)
  const t = Date.now()
  o.message({ op: 'kill', id: 'a' })
  await next('a', 'exit')
  expect(Date.now() - t).toBeLessThan(3000)
  for (let i = 0; i < 40 && left().length; i++) await Bun.sleep(50)
  expect(left()).toEqual([])
})

test.skipIf(WIN || !Bun.which('setsid'))('output held open by a child that left the group does not hang the exec', async () => {
  const { o, next } = ops()
  const t = Date.now()
  o.message({ op: 'exec', id: 'b', cmd: `setsid sleep ${ESCAPED} & echo started` })
  const m = await next('b', 'exit')
  expect(m.stdout.trim()).toBe('started')
  expect(Date.now() - t).toBeLessThan(3000)
  for (const pid of left(ESCAPED)) process.kill(pid, 'SIGKILL')
})

test.skipIf(WIN)('commands end when inyon itself exits', async () => {
  const code = `import { serveOps } from './ops.ts'; serveOps(() => {}).message({ op: 'stream', id: 'x', cmd: 'sleep ${MARK} | cat' }); setTimeout(() => process.exit(0), 1500)`
  const p = Bun.spawn([process.execPath, '-e', code], { cwd: import.meta.dir, stdout: 'ignore', stderr: 'ignore' })
  for (let i = 0; i < 25 && !left().length; i++) await Bun.sleep(50)
  expect(left().length).toBeGreaterThan(0)
  await p.exited
  for (let i = 0; i < 40 && left().length; i++) await Bun.sleep(50)
  expect(left()).toEqual([])
})

test.skipIf(WIN)('closing the connection ends streams and everything they started', async () => {
  const { o } = ops()
  o.message({ op: 'stream', id: 'c', cmd: `sleep ${MARK} | cat` })
  for (let i = 0; i < 40 && !left().length; i++) await Bun.sleep(50)
  expect(left().length).toBeGreaterThan(0)
  o.close()
  for (let i = 0; i < 40 && left().length; i++) await Bun.sleep(50)
  expect(left()).toEqual([])
})
