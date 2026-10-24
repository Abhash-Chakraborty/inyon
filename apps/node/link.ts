import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import {
  accept, authMessage, formatShortId, frame, identityFromSeed, LinkError, machinePath, newIdentity, newShortCode, PKARR_RELAYS, publish, relayWs, resolve, shortCodeIdentity, shortSecret, sign, unframe,
  type Identity, type RelayToMachine, type Wire,
} from '@inyon/link'
import { attemptAfter, backoff } from '@inyon/protocol'
import { detectNetworks, LABEL, type Network } from '../hub/src/networks.ts'
import { serveOps, WIN } from './ops.ts'
import { tryLock, type Held } from './oslock.ts'
import { forgetPushes, startPush } from './push.ts'
import { binDir, nodeDir } from './paths.ts'

/**
 * Lets the Inyon phone app reach this machine directly, with no hub. The phone pairs once by
 * scanning a code (`inyon pair`), then connects over an end-to-end encrypted link (Noise)
 * through whichever way works: a free Cloudflare quick tunnel this machine opens by itself (so
 * it works from any network), its address on a private network (Tailscale, NetBird, ZeroTier,
 * WireGuard), its LAN address, an address you publish yourself, or a relay you run. The tunnel and
 * the relay only ever carry ciphertext. The tunnel's address changes when it restarts, so the
 * machine publishes its current addresses under its own key (pkarr) and the phone looks them up.
 */

export const VERSION = '0.20.5'
const file = (name: string) => path.join(nodeDir(), name)
const PAIR_MINUTES = 10

export interface LinkConfig {
  /** relays to keep a connection to, like https://relay.example.com */
  relays: string[]
  /** open a Cloudflare quick tunnel so phones on any network can connect */
  tunnel: boolean
  /** also listen on this machine's LAN addresses (otherwise only the tunnel and relays reach it) */
  lan: boolean
  /**
   * also listen on its private network addresses (Tailscale, NetBird, ZeroTier, WireGuard). Only
   * devices the network lets in reach them. Off on Windows, where listening there asks the
   * firewall each time.
   */
  vpn: boolean
  /** addresses of your own to publish, like wss://laptop.tail1234.ts.net:8443/link */
  urls: string[]
  port: number
}

export const DEFAULT_CONFIG: LinkConfig = { relays: [], tunnel: true, lan: false, vpn: process.platform !== 'win32', urls: [], port: 4780 }

interface Phone {
  name: string
  pairedAt: number
  lastSeen?: number
}

interface State {
  urls: string[]
  relays: string[]
  updatedAt: number
  pid: number
  /** missing from links before `tether-node update` existed */
  version?: string
  /** the seq of the last address record published, so the next is newer even if the clock went back */
  lastSeq?: number
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file(name), 'utf8'))
  } catch {
    return fallback
  }
}

/** Written whole or not at all, readable only by this user (it holds keys and pairings). */
function writeJson(name: string, value: unknown) {
  mkdirSync(nodeDir(), { recursive: true, mode: 0o700 })
  const tmp = `${file(name)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(tmp, file(name))
}

/**
 * The lock every process takes around a read-modify-write of the node's files: `inyon forget` and
 * `inyon pair` run as processes of their own beside the link, and without it one would write back
 * what it read before the other's change (a forgotten phone back, a new code replaced by the old).
 * An OS lock on the file (oslock.ts), the same one the built-in engine takes. The file stays: removing
 * it while another process waits on it would let a third lock a new one.
 */
export const FILES_LOCK = 'files.lock'
const LOCK_WAIT = 15_000
/** How long a phone's hello waits: the phone gives each address 4 s, and the handshake needs some. */
export const CHECK_WAIT = 1000

/** The lock, or why not by `until`. Every way through ends by then. */
function takeFilesLock(until: number): Held | string {
  mkdirSync(nodeDir(), { recursive: true, mode: 0o700 })
  const lock = file(FILES_LOCK)
  let why = 'another process holds it'
  for (;;) {
    try {
      const held = tryLock(lock)
      if (held) return held
      why = 'another process holds it'
    } catch (err) {
      why = (err as Error).message
    }
    if (Date.now() >= until) return `couldn't lock ${lock} in time (${why})`
    Bun.sleepSync(5)
  }
}

