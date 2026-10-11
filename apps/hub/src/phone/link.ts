import { connect, LinkError, noiseKeyOf, phonePath, relayWs, resolve, wsWire, type Channel, type KeyPair, type PairInfo } from '@tether/link'
import type { HostConfig } from '@tether/protocol'
import { nodeLinks } from '../hosts/node-link.ts'

/**
 * The phone's side of `tether-node link`: one end-to-end encrypted channel per paired laptop,
 * carrying the same commands a hub sends to tether-node. It tries the addresses the laptop gave
 * last (its LAN address first, then its tunnel), looks up its current ones by its id when those
 * fail (a tunnel's address changes every time it restarts), then its relays. A lost connection
 * comes back on its own, and at once when the app returns to the foreground.
 */

const DIRECT_MS = 4000
const PING_MS = 20_000
const PONG_MS = 8000

export interface Welcome {
  hostname?: string
  os?: string
  urls?: string[]
  relays?: string[]
}

interface Conn {
  config: HostConfig
  channel?: Channel
  connecting?: Promise<void>
  attempt: number
  timer?: ReturnType<typeof setTimeout>
  ping?: ReturnType<typeof setInterval>
  awaitingPong?: ReturnType<typeof setTimeout>
  stopped?: boolean
  lastError?: string
}

/** Opens a channel through the first address that answers; LAN and tunnel race, relays come last. */
async function reach(o: { noise: KeyPair; id: string; urls: string[]; relays: string[]; hello: object }) {
  const machineKey = noiseKeyOf(o.id)
  const via = (url: string, ms: number) =>
    new Promise<Awaited<ReturnType<typeof connect>> & { url: string }>((ok, fail) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch (err) {
        return fail(err)
      }
      const timer = setTimeout(() => (ws.close(), fail(new LinkError('TIMEOUT', `${new URL(url).host} didn't answer`))), ms)
      connect(wsWire(ws), { noise: o.noise, machineKey, hello: o.hello }).then(
        (r) => (clearTimeout(timer), ok({ ...r, url })),
        (err) => (clearTimeout(timer), fail(err)),
      )
    })
  /** The first address to answer wins; the others are closed, even ones that answer later. */
  const firstOf = (urls: string[], ms: number) =>
    new Promise<Awaited<ReturnType<typeof via>>>((ok, fail) => {
      if (!urls.length) return fail(new LinkError('CLOSED', 'No address to try'))
      let won = false
      const errors: unknown[] = []
      for (const u of urls) {
        via(u, ms).then(
          (r) => {
            if (won) return r.channel.close(1000, 'another address answered first')
            won = true
            ok(r)
          },
          (err) => {
            errors.push(err)
            if (won || errors.length < urls.length) return
            // a refusal (not paired, wrong machine) says more than a timeout
            fail(errors.find((e) => e instanceof LinkError && (e.code === 'NOT_PAIRED' || e.code === 'BAD_KEY' || e.code === 'REFUSED')) ?? errors[0])
          },
        )
      }
    })
  const tried = new Set<string>()
  try {
    o.urls.forEach((u) => tried.add(u))
    return { ...(await firstOf(o.urls, DIRECT_MS)), urls: o.urls }
  } catch (err) {
    if (err instanceof LinkError && err.code !== 'TIMEOUT' && err.code !== 'CLOSED') throw err
  }
  const found = await resolve(o.id).catch(() => undefined)
  const fresh = (found?.urls ?? []).filter((u) => !tried.has(u))
  const relays = [...new Set([...(found?.relays ?? []), ...o.relays])]
  if (fresh.length) {
    try {
      return { ...(await firstOf(fresh, DIRECT_MS * 2)), urls: found!.urls }
    } catch (err) {
      if (err instanceof LinkError && err.code !== 'TIMEOUT' && err.code !== 'CLOSED') throw err
    }
  }
  if (relays.length) return { ...(await firstOf(relays.map((r) => relayWs(r, phonePath(o.id))), DIRECT_MS * 2)), urls: found?.urls ?? o.urls }
  throw new LinkError('TIMEOUT', found ? "The computer isn't answering at its addresses. Is `tether-node link` running there?" : "Couldn't find the computer online. Is `tether-node link` running there? It needs to be on and connected to the internet.")
}

/**
 * Where to try next time: the laptop's own list, with the direct address that just worked first
 * (a tunnel's address changes, so only a direct one is worth keeping when the laptop didn't list it).
 */
const addresses = (worked: string, listed: string[]) =>
  [...new Set([...(worked.startsWith('ws://') || listed.includes(worked) ? [worked] : []), ...listed])]

