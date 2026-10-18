import { expect, test } from 'bun:test'
import { nodeLinks } from './node-link.ts'
import { nodeBackend } from './node-backend.ts'

const socket = (onClose?: () => void) => {
  const sent: any[] = []
  return { sent, closed: false, send(d: string) { sent.push(JSON.parse(d)) }, close() { this.closed = true; onClose?.() } }
}
const settled = async (p: Promise<number>) => Promise.race([p, Bun.sleep(50).then(() => 'pending' as const)])

test('a newer connection fails the old one\'s streams and terminals, even when the old close comes later', async () => {
  const config: any = { id: 'replace-late', kind: 'node' }
  const old = socket()
  nodeLinks.attach(config.id, old)
  const stream = nodeBackend.stream(config, 'tail', () => {}, {})
  const pty = nodeBackend.pty(config, 'sh', 80, 24, () => {})
  const next = socket()
  nodeLinks.attach(config.id, next)
  expect(old.closed).toBe(true)
  expect(await settled(stream.exited)).not.toBe('pending')
  expect(await settled(pty.exited)).not.toBe('pending')

  // what the old operations still try to say stays off the new socket
  pty.write('ls\n')
  stream.kill()
  expect(next.sent).toEqual([])

  // the old socket's own close callback arrives afterwards and leaves the new one alone
  const fresh = nodeBackend.stream(config, 'tail', () => {}, {})
  nodeLinks.detach(config.id, old)
  expect(nodeLinks.isUp(config.id)).toBe(true)
  expect(await settled(fresh.exited)).toBe('pending')
  fresh.kill()
  nodeLinks.detach(config.id, next)
})

test('the same holds when the old socket reports its close straight away', async () => {
  const config: any = { id: 'replace-sync', kind: 'node' }
  const old = socket(() => nodeLinks.detach(config.id, old))
  nodeLinks.attach(config.id, old)
  const stream = nodeBackend.stream(config, 'tail', () => {}, {})
  const next = socket()
  nodeLinks.attach(config.id, next)
  expect(await settled(stream.exited)).not.toBe('pending')
  expect(nodeLinks.isUp(config.id)).toBe(true)
  nodeLinks.detach(config.id, next)
})

test("acting on a machine that isn't connected answers 503 with a sentence the app can show", async () => {
  const config: any = { id: 'not-connected', kind: 'node' }
  await expect(nodeBackend.exec(config, 'true', {})).rejects.toMatchObject({ status: 503, message: 'This machine is not connected. Is inyon running on it?' })
})