/**
 * Runs `fn` holding the files, waiting up to 15 s; never without the lock. A change made without it
 * could bring a forgotten phone back, so when another process keeps them that long this throws why
 * and changes nothing: a command stops with it.
 */
export function withNodeFiles<T>(fn: () => T): T {
  const held = takeFilesLock(Date.now() + LOCK_WAIT)
  if (typeof held === 'string') {
    throw new Error(`The node's files are busy: another inyon process has held ${file(FILES_LOCK)} for over ${LOCK_WAIT / 1000} s. Try again in a moment; if it stays busy, stop the process whose pid is in that file.`)
  }
  try {
    return fn()
  } finally {
    held.release()
  }
}

/** How long the running link waits for the files before it skips a note (lastSeen, state.json): it has one thread, and phones to answer. */
const LINK_WAIT = 200

/** Runs `fn` holding the files, or returns `busy` when they aren't free within `wait` ms. */
export function withNodeFilesWithin<T, B>(wait: number, fn: () => T, busy: () => B): T | B {
  const held = takeFilesLock(Date.now() + wait)
  if (typeof held === 'string') {
    console.error(held)
    return busy()
  }
  try {
    return fn()
  } finally {
    held.release()
  }
}

/**
 * This machine's identity, made on first use. Its id is what the phone pairs with. A file that is
 * there but unreadable, or holds anything but a 64-digit hex seed, stops the link and stays as it
 * is: a new identity would be a stranger to every paired phone.
 */
export function identity(): Identity {
  return withNodeFiles(() => {
    let text: string
    try {
      text = readFileSync(file('identity.json'), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`couldn't read ${file('identity.json')}: ${(err as Error).message}`)
      const id = newIdentity()
      writeJson('identity.json', { seed: Buffer.from(id.seed).toString('hex'), id: id.id })
      return id
    }
    let seed: unknown
    try {
      seed = JSON.parse(text)?.seed
    } catch {}
    if (typeof seed !== 'string' || !/^[0-9a-fA-F]{64}$/.test(seed)) {
      throw new Error(`${file('identity.json')} isn't a valid identity (it needs a 64-digit hex seed). Restore it from a backup; moving it away makes a new identity, and every phone then has to pair again.`)
    }
    return identityFromSeed(Uint8Array.from(Buffer.from(seed, 'hex')))
  })
}

export const loadConfig = (): LinkConfig => ({ ...DEFAULT_CONFIG, ...readJson<Partial<LinkConfig>>('link.json', {}) })
export const saveConfig = (c: LinkConfig) => withNodeFiles(() => writeJson('link.json', c))

const phones = () => readJson<Record<string, Phone>>('phones.json', {})

/** The phone's model without the build number Android's browser adds ("A142 Build/BP2A.250605" is "A142"). */
export function phoneName(raw: unknown) {
  return String(raw ?? '').split(' Build/')[0]!.trim().slice(0, 64) || 'Phone'
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

const sameText = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** A short code is a 1-in-a-million guess, so it's dropped after this many wrong ones. */
const SHORT_TRIES = 5

type Pairing = { secret?: string; short?: string; failures?: number; expires?: number }

/**
 * Starts a pairing, good for a few minutes: a long secret for the QR code, and a short ID and
 * code for typing in.
 */
export function newPairing() {
  const secret = crypto.randomBytes(24).toString('base64url')
  const short = newShortCode()
  withNodeFiles(() => writeJson('pairing.json', { secret, short: shortSecret(short), expires: Date.now() + PAIR_MINUTES * 60_000 } satisfies Pairing))
  return { secret, short }
}

export const currentState = () => readJson<State | undefined>('state.json', undefined)

/**
 * A process that has exited but wasn't collected yet (in a container whose first process doesn't
 * collect them, say) still answers kill(pid, 0). Linux shows it as Z.
 */
export function exited(pid: number) {
  try {
    return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return false
  }
}

/**
 * Whether a link other than this process runs: the pid state.json names is still alive, or
 * something answers on the link's port the way a link does. The pid alone isn't enough: a link
 * that ended with the terminal it was started in leaves its pid behind, and a pid check doesn't
 * see every process on every platform. A second link on the same computer would publish an
 * address of its own and leave the phone pointing at it once it ends, so this errs towards "yes".
 */
export async function linkRunning(port?: number) {
  const pid = currentState()?.pid
  if (pid && pid !== process.pid) {
    try {
      process.kill(pid, 0)
      if (!exited(pid)) return true
    } catch {}
  }
  if (!port) return false
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(700) })
    return r.ok && (await r.text()).trim() === 'inyon'
  } catch {
    return false
  }
}

