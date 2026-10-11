import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { serveOps } from './ops.ts'

// no process starts here: Bun.spawn hands back a fake whose exit is ready before its output
afterAll(() => mock.restore())

function fakeSpawn() {
  let release!: (text?: string) => void
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      release = (text) => {
        if (text) c.enqueue(new TextEncoder().encode(text))
        c.close()
      }
    },
  })
  const spawn = spyOn(Bun, 'spawn').mockReturnValue({ pid: -1, stdout, exited: Promise.resolve(0), kill() {} } as any)
  return { spawn, release: (text?: string) => release(text) }
}

test('a stream sends its last lines before its exit', async () => {
  const { spawn, release } = fakeSpawn()
  const frames: any[] = []
  const ops = serveOps((m) => frames.push(m))
  try {
    ops.message({ op: 'stream', id: 's', cmd: 'fixture' })
    await Bun.sleep(20)
    release('last line\n')
    for (let i = 0; i < 100 && !frames.some((m) => m.type === 'exit'); i++) await Bun.sleep(10)
    expect(frames.map((m) => m.type)).toEqual(['line', 'exit'])
    expect(frames[0].data).toBe('last line')
  } finally {
    ops.close()
    spawn.mockRestore()
  }
})

test('output held open by an escaped child delays the exit only briefly', async () => {
  const { spawn, release } = fakeSpawn()
  const frames: any[] = []
  const ops = serveOps((m) => frames.push(m))
  try {
    const t = Date.now()
    ops.message({ op: 'stream', id: 's', cmd: 'fixture' })
    for (let i = 0; i < 300 && !frames.some((m) => m.type === 'exit'); i++) await Bun.sleep(10)
    expect(frames.map((m) => m.type)).toEqual(['exit'])
    expect(Date.now() - t).toBeLessThan(2500)
  } finally {
    release()
    ops.close()
    spawn.mockRestore()
  }
})
