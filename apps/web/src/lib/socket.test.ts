import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { ServerMsg } from '@inyon/protocol'
import type { PairedHub } from './hubs.ts'
import type { Tagged } from './socket.ts'
import { realSocketModule } from '../test/fakes.ts'

// The real connection to a paired hub (the rest of the suite gets a fake socket), against a fake
// WebSocket and a fake ticket endpoint.
const { HubConn } = realSocketModule

class FakeWS {
  static all: FakeWS[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    FakeWS.all.push(this)
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  hear(m: ServerMsg) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
}
;(FakeWS as any).CONNECTING = 0
;(FakeWS as any).OPEN = 1
;(FakeWS as any).CLOSED = 3

const hub: PairedHub = { id: 'h1', name: 'studio', url: 'http://box:4777', pairedAt: 1 }
const realWS = globalThis.WebSocket
const realFetch = globalThis.fetch
let heard: Tagged[] = []
let conn: InstanceType<typeof HubConn>
beforeEach(() => {
  FakeWS.all = []
  heard = []
  localStorage.setItem('inyon.hubs.v1', JSON.stringify([{ ...hub, token: 'tok' }]))
  globalThis.WebSocket = FakeWS as any
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ ticket: 't' }))) as any
  conn = new HubConn(hub, (m) => heard.push(m), () => true, () => [])
})
afterEach(() => {
  conn.stop()
  globalThis.WebSocket = realWS
  globalThis.fetch = realFetch
})

test('connecting again closes the connection it replaces', async () => {
  await conn.connect()
  FakeWS.all[0]!.open()
  // the ping found it quiet, or the phone came back to the app
  await conn.connect()
  expect(FakeWS.all).toHaveLength(2)
  expect(FakeWS.all[0]!.readyState).toBe(3)
  expect(FakeWS.all[1]!.readyState).toBe(0)
})

test('two connects at once open one connection', async () => {
  await Promise.all([conn.connect(), conn.connect()])
  expect(FakeWS.all).toHaveLength(1)
})

test("the hub's machines get its id, and a draft keeps saying where it was typed", async () => {
  await conn.connect()
  const ws = FakeWS.all[0]!
  ws.open()
  ws.hear({ t: 'overview', hosts: [{ config: { id: 'srv', name: 'srv', kind: 'ssh', via: 'laptop' } } as any] })
  ws.hear({ t: 'chat.draft', key: 'local:%3', text: 'half a thought', source: 'terminal', at: 1 })
  ws.hear({ t: 'chat.info', key: 'local:%3', info: { hostId: 'local', paneId: '%3' } as any })
  ws.hear({ t: 'notify', host: 'local', pane: '%3', kind: 'done', title: 'Done', body: '' })
  expect(heard[0]).toMatchObject({ t: 'overview', source: 'hub:h1', hosts: [{ config: { id: 'hub:h1/srv', via: 'hub:h1/laptop' } }] })
  expect(heard[1]).toEqual({ t: 'chat.draft', key: 'hub:h1/local:%3', text: 'half a thought', source: 'terminal', at: 1 })
  expect(heard[2]).toMatchObject({ t: 'chat.info', key: 'hub:h1/local:%3', info: { hostId: 'hub:h1/local', paneId: '%3' } })
  expect(heard[3]).toEqual({ t: 'notify', host: 'hub:h1/local', pane: '%3', kind: 'done', title: 'Done', body: '' })
  // the companion's reply has no chat key: its machine is tagged as a notice's is
  ws.hear({ t: 'companion.reply', id: 'r1', host: 'local', pane: '%9', text: 'All quiet.', at: 1 })
  expect(heard[4]).toEqual({ t: 'companion.reply', id: 'r1', host: 'hub:h1/local', pane: '%9', text: 'All quiet.', at: 1 })
})

test('a hub out of reach when the app opens lists the machines this device remembers as connecting', async () => {
  // the phone opened off its VPN: the ticket request fails before anything was ever heard
  localStorage.setItem('inyon.overview.v1', JSON.stringify({ at: Date.now(), data: [
    { config: { id: 'hub:h1/srv', name: 'srv', kind: 'ssh' }, status: 'online', sessions: [] },
    { config: { id: 'own', name: 'own', kind: 'link' }, status: 'online', sessions: [] },
  ] }))
  globalThis.fetch = mock(async () => { throw new TypeError('Failed to fetch') }) as any
  const cold = new HubConn(hub, (m) => heard.push(m), () => true, () => [])
  await cold.connect()
  cold.stop()
  localStorage.removeItem('inyon.overview.v1')
  expect(heard).toHaveLength(1)
  expect(heard[0]).toMatchObject({ t: 'overview', source: 'hub:h1', hosts: [{ config: { id: 'hub:h1/srv' }, status: 'connecting', error: 'Connecting to studio…' }] })
})

test('messages for the hub name its machines as the hub does', async () => {
  await conn.connect()
  const ws = FakeWS.all[0]!
  ws.open()
  conn.send({ t: 'draft', host: 'hub:h1/local', pane: '%3', text: 'hi' })
  expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ t: 'draft', host: 'local', pane: '%3', text: 'hi' })
})