/** How often lastSeen is written for one phone; every write is one more race with `inyon forget`. */
const SEEN_EVERY = 60_000

/**
 * Notes that a paired phone was here, once its first frame proved it holds its keys (message 1
 * alone can be replayed). Read again under the lock, so a phone forgotten meanwhile stays gone.
 */
export function markSeen(key: string, every = SEEN_EVERY) {
  // only `inyon phones` shows it: skipped when the files are busy, never written past the lock
  withNodeFilesWithin(
    LINK_WAIT,
    () => {
      const all = phones()
      const p = all[key]
      if (!p || Date.now() - (p.lastSeen ?? 0) < every) return
      p.lastSeen = Date.now()
      writeJson('phones.json', all)
    },
    () => undefined,
  )
}

export function forgetPhone(key: string) {
  withNodeFiles(() => {
    const all = phones()
    delete all[key]
    writeJson('phones.json', all)
  })
  endSessions(key)
  forgetPushes(key)
}

/** Open phone sessions by the phone's key, so forgetting a phone also ends what it has open. */
const active = new Map<string, Set<() => void>>()
let phonesStamp: number | undefined
let watching: ReturnType<typeof setInterval> | undefined

function endSessions(key: string) {
  const ends = active.get(key)
  active.delete(key)
  for (const end of ends ?? []) end()
}

/** `inyon forget` runs as a process of its own: notice phones.json changing and drop who's gone. */
function dropForgotten() {
  let stamp = -1
  try {
    stamp = statSync(file('phones.json')).mtimeMs
  } catch {}
  if (stamp === phonesStamp) return
  phonesStamp = stamp
  const all = phones()
  for (const key of [...active.keys()]) if (!all[key]) endSessions(key)
}

// phones paired before names were cleaned may still carry the build number
export const listPhones = () => Object.fromEntries(Object.entries(phones()).map(([key, p]) => [key, { ...p, name: phoneName(p.name) }]))

/** Everything a phone session can do once it's in. */
function welcome() {
  const s = currentState()
  return {
    version: VERSION,
    hostname: os.hostname(),
    os: `${os.platform()} ${os.arch()}`,
    platform: os.platform(),
    mux: WIN ? 'psmux' : 'tmux',
    urls: s?.urls ?? [],
    relays: s?.relays ?? [],
  }
}

/** Who may come in: a phone paired before, or one bringing the secret from the code on screen. */
export const check = (remoteStatic: Uint8Array, hello: { name?: string; pair?: string }) =>
  // the phone gives each address a few seconds: say busy in time rather than miss them all
  withNodeFilesWithin(CHECK_WAIT, () => checkLocked(remoteStatic, hello), () => {
    throw new LinkError('REFUSED', 'This computer is busy saving its files. Try again in a moment.')
  })

