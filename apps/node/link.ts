import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import {
  accept, authMessage, frame, identityFromSeed, LinkError, machinePath, newIdentity, newShortCode, publish, relayWs, shortSecret, sign, unframe,
  type Identity, type RelayToMachine, type Wire,
} from '@tether/link'
import { serveOps, WIN } from './ops.ts'

/**
 * Lets the Tether phone app reach this machine directly, with no hub. The phone pairs once by
 * scanning a code (`tether-node pair`), then connects over an end-to-end encrypted link (Noise)
 * through whichever way works: a free Cloudflare quick tunnel this machine opens by itself (so
 * it works from any network), this machine's LAN address, or a relay you run. The tunnel and the
 * relay only ever carry ciphertext. The tunnel's address changes when it restarts, so the
 * machine publishes its current addresses under its own key (pkarr) and the phone looks them up.
 */

export const VERSION = '0.5.0'
const DIR = path.join(os.homedir(), '.tether-node')
const file = (name: string) => path.join(DIR, name)
const PAIR_MINUTES = 10

export interface LinkConfig {
  /** relays to keep a connection to, like https://relay.example.com */
  relays: string[]
  /** open a Cloudflare quick tunnel so phones on any network can connect */
  tunnel: boolean
  /** also listen on this machine's LAN addresses (otherwise only the tunnel and relays reach it) */
  lan: boolean
  port: number
}

export const DEFAULT_CONFIG: LinkConfig = { relays: [], tunnel: true, lan: false, port: 4780 }

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
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const tmp = `${file(name)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(tmp, file(name))
}

/** This machine's identity, made on first use. Its id is what the phone pairs with. */
export function identity(): Identity {
  const saved = readJson<{ seed?: string }>('identity.json', {})
  if (saved.seed) return identityFromSeed(Uint8Array.from(Buffer.from(saved.seed, 'hex')))
  const id = newIdentity()
  writeJson('identity.json', { seed: Buffer.from(id.seed).toString('hex'), id: id.id })
  return id
}

export const loadConfig = (): LinkConfig => ({ ...DEFAULT_CONFIG, ...readJson<Partial<LinkConfig>>('link.json', {}) })
export const saveConfig = (c: LinkConfig) => writeJson('link.json', c)

const phones = () => readJson<Record<string, Phone>>('phones.json', {})
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
  writeJson('pairing.json', { secret, short: shortSecret(short), expires: Date.now() + PAIR_MINUTES * 60_000 } satisfies Pairing)
  return { secret, short }
}

export const currentState = () => readJson<State | undefined>('state.json', undefined)

export function forgetPhone(key: string) {
  const all = phones()
  delete all[key]
  writeJson('phones.json', all)
}

export const listPhones = () => phones()

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
function check(remoteStatic: Uint8Array, hello: { name?: string; pair?: string }) {
  const key = hex(remoteStatic)
  const all = phones()
  if (all[key]) {
    all[key].lastSeen = Date.now()
    writeJson('phones.json', all)
    return welcome()
  }
  const pairing = readJson<Pairing>('pairing.json', {})
  const live = (pairing.expires ?? 0) > Date.now()
  const matches = (want?: string) => !!want && !!hello.pair && sameText(hello.pair, want)
  if (hello.pair && live && (matches(pairing.secret) || matches(pairing.short))) {
    all[key] = { name: String(hello.name ?? 'Phone').slice(0, 64), pairedAt: Date.now(), lastSeen: Date.now() }
    writeJson('phones.json', all)
    // one code, one phone
    rmSync(file('pairing.json'), { force: true })
    console.log(`paired with ${all[key].name}`)
    return welcome()
  }
  if (hello.pair && live && pairing.short) {
    // a wrong code: count it, and stop taking short codes before guessing could pay off
    const failures = (pairing.failures ?? 0) + 1
    writeJson('pairing.json', failures >= SHORT_TRIES ? { ...pairing, short: undefined, failures } : { ...pairing, failures })
    if (failures >= SHORT_TRIES) throw new LinkError('NOT_PAIRED', `Too many wrong codes, so that one no longer works. Run \`tether-node pair\` on ${os.hostname()} for a new one.`)
    throw new LinkError('NOT_PAIRED', `That code doesn't match. Check it against the one on ${os.hostname()} and try again.`)
  }
  if (hello.pair) throw new LinkError('NOT_PAIRED', `That pairing code has expired or was already used. Run \`tether-node pair\` on ${os.hostname()} for a new one.`)
  throw new LinkError('NOT_PAIRED', `This phone isn't paired with ${os.hostname()} any more. Run \`tether-node pair\` there and scan the code again.`)
}

