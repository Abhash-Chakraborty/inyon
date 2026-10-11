#!/usr/bin/env bun
/**
 * tether-node: lets Tether reach this machine without opening any ports.
 *
 *   tether-node                        set up: install the link as a background service, show a code
 *   tether-node pair                   show a code to pair the phone app with this machine
 *   tether-node link [options]         run the phone link (pair starts it too):
 *       --lan / --no-lan               also answer on this machine's LAN addresses
 *       --tunnel / --no-tunnel         open a free Cloudflare tunnel so any network works (on)
 *       --relay <url>                  keep a connection to a Tether relay (repeatable)
 *       --port <n>                     local port (4780)
 *   tether-node phones                 list paired phones
 *   tether-node forget <name|key>      unpair a phone
 *   tether-node <hub-url> <token>      connect to a Tether hub instead (from its "Add a machine")
 *
 * The phone link is end-to-end encrypted; tunnels and relays only carry ciphertext. For a hub,
 * plain http:// is only accepted for private addresses (localhost, LAN, Tailscale/NetBird).
 */
import os from 'node:os'
import path from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { renderUnicodeCompact } from 'uqr'
import { formatShortId, pairLink, publishShortCode } from '@tether/link'
import { serveOps, WIN } from './ops.ts'
import { currentState, forgetPhone, identity, listPhones, loadConfig, newPairing, saveConfig, startLink, VERSION, type LinkConfig } from './link.ts'
import { ensureShell, installService, missingMux, uninstallService } from './service.ts'

// run in the background (a service, a hidden task) there's no console to print to: log to a file.
// Commands people run (setup, pair…) always print, even from a script, so the pairing code shows.
const INTERACTIVE = new Set(['setup', 'pair', 'install', 'uninstall', 'phones', 'forget', 'version', '--version', 'help', '--help', '-h'])
const firstArg = process.argv[2]
if (WIN && !process.stdout.isTTY && !(firstArg && INTERACTIVE.has(firstArg))) {
  const log = path.join(os.homedir(), '.tether-node', firstArg === 'link' ? 'link.log' : 'node.log')
  const write = (...a: unknown[]) => {
    try {
      appendFileSync(log, `${new Date().toISOString()} ${a.map(String).join(' ')}\n`)
    } catch {}
  }
  console.log = write
  console.error = write
}

function readEnvFile(file: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(file, 'utf8').split(/\r?\n/).flatMap((l) => {
        const m = l.match(/^(\w+)=(.*)$/)
        return m ? [[m[1], m[2]]] : []
      }),
    )
  } catch {
    return {}
  }
}