function checkLocked(remoteStatic: Uint8Array, hello: { name?: string; pair?: string }) {
  const key = hex(remoteStatic)
  const all = phones()
  // nothing is written for a paired phone yet: lastSeen waits for its first frame (markSeen)
  if (all[key]) return welcome()
  const pairing = readJson<Pairing>('pairing.json', {})
  const live = (pairing.expires ?? 0) > Date.now()
  const matches = (want?: string) => !!want && !!hello.pair && sameText(hello.pair, want)
  if (hello.pair && live && (matches(pairing.secret) || matches(pairing.short))) {
    all[key] = { name: phoneName(hello.name), pairedAt: Date.now(), lastSeen: Date.now() }
    try {
      writeJson('phones.json', all)
    } catch (err) {
      // not saved, not paired: the phone is told, and the code stays good for another try
      throw new LinkError('REFUSED', `${os.hostname()} couldn't save the pairing (${(err as Error).message}). Check the space and permissions of ~/.inyon/node, then try again.`)
    }
    // one code, one phone
    rmSync(file('pairing.json'), { force: true })
    console.log(`paired with ${all[key].name}`)
    return welcome()
  }
  if (hello.pair && live && pairing.short) {
    // a wrong code: count it, and stop taking short codes before guessing could pay off
    const failures = (pairing.failures ?? 0) + 1
    try {
      writeJson('pairing.json', failures >= SHORT_TRIES ? { ...pairing, short: undefined, failures } : { ...pairing, failures })
    } catch (err) {
      // a guess that can't be counted mustn't be free: the code stops working
      console.error(`couldn't save pairing.json: ${(err as Error).message}`)
      rmSync(file('pairing.json'), { force: true })
    }
    if (failures >= SHORT_TRIES) throw new LinkError('NOT_PAIRED', 'Too many wrong codes, so that one no longer works. Run `inyon pair` on the computer for a new one.')
    throw new LinkError('NOT_PAIRED', "That code doesn't match. Check it against the one on the computer and try again.")
  }
  if (hello.pair) throw new LinkError('NOT_PAIRED', 'That pairing code has expired or was already used. Run `inyon pair` on the computer for a new one.')
  throw new LinkError('NOT_PAIRED', "This phone isn't paired with this computer any more. Run `inyon pair` there and scan the code again.")
}

/** One phone session: the encrypted handshake, then the same commands the hub sends. */
async function session(id: Identity, wire: Wire, via: string) {
  let channel, remoteStatic
  try {
    ;({ channel, remoteStatic } = await accept(wire, { noise: id.noise, check }))
  } catch (err) {
    if (!(err instanceof LinkError)) console.log(`refused a connection via ${via}: ${(err as Error).message}`)
    return
  }
  const key = hex(remoteStatic)
  // forgotten while the handshake finished
  if (!phones()[key]) return channel.close(4403, 'unpaired')
  const ops = serveOps((m) => channel.send(m))
  let open = true
  const end = () => channel.close(4403, 'unpaired')
  if (!active.has(key)) active.set(key, new Set())
  active.get(key)!.add(end)
  // a stream can run with nothing coming in, so check now and then too, not only per message
  watching ??= setInterval(dropForgotten, 2000)
  let proven = false
  channel.onmessage = (m) => {
    // a frame that opens proves the phone holds its keys, which a replayed message 1 doesn't
    if (!proven) {
      proven = true
      markSeen(key)
    }
    dropForgotten()
    if (!open) return
    if (m?.op === 'ping') return channel.send({ type: 'pong', t: m.t })
    // the phone removed this computer: it stops being trusted here too, as `inyon forget` would
    if (m?.op === 'unpair') {
      console.log(`a phone removed this computer; it is no longer paired (${key.slice(0, 12)}…)`)
      try {
        return forgetPhone(key)
      } catch (err) {
        return console.error((err as Error).message)
      }
    }
    ops.message(m)
  }
  channel.onclose = () => {
    open = false
    ops.close()
    const mine = active.get(key)
    mine?.delete(end)
    if (mine && !mine.size) active.delete(key)
    if (!active.size && watching) {
      clearInterval(watching)
      watching = undefined
    }
  }
}

// ---------- the local listener (behind the tunnel, on private networks, on the LAN if asked) ----------