/** One phone session: the encrypted handshake, then the same commands the hub sends. */
async function session(id: Identity, wire: Wire, via: string) {
  let channel
  try {
    ;({ channel } = await accept(wire, { noise: id.noise, check }))
  } catch (err) {
    if (!(err instanceof LinkError)) console.log(`refused a connection via ${via}: ${(err as Error).message}`)
    return
  }
  const ops = serveOps((m) => channel.send(m))
  channel.onmessage = (m) => {
    if (m?.op === 'ping') return channel.send({ type: 'pong', t: m.t })
    ops.message(m)
  }
  channel.onclose = () => ops.close()
}

// ---------- the local listener (behind the tunnel, and on the LAN if asked) ----------

function listen(id: Identity, config: LinkConfig) {
  type Data = { wire: Wire }
  const server = Bun.serve<Data>({
    hostname: config.lan ? '0.0.0.0' : '127.0.0.1',
    port: config.port,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/link') {
        const wire: Wire = { send() {}, close() {} }
        if (srv.upgrade(req, { data: { wire } })) return
        return new Response('Upgrade failed', { status: 400 })
      }
      return new Response('tether-node\n')
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
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => `ws://${a.address}:${port}/link`)
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

/** cloudflared from PATH, or the pinned release downloaded once into ~/.tether-node/bin. */
async function cloudflared(): Promise<string> {
  const onPath = Bun.which('cloudflared')
  if (onPath) return onPath
  const bin = path.join(DIR, 'bin', WIN ? 'cloudflared.exe' : 'cloudflared')
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

/** Keeps a quick tunnel to the listener running; calls back with each new public address. */
function tunnel(port: number, onUrl: (url: string | undefined) => void) {
  let attempt = 0
  const run = async () => {
    let bin: string
    try {
      bin = await cloudflared()
    } catch (err) {
      console.error(`tunnel: ${(err as Error).message}`)
      return setTimeout(run, Math.min(300_000, 10_000 * 2 ** attempt++))
    }
    const p = Bun.spawn([bin, 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdout: 'ignore', stderr: 'pipe', windowsHide: true } as any)
    children.add(p)
    const started = Date.now()
    ;(async () => {
      const dec = new TextDecoder()
      let carry = ''
      for await (const chunk of p.stderr as unknown as ReadableStream<Uint8Array>) {
        carry += dec.decode(chunk, { stream: true })
        const m = carry.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
        if (m) {
          attempt = 0
          onUrl(`wss://${new URL(m[0]).host}/link`)
          carry = ''
        } else if (carry.length > 65536) carry = carry.slice(-4096)
      }
    })().catch(() => {})
    await p.exited
    children.delete(p)
    onUrl(undefined)
    // quick tunnels are rate limited; back off if it keeps dying young
    const delay = Date.now() - started > 60_000 ? 2000 : Math.min(300_000, 5000 * 2 ** attempt++)
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
        attempt = 0
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
      const delay = Math.min(60_000, 1000 * 2 ** attempt++)
      console.log(`relay ${new URL(url).host}: disconnected (${e.code}); retrying in ${Math.round(delay / 1000)}s`)
      setTimeout(connect, delay)
    }
    ws.onerror = () => {}
  }
  connect()
}

// ---------- the service ----------

export function startLink(config: LinkConfig) {
  const id = identity()
  listen(id, config)
  let tunnelUrl: string | undefined
  let lastPublished = ''

  const update = () => {
    const urls = [...(tunnelUrl ? [tunnelUrl] : []), ...(config.lan ? lanUrls(config.port) : [])]
    const state: State = { urls, relays: config.relays, updatedAt: Date.now(), pid: process.pid }
    writeJson('state.json', state)
    const key = JSON.stringify({ urls, relays: config.relays })
    if (key === lastPublished || (!urls.length && !config.relays.length)) return
    lastPublished = key
    publish(id, { urls, relays: config.relays })
      .then(() => console.log(`published: ${[...urls, ...config.relays].join(' ') || 'nothing'}`))
      .catch((e) => {
        lastPublished = ''
        console.error(`publish: ${e.message}`)
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
  update()
  // pkarr records age out of the DHT after a few hours
  setInterval(() => {
    lastPublished = ''
    update()
  }, 30 * 60_000)
  console.log(`tether-node ${VERSION} link service for ${id.id} on port ${config.port}${config.lan ? ' (LAN too)' : ''}`)
  return id
}