function isPrivate(url: URL) {
  const h = url.hostname
  // IPv6 literals: loopback, unique-local (fc00::/7, Tailscale uses fd7a:115c:a1e0::/48), link-local
  if (h.startsWith('[')) return /^\[(::1|f[cd][0-9a-f]{0,2}:|fe[89ab][0-9a-f]?:)/i.test(h)
  if (h === 'localhost' || h === '::1' || /^127\./.test(h)) return true
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true // CGNAT range used by Tailscale and NetBird
  if (/\.(ts\.net|netbird\.cloud|netbird\.selfhosted|local|lan|internal)$/.test(h)) return true
  return !h.includes('.') // single-label names on your private network
}

/** Hub mode: one outbound WebSocket to the hub, running what it asks for as this user. */
function hubMode(hubArg?: string, tokenArg?: string) {
  // the installers keep the hub address and token in ~/.tether-node/env (mode 600), so the token
  // never sits in the process list where other users could read it
  const saved = readEnvFile(path.join(os.homedir(), '.tether-node', 'env'))
  const hub = (hubArg ?? process.env.TETHER_HUB ?? saved.TETHER_HUB ?? '').replace(/\/+$/, '')
  const token = tokenArg ?? process.env.TETHER_TOKEN ?? saved.TETHER_TOKEN ?? ''

  if (!hub || !token) {
    console.error(USAGE)
    process.exit(2)
  }

  const url = new URL(hub)
  if (url.protocol === 'http:' && !isPrivate(url) && !process.env.TETHER_ALLOW_INSECURE) {
    console.error(`Refusing to send the token over plain http to ${url.hostname}. Use https, or a private network address.`)
    process.exit(2)
  }
  const wsUrl = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/node`

  function connect(attempt = 0) {
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } } as any)
    const send = (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))
    const ops = serveOps(send)

    ws.onopen = () => {
      attempt = 0
      console.log(`connected to ${url.host}`)
      send({ type: 'hello', version: VERSION, os: `${os.platform()} ${os.arch()}`, hostname: os.hostname(), platform: os.platform(), mux: WIN ? 'psmux' : 'tmux' })
    }

    ws.onmessage = async (e) => {
      let m: any
      try {
        m = JSON.parse(String(e.data))
      } catch {
        return
      }
      ops.message(m)
    }

    ws.onclose = (e) => {
      ops.close()
      if (e.code === 4001) {
        console.log('This machine was removed from Tether. Exiting.')
        process.exit(0)
      }
      if (e.code === 4003) {
        console.error('The hub rejected the token. Pair this machine again from the hub.')
        process.exit(1)
      }
      const delay = Math.min(30_000, 1000 * 2 ** attempt)
      console.log(`disconnected (${e.code}); retrying in ${Math.round(delay / 1000)}s`)
      setTimeout(() => connect(attempt + 1), delay)
    }
    ws.onerror = () => {}
  }

    connect()
}

// ---------- the phone link ----------

const running = () => {
  const pid = currentState()?.pid
  if (!pid || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Reads link options; what you pass is saved, so the service keeps them on its next start. */
function linkOptions(args: string[]): LinkConfig {
  const c = loadConfig()
  const given = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--lan' || a === '--no-lan') c.lan = a === '--lan'
    else if (a === '--tunnel' || a === '--no-tunnel') c.tunnel = a === '--tunnel'
    else if (a === '--port' && /^\d+$/.test(args[i + 1] ?? '')) c.port = Number(args[++i])
    else if (a === '--relay' && args[i + 1]) {
      const r = args[++i]!.replace(/\/+$/, '')
      if (!/^https?:\/\//.test(r)) fail(`--relay needs an http(s) address, not ${r}`)
      if (!given.has('relay')) c.relays = []
      given.add('relay')
      c.relays.push(r)
    } else if (a === '--no-relay') c.relays = []
    else fail(`unknown option ${a}`)
  }
  saveConfig(c)
  return c
}

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

/**
 * Shows the pairing code; starts the link here first if it isn't running yet. True when the link
 * runs elsewhere, so this process has nothing left to do.
 */
async function pair(args: string[]) {
  const config = linkOptions(args)
  const service = running()
  if (!service) startLink(config)
  const { secret, short } = newPairing()
  // wait for an address the phone can use (the tunnel takes a few seconds to come up)
  const wanted = config.tunnel || config.lan || config.relays.length
  for (let i = 0; wanted && i < 60; i++) {
    const s = currentState()
    if (s && (s.urls.length || s.relays.length) && (service || s.pid === process.pid)) break
    await Bun.sleep(500)
  }
  const s = currentState()
  const where = { urls: s?.urls ?? [], relays: s?.relays ?? [] }
  const link = pairLink({ id: identity().id, secret, name: os.hostname(), ...where })
  // the typed-in code needs the relays to know this ID; without them there's still the QR code
  const typed = await Promise.race([publishShortCode(short, { machine: identity().id, name: os.hostname(), ...where }).then(() => true, () => false), new Promise<false>((r) => setTimeout(r, 8000, false).unref())])
  console.log(`\nScan this with the Tether app (Add a computer → Scan the code), within 10 minutes:\n`)
  console.log(renderUnicodeCompact(link, { border: 2 }))
  if (typed) console.log(`\nCan't scan it? Choose "Type a code" in the app and enter\n\n    ID    ${formatShortId(short.id)}\n    Code  ${short.code.slice(0, 3)} ${short.code.slice(3)}\n`)
  console.log(`\nOr paste this link into the app:\n${link}\n`)
  if (!s?.urls.length && !s?.relays.length) console.log('No address yet: the phone will look this machine up once its tunnel is up.\n')
  if (service) return true
  console.log('Keep this running so the phone can connect, or run `tether-node install` to keep it running in the background.')
}

/**
 * The one step a new laptop needs (also what a double-click does): keep the link running in the
 * background, check for tmux, and show the pairing code.
 */
async function setup() {
  console.log(`tether-node ${VERSION}: setting up this ${process.platform === 'darwin' ? 'Mac' : 'machine'} for the Tether app\n`)
  const mux = missingMux()
  const already = running()
  const svc = already ? { ok: true, how: '' } : installService()
  if (svc.ok) {
    console.log(already ? '✓ Already running in the background' : `✓ Runs in the background as ${svc.how}.`)
    // wait for the service to come up before asking it for a code
    for (let i = 0; i < 20 && !running(); i++) await Bun.sleep(500)
  } else console.log(`! Couldn't set up a background service (${svc.how}). Keep this window open instead.`)
  if (mux) console.log(`! ${mux}`)
  else console.log(WIN ? '✓ psmux (tmux for Windows) is installed' : '✓ tmux is installed')
  await pair([])
  if (svc.ok) {
    console.log('Paired phones connect by themselves from now on. To pair another phone later, run `tether-node pair`.')
    await pause()
    // the service has it from here; don't wait on a slow relay before giving the terminal back
    process.exit(0)
  }
}

/** A window opened by double-clicking closes as soon as the program ends: keep it until Enter. */
async function pause() {
  if (!WIN || !process.stdin.isTTY || process.env.TETHER_NO_PAUSE) return
  console.log('\nPress Enter to close this window. Tether keeps running in the background.')
  for await (const _ of console) break
}

function phones() {
  const all = Object.entries(listPhones())
  if (!all.length) return console.log('No phones paired yet. Run `tether-node pair`.')
  for (const [key, p] of all) {
    const seen = p.lastSeen ? new Date(p.lastSeen).toLocaleString() : 'never'
    console.log(`${p.name.padEnd(24)} ${key.slice(0, 12)}  paired ${new Date(p.pairedAt).toLocaleDateString()}, last seen ${seen}`)
  }
}

function forget(which?: string) {
  if (!which) fail('usage: tether-node forget <name|key>')
  const matches = Object.entries(listPhones()).filter(([key, p]) => key.startsWith(which.toLowerCase()) || p.name === which)
  if (matches.length !== 1) fail(matches.length ? `"${which}" matches ${matches.length} phones; use more of the key` : `No paired phone matches "${which}"`)
  forgetPhone(matches[0]![0])
  console.log(`Forgot ${matches[0]![1].name}. It can't connect until it pairs again.`)
}

const USAGE = `tether-node ${VERSION}

  tether-node                       set up this machine: run in the background and show a code
  tether-node pair                  show a code to pair the phone app with this machine
  tether-node link [options]        run the phone link (pair starts it too)
      --lan / --no-lan              also answer on this machine's LAN addresses
      --tunnel / --no-tunnel        open a free Cloudflare tunnel so any network works (on)
      --relay <url> / --no-relay    keep a connection to a Tether relay (repeatable)
      --port <n>                    local port (4780)
  tether-node install / uninstall   start or stop running in the background (at login)
  tether-node phones                list paired phones
  tether-node forget <name|key>     unpair a phone
  tether-node <hub-url> <token>     connect to a Tether hub instead`

const [cmd, ...rest] = process.argv.slice(2)
const hubSaved = !!(process.env.TETHER_HUB || readEnvFile(path.join(os.homedir(), '.tether-node', 'env')).TETHER_HUB)
if (cmd === 'pair') {
  await ensureShell()
  if (await pair(rest)) process.exit(0)
} else if (cmd === 'link') {
  if (running()) fail(`The link is already running (pid ${currentState()!.pid}).`)
  await ensureShell()
  startLink(linkOptions(rest))
} else if (cmd === 'setup' || (!cmd && !hubSaved)) {
  await ensureShell().catch((err) => console.log(`! ${(err as Error).message}`))
  await setup()
} else if (cmd === 'install') {
  const r = installService()
  console.log(r.ok ? `tether-node runs in the background as ${r.how}.` : `Couldn't install the service: ${r.how}`)
  if (!r.ok) process.exit(1)
} else if (cmd === 'uninstall') {
  const how = uninstallService().how
  // started without a service manager (or by hand): stop the copy that's still running
  if (running()) {
    try {
      process.kill(currentState()!.pid!)
    } catch {}
  }
  console.log(`tether-node stopped; ${how}. Your pairings are kept.`)
}
else if (cmd === 'phones') phones()
else if (cmd === 'forget') forget(rest[0])
else if (cmd === 'version' || cmd === '--version') console.log(VERSION)
else if (cmd === 'help' || cmd === '--help' || cmd === '-h') console.log(USAGE)
else hubMode(cmd, rest[0])