function listen(id: Identity, hostname: string, port: number) {
  type Data = { wire: Wire }
  const server = Bun.serve<Data>({
    hostname,
    port,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/link') {
        const wire: Wire = { send() {}, close() {} }
        if (srv.upgrade(req, { data: { wire } })) return
        return new Response('Upgrade failed', { status: 400 })
      }
      return new Response('inyon\n')
    },
    websocket: {
      maxPayloadLength: 1 << 20,
      idleTimeout: 120,
      open(ws) {
        const w = ws.data.wire
        w.send = (d) => void ws.send(d)
        w.close = (code, reason) => ws.close(code, reason)
        session(id, w, 'direct')
      },
      message(ws, raw) {
        if (typeof raw !== 'string') ws.data.wire.onmessage?.(new Uint8Array(raw))
      },
      close(ws, code, reason) {
        ws.data.wire.onclose?.(code, reason)
      },
    },
  })
  return server
}

// container and VM bridges only reach this machine's own guests, never a phone
const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|podman|lxc|lxd|kube|cali|vEthernet)/i

function lanUrls(port: number) {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !VIRTUAL.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal && lanAddress(a.address))
    .map((a) => `ws://${a.address}:${port}/link`)
}

/**
 * What `--lan` publishes: private (10/8, 172.16/12, 192.168/16), link-local and VPN (100.64/10)
 * addresses. Never a public one, such as a server's: the record is public, and a phone on the
 * internet reaches the machine through the tunnel anyway.
 */
export function lanAddress(ip: string) {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}

// ---------- the Cloudflare quick tunnel ----------

/**
 * The cloudflared release that gets downloaded, with the sha256 of each file, checked against
 * Cloudflare's release notes (for a .tgz, `inner` is the binary inside, the hash the notes list).
 * To update: `gh release view <tag> -R cloudflare/cloudflared`, then download and hash each asset.
 */
export const CLOUDFLARED = {
  version: '2026.9.3',
  assets: {
    'cloudflared-linux-amd64': { sha256: '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2' },
    'cloudflared-linux-arm64': { sha256: 'aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d' },
    'cloudflared-linux-arm': { sha256: '967dc371a3fedbf09e881c13ee7ba317155ebc336cbd4afb756b46fc6785e5af' },
    'cloudflared-darwin-amd64.tgz': { sha256: 'd1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977', inner: 'ab588b3b4db9cdb4476c30a3db2a72635b1d8327d44741fee6799a0f37b0ec07' },
    'cloudflared-darwin-arm64.tgz': { sha256: '587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095', inner: '5472c1a01c84bc31b3021056a73b4e5774ddddefc572124ea8fdf6c340639f32' },
    // there is no Windows arm64 build; the x64 one runs under emulation
    'cloudflared-windows-amd64.exe': { sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2' },
  } as Record<string, { sha256: string; inner?: string }>,
}

export function cloudflaredAsset(platform: string = os.platform(), cpu: string = os.arch()) {
  const arch = cpu === 'arm64' ? 'arm64' : cpu === 'arm' ? 'arm' : 'amd64'
  if (platform === 'win32') return 'cloudflared-windows-amd64.exe'
  if (platform === 'darwin') return `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`
  return `cloudflared-linux-${arch}`
}

const sha256 = (data: Uint8Array) => crypto.createHash('sha256').update(data).digest('hex')

/** cloudflared from PATH, or the pinned release downloaded once into ~/.inyon/bin. */
async function cloudflared(): Promise<string> {
  const onPath = Bun.which('cloudflared')
  if (onPath) return onPath
  const bin = path.join(binDir(), WIN ? 'cloudflared.exe' : 'cloudflared')
  if (existsSync(bin)) return bin
  const asset = cloudflaredAsset()
  const want = CLOUDFLARED.assets[asset]!
  console.log(`downloading cloudflared ${CLOUDFLARED.version} (${asset}) for the tunnel…`)
  const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED.version}/${asset}`)
  if (!res.ok) throw new Error(`couldn't download cloudflared: ${res.status}`)
  const data = new Uint8Array(await res.arrayBuffer())
  if (sha256(data) !== want.sha256) throw new Error(`the cloudflared download didn't match its pinned checksum`)
  mkdirSync(path.dirname(bin), { recursive: true })
  // everything happens in a folder of its own; only a checked binary is moved into place
  const tmp = mkdtempSync(path.join(path.dirname(bin), '.cloudflared-'))
  try {
    let file = path.join(tmp, 'cloudflared')
    if (asset.endsWith('.tgz')) {
      writeFileSync(path.join(tmp, 'download.tgz'), data)
      const out = path.join(tmp, 'out')
      mkdirSync(out)
      const p = Bun.spawn(['tar', '-xzf', path.join(tmp, 'download.tgz'), '-C', out], { stderr: 'pipe' })
      if ((await p.exited) !== 0) throw new Error("couldn't unpack cloudflared")
      file = path.join(out, 'cloudflared')
      if (!existsSync(file) || sha256(readFileSync(file)) !== want.inner) throw new Error(`the unpacked cloudflared didn't match its pinned checksum`)
    } else writeFileSync(file, data)
    if (!WIN) chmodSync(file, 0o755)
    renameSync(file, bin)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return bin
}

// cloudflared outlives us unless told otherwise
const children = new Set<{ kill(): void }>()
const stopChildren = () => {
  for (const c of children) c.kill()
  children.clear()
}
process.on('exit', stopChildren)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => (stopChildren(), process.exit(0)))

