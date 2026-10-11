import { expect, test } from 'bun:test'
import { sshBackend } from './ssh-backend.ts'

// a stand-in for the native plugin that, like SshCore, only knows a stream or terminal once its
// start call has returned, so a kill that arrives before then finds nothing
function fakePlugin(kind: 'stream' | 'pty') {
  const idKey = kind === 'stream' ? 'streamId' : 'ptyId'
  const listeners: Record<string, (e: any) => void> = {}
  const active = new Set<string>()
  let finishStart!: () => void
  let began!: () => void
  const beginning = new Promise<void>((r) => (began = r))
  const plugin: any = {
    addListener(e: string, cb: (e: any) => void) {
      listeners[e] = cb
      return Promise.resolve({ remove() {} })
    },
    async connect() {},
    async disconnect() {},
    [kind](a: any) {
      began()
      return new Promise<void>((r) => (finishStart = () => (active.add(a[idKey]), r())))
    },
    [kind === 'stream' ? 'streamKill' : 'ptyKill'](a: any) {
      if (active.delete(a[idKey])) listeners[kind === 'stream' ? 'streamExit' : 'ptyExit']({ [idKey]: a[idKey], code: 143 })
      return Promise.resolve()
    },
    ptyWrite: async () => {},
    ptyResize: async () => {},
  }
  return { plugin, active, beginning, finishStart: () => finishStart() }
}

for (const kind of ['stream', 'pty'] as const) {
  test(`a ${kind} killed while it is still starting is stopped once it has started`, async () => {
    const fake = fakePlugin(kind)
    const { backend } = sshBackend(fake.plugin, async () => ({}))
    const cfg: any = { id: `cancel-${kind}`, kind: 'ssh', target: 'me@server', hostKey: 'key' }
    const handle = kind === 'stream' ? backend.stream(cfg, 'tail', () => {}, {}) : backend.pty(cfg, 'sh', 80, 24, () => {})
    await fake.beginning
    handle.kill()
    fake.finishStart()
    const code = await Promise.race([handle.exited, Bun.sleep(200).then(() => 'pending')])
    expect(code).toBe(143)
    expect(fake.active.size).toBe(0)
  })
}