export function linkConnector(noise: () => Promise<KeyPair>, phoneName: string, saveAddresses: (id: string, urls: string[], relays: string[]) => void) {
  const conns = new Map<string, Conn>()

  const drop = (c: Conn, why: string) => {
    clearInterval(c.ping)
    clearTimeout(c.awaitingPong)
    c.awaitingPong = undefined
    const ch = c.channel
    c.channel = undefined
    if (ch) {
      ch.onclose = undefined
      ch.close(1000, why)
    }
  }

  const schedule = (c: Conn, now = false) => {
    clearTimeout(c.timer)
    if (c.stopped) return
    const delay = now ? 0 : Math.min(30_000, 1000 * 2 ** c.attempt++)
    c.timer = setTimeout(() => open(c), delay)
  }

  const open = (c: Conn): Promise<void> =>
    (c.connecting ??= (async () => {
      try {
        const id = c.config.machineId!
        const r = await reach({ noise: await noise(), id, urls: c.config.urls ?? [], relays: c.config.relays ?? [], hello: { name: phoneName } })
        if (c.stopped) return r.channel.close()
        c.attempt = 0
        c.lastError = undefined
        c.channel = r.channel
        const welcome = r.welcome as Welcome
        const urls = addresses(r.url, welcome.urls?.length ? welcome.urls : r.urls)
        if (JSON.stringify([urls, welcome.relays ?? []]) !== JSON.stringify([c.config.urls ?? [], c.config.relays ?? []])) saveAddresses(c.config.id, urls, welcome.relays ?? [])
        const hostId = c.config.id
        const socket = { send: (raw: string) => r.channel.send(JSON.parse(raw)), close: (code?: number, reason?: string) => r.channel.close(code, reason) }
        r.channel.onmessage = (m) => {
          if (m?.type === 'pong') {
            // answered: the next check can send its own ping
            clearTimeout(c.awaitingPong)
            c.awaitingPong = undefined
            return
          }
          nodeLinks.receive(hostId, m)
        }
        r.channel.onclose = () => {
          clearInterval(c.ping)
          clearTimeout(c.awaitingPong)
          c.awaitingPong = undefined
          c.channel = undefined
          nodeLinks.detach(hostId, socket)
          schedule(c)
        }
        c.ping = setInterval(() => check(c), PING_MS)
        nodeLinks.attach(hostId, socket)
        nodeLinks.receive(hostId, { type: 'hello', version: (welcome as any).version, os: welcome.os })
      } catch (err) {
        c.lastError = (err as Error).message
        // not paired any more: retrying won't help until it pairs again (coming back to the app
        // still tries once more, in case it was paired again meanwhile)
        if (err instanceof LinkError && (err.code === 'NOT_PAIRED' || err.code === 'BAD_KEY')) nodeLinks.fail(c.config.id, c.lastError)
        else {
          nodeLinks.fail(c.config.id, `Connecting to ${c.config.name}… (${c.lastError})`)
          schedule(c)
        }
      } finally {
        c.connecting = undefined
      }
    })())

  /** A ping the laptop must answer; a socket that died while the phone slept fails it fast. */
  const check = (c: Conn, ms = PONG_MS) => {
    if (!c.channel || c.awaitingPong) return
    c.channel.send({ op: 'ping', t: Date.now() })
    c.awaitingPong = setTimeout(() => {
      c.awaitingPong = undefined
      c.channel?.close(4408, 'no answer')
    }, ms)
  }

  return {
    /** Keeps this machine connected (called for every link machine in the list). */
    ensure(config: HostConfig) {
      let c = conns.get(config.id)
      if (c) {
        c.config = config
        return
      }
      conns.set(config.id, (c = { config, attempt: 0 }))
      open(c)
    },
    forget(id: string) {
      const c = conns.get(id)
      if (!c) return
      c.stopped = true
      clearTimeout(c.timer)
      drop(c, 'removed')
      conns.delete(id)
    },
    /** Back in the foreground: check every connection now instead of waiting out a backoff. */
    resume() {
      for (const c of conns.values()) {
        if (c.channel) check(c, 3000)
        else {
          c.attempt = 0
          schedule(c, true)
        }
      }
    },
    /** First contact, with the code from the laptop's screen. */
    async pair(info: PairInfo): Promise<Welcome> {
      const r = await reach({ noise: await noise(), id: info.id, urls: info.urls, relays: info.relays, hello: { name: phoneName, pair: info.secret } })
      r.channel.close(1000, 'paired')
      const w = r.welcome as Welcome
      return { ...w, urls: addresses(r.url, w.urls?.length ? w.urls : r.urls) }
    },
  }
}