/**
 * Reads one cloudflared run's stderr for its address. Only the first counts: after the banner,
 * cloudflared's log could carry a URL someone else chose (a request it logs), which mustn't be
 * published as this machine's address. A restarted cloudflared gets a new reader.
 */
export function tunnelAddressReader() {
  const dec = new TextDecoder()
  let carry = ''
  let found = false
  return (chunk: Uint8Array): string | undefined => {
    if (found) return
    carry += dec.decode(chunk, { stream: true })
    const m = carry.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    if (m) {
      found = true
      carry = ''
      return `wss://${new URL(m[0]).host}/link`
    }
    if (carry.length > 65536) carry = carry.slice(-4096)
  }
}

/** Keeps a quick tunnel to the listener running; calls back with each new public address. */
function tunnel(port: number, onUrl: (url: string | undefined) => void) {
  let attempt = 0
  const run = async () => {
    let bin: string
    try {
      bin = await cloudflared()
    } catch (err) {
      console.error(`tunnel: ${(err as Error).message}`)
      return setTimeout(run, backoff(attempt++, 10_000, 300_000))
    }
    const p = Bun.spawn([bin, 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdout: 'ignore', stderr: 'pipe', windowsHide: true } as any)
    children.add(p)
    const started = Date.now()
    ;(async () => {
      const address = tunnelAddressReader()
      // read to the end even after the address, so cloudflared never blocks on a full pipe
      for await (const chunk of p.stderr as unknown as ReadableStream<Uint8Array>) {
        const url = address(chunk)
        if (url) onUrl(url)
      }
    })().catch(() => {})
    await p.exited
    children.delete(p)
    onUrl(undefined)
    // quick tunnels are rate limited; back off if it keeps dying young, even after it gave an
    // address, and start over only after a run that lasted
    if (Date.now() - started > 60_000) attempt = 0
    const delay = Date.now() - started > 60_000 ? 2000 + backoff(0, 2000, 2000) : backoff(attempt++, 5000, 300_000)
    console.log(`tunnel stopped; restarting in ${Math.round(delay / 1000)}s`)
    setTimeout(run, delay)
  }
  run()
}

// ---------- relays ----------

/** Keeps one socket to a relay; each phone that connects through it becomes a session. */
function relay(id: Identity, url: string, onState: (up: boolean) => void) {
  let attempt = 0
  const connect = () => {
    let readyAt: number | undefined
    const ws = new WebSocket(relayWs(url, machinePath(id.id)))
    ws.binaryType = 'arraybuffer'
    const sessions = new Map<number, Wire>()
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        const { sid, data } = unframe(new Uint8Array(e.data as ArrayBuffer))
        sessions.get(sid)?.onmessage?.(data.slice())
        return
      }
      let m: RelayToMachine
      try {
        m = JSON.parse(e.data)
      } catch {
        return
      }
      if (m.t === 'challenge') {
        ws.send(JSON.stringify({ t: 'auth', id: id.id, sig: Buffer.from(sign(id, authMessage(m.nonce))).toString('base64') }))
      } else if (m.t === 'ready') {
        readyAt = Date.now()
        console.log(`relay ${new URL(url).host}: connected`)
        onState(true)
      } else if (m.t === 'open') {
        const sid = m.sid
        const wire: Wire = {
          send: (d) => ws.readyState === WebSocket.OPEN && ws.send(frame(sid, d)),
          close: () => {
            sessions.delete(sid)
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'close', sid }))
          },
        }
        sessions.set(sid, wire)
        session(id, wire, `relay ${new URL(url).host}`)
      } else if (m.t === 'close') {
        const w = sessions.get(m.sid)
        sessions.delete(m.sid)
        w?.onclose?.(1000, 'phone left')
      }
    }
    ws.onclose = (e) => {
      for (const w of sessions.values()) w.onclose?.(1001, 'relay disconnected')
      sessions.clear()
      onState(false)
      // a relay that lets the machine in and drops it at once keeps being backed off from
      attempt = attemptAfter(attempt, readyAt)
      const delay = backoff(attempt++, 1000, 60_000)
      console.log(`relay ${new URL(url).host}: disconnected (${e.code}); retrying in ${Math.round(delay / 1000)}s`)
      setTimeout(connect, delay)
    }
    ws.onerror = () => {}
  }
  connect()
}

// ---------- the service ----------

/**
 * Publishes until a relay takes the record, backing off from `base` up to 60 times that with
 * jitter: the phone only learns a new tunnel address from pkarr, so a failed publish can't wait for
 * the 30-minute republish. Stops (undefined) when `wanted` says a newer record took over.
 */
export async function publishUntilTaken(relays: string[], id: Identity, rec: { urls: string[]; relays: string[] }, lastSeq: number | undefined, base: number, wanted: () => boolean, fetcher: typeof fetch = fetch) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await publish(id, rec, relays, fetcher, lastSeq)
    } catch (e) {
      if (!wanted()) return
      const delay = backoff(attempt, base, base * 60)
      console.error(`publish: ${(e as Error).message}; trying again in ${Math.round(delay / 1000)}s`)
      await Bun.sleep(delay)
      if (!wanted()) return
    }
  }
}

/**
 * The typed code's record is signed with a key anyone who saw the ID and code can work out, so
 * they could publish a newer one naming their own computer, and a phone typing the code would pair
 * with theirs. While a code is open, the link looks at the record now and then: once it names
 * another computer, the code stops working here (the QR code, which names this machine itself,
 * still does). What it said, when it stopped the code.
 */
export async function watchShortCode(machine: string, relays: string[] = PKARR_RELAYS, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  const pairing = readJson<{ short?: string; expires?: number }>('pairing.json', {})
  if (!pairing.short || (pairing.expires ?? 0) <= Date.now()) return
  const [id = '', code = ''] = pairing.short.split(':')
  const codeId = shortCodeIds.get(pairing.short) ?? (await shortCodeIdentity({ id, code })).id
  shortCodeIds.clear()
  shortCodeIds.set(pairing.short, codeId)
  const rec = await resolve(codeId, relays, fetcher).catch(() => undefined)
  if (!rec || rec.machine === machine) return
  const stopped = withNodeFiles(() => {
    const now = readJson<{ short?: string }>('pairing.json', {})
    if (now.short !== pairing.short) return false
    try {
      writeJson('pairing.json', { ...now, short: undefined })
    } catch (err) {
      console.error(`couldn't save pairing.json: ${(err as Error).message}`)
      rmSync(file('pairing.json'), { force: true })
    }
    return true
  })
  if (!stopped) return
  const said = `Another computer was published under the pairing code ${formatShortId(id)}, so that code no longer works here (someone who saw it may be trying to pair your phone with their computer). The QR code still works, or run \`inyon pair\` for a new code.`
  console.error(said)
  return said
}
/** the code's identity takes scrypt to work out: kept for the code that's open */
const shortCodeIds = new Map<string, string>()

export function startLink(config: LinkConfig) {
  const id = identity()
  listen(id, config.lan ? '0.0.0.0' : '127.0.0.1', config.port)
  let tunnelUrl: string | undefined
  let lastPublished = ''
  let lastSeq = currentState()?.lastSeq
  /** counts publishes started; a retrying one stops once a newer one has begun */
  let publishing = 0
  // private network address → its listener (with --lan, the one on 0.0.0.0 answers there already)
  const vpn = new Map<string, { stop(): void }>()

  const update = () => {
    const urls = [
      ...new Set([
        ...(tunnelUrl ? [tunnelUrl] : []),
        ...config.urls,
        ...[...vpn.keys()].map((ip) => `ws://${ip}:${config.port}/link`),
        ...(config.lan ? lanUrls(config.port) : []),
      ]),
    ]
    const state: State = { urls, relays: config.relays, updatedAt: Date.now(), pid: process.pid, version: VERSION, lastSeq }
    withNodeFilesWithin(LINK_WAIT, () => writeJson('state.json', state), () => undefined)
    const key = JSON.stringify({ urls, relays: config.relays })
    if (key === lastPublished || (!urls.length && !config.relays.length)) return
    lastPublished = key
    const mine = ++publishing
    publishUntilTaken(PKARR_RELAYS, id, { urls, relays: config.relays }, lastSeq, 10_000, () => publishing === mine).then((seq) => {
      if (seq === undefined) return
      lastSeq = seq
      withNodeFilesWithin(LINK_WAIT, () => writeJson('state.json', { ...(currentState() ?? state), lastSeq }), () => undefined)
      console.log(`published: ${[...urls, ...config.relays].join(' ') || 'nothing'}`)
    })
  }

  if (config.tunnel) {
    tunnel(config.port, (url) => {
      tunnelUrl = url
      if (url) console.log(`tunnel: ${url}`)
      update()
    })
  }
  for (const r of config.relays) relay(id, r, () => update())
  // notifications for paired browsers while their page is closed
  startPush()
  // an open short code whose record someone else took over stops working
  setInterval(() => void watchShortCode(id.id).catch(() => {}), 20_000)

  // networks come and go (NetBird often connects after this starts), so look again now and then
  const networks = async () => {
    const nets = await detectNetworks().catch(() => [] as Network[])
    const ips = new Set(nets.map((n) => n.ip))
    let changed = false
    for (const [ip, server] of vpn) {
      if (ips.has(ip)) continue
      server.stop()
      vpn.delete(ip)
      changed = true
    }
    for (const n of nets) {
      if (vpn.has(n.ip)) continue
      try {
        vpn.set(n.ip, config.lan ? { stop() {} } : listen(id, n.ip, config.port))
        console.log(`${LABEL[n.kind]}: answering on ${n.ip}`)
        changed = true
      } catch (err) {
        console.error(`${LABEL[n.kind]}: can't listen on ${n.ip}:${config.port}: ${(err as Error).message}`)
      }
    }
    if (changed) update()
  }
  if (config.vpn) {
    void networks()
    setInterval(() => void networks(), 2 * 60_000)
  }
  update()
  // pkarr records age out of the DHT after a few hours
  setInterval(() => {
    lastPublished = ''
    update()
  }, 30 * 60_000)
  console.log(`inyon ${VERSION} link service for ${id.id} on port ${config.port}${config.lan ? ' (LAN too)' : ''}`)
  return id
}
