#!/usr/bin/env bun
/**
 * inyon: lets the Inyon app reach this machine without opening any ports, and runs the hub.
 *
 *   inyon                          set up: run the phone link in the background and show a code
 *   inyon pair                     show a code to pair the phone app with this machine
 *   inyon link [options]           run the phone link (pair starts it too):
 *       --lan / --no-lan           also answer on this machine's LAN addresses
 *       --vpn / --no-vpn           also answer on Tailscale, NetBird, ZeroTier, WireGuard (on)
 *       --tunnel / --no-tunnel     open a free Cloudflare tunnel so any network works (on)
 *       --url <wss://…>            publish an address of your own, like tailscale serve's (repeatable)
 *       --relay <url>              keep a connection to an Inyon relay (repeatable)
 *       --port <n>                 local port (4780)
 *   inyon phones                   list paired phones
 *   inyon forget <name|key>        unpair a phone
 *   inyon push                     list the browsers this machine sends notifications to
 *   inyon join <hub-url>           add this machine to an Inyon hub (its "Add a machine" command
 *                                  runs this), with the token in INYON_TOKEN
 *   inyon connect                  run the connection to that hub
 *   inyon hub                      run the hub (`inyon hub install` keeps it running)
 *   inyon update                   get the newest version and restart what runs in the background
 *
 * The phone link is end-to-end encrypted; tunnels and relays only carry ciphertext. For a hub,
 * plain http:// is only accepted for private addresses (localhost, LAN, Tailscale/NetBird).
 */
import os from 'node:os'
import path from 'node:path'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { renderUnicodeCompact } from 'uqr'
import { formatShortId, pairLink, publishShortCode } from '@inyon/link'
import { WEB_URL } from '@inyon/protocol'
import { detectNetworks, LABEL } from '../hub/src/networks.ts'
import { serveOps, WIN } from './ops.ts'
import { currentState, forgetPhone, identity, listPhones, loadConfig, newPairing, saveConfig, startLink, VERSION, type LinkConfig } from './link.ts'
import { nodeDir, savedEnv } from './paths.ts'
import { detach, detachUpdate, ensureShell, forgetUpdateTask, hasService, installService, logFile, missingMux, moveOldService, oldServices, restartService, ROLES, self, uninstallService, type Role } from './service.ts'
import { cleanupOld, exited, findInstall, isRunning, runningFile, setStatus, staleLink, update, UpdateError, waitStarted } from './update.ts'

// run in the background (a service, a hidden task) there's no console to print to: log to a file.
// Commands people run (setup, pair…) always print, even from a script, so the pairing code shows.
const INTERACTIVE = new Set(['setup', 'pair', 'join', 'install', 'uninstall', 'phones', 'forget', 'update', 'version', '--version', 'help', '--help', '-h'])
const firstArg = process.argv[2]
if (WIN && !process.stdout.isTTY && !(firstArg && INTERACTIVE.has(firstArg))) {
  const log = firstArg === 'link' ? logFile('link') : firstArg === 'migrate' ? path.join(nodeDir(), 'update.log') : logFile('node')
  const write = (...a: unknown[]) => {
    try {
      appendFileSync(log, `${new Date().toISOString()} ${a.map(String).join(' ')}\n`)
    } catch {}
  }
  console.log = write
  console.error = write
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

/** The hub connection: one outbound WebSocket to the hub, running what it asks for as this user. */
function connectMode(hubArg?: string, tokenArg?: string) {
  // the installers keep the hub address and token in the node's folder (readable only by you), so
  // the token never sits in the process list where other users could read it
  const saved = savedEnv()
  const hub = (hubArg ?? process.env.INYON_HUB ?? saved.INYON_HUB ?? '').replace(/\/+$/, '')
  const token = tokenArg ?? process.env.INYON_TOKEN ?? saved.INYON_TOKEN ?? ''
  if (!process.env.INYON_SH && saved.INYON_SH) process.env.INYON_SH = saved.INYON_SH

  if (!hub || !token) {
    console.error(USAGE)
    process.exit(2)
  }
  if (tokenArg) console.error('Note: a token given as an argument shows in the process list. Prefer INYON_TOKEN=<token> inyon join <hub-url>.')

  const url = hubUrl(hub)
  const wsUrl = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/node`
  // who's running, for `inyon update` and the hub's update script: they wait for this file to name
  // the new version, and stop the copy it names when there's no service manager
  try {
    mkdirSync(nodeDir(), { recursive: true })
    writeFileSync(runningFile('node'), JSON.stringify({ pid: process.pid, version: VERSION }))
  } catch {}
  laterMoveOldServices()

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
        console.log('This machine was removed from Inyon. Exiting.')
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

/** Checks a hub address; refuses to send a token over plain http to a public address. */
function hubUrl(hub: string) {
  let url: URL
  try {
    url = new URL(hub)
  } catch {
    fail(`${hub} isn't a web address.`)
  }
  if (url.protocol === 'http:' && !isPrivate(url) && !process.env.INYON_ALLOW_INSECURE) fail(`Refusing to send the token over plain http to ${url.hostname}. Use https, or a private network address.`)
  return url
}

/**
 * `inyon join <hub-url>`, what the hub's "Add a machine" command runs: saves the hub and token
 * (readable only by you) and runs the connection in the background.
 */
async function join(hubArg?: string) {
  const hub = (hubArg ?? '').replace(/\/+$/, '')
  const token = process.env.INYON_TOKEN ?? ''
  if (!hub || !token) fail('usage: INYON_TOKEN=<token> inyon join <hub-url>')
  hubUrl(hub)
  await ensureShell().catch((err) => console.log(`! ${(err as Error).message}`))
  mkdirSync(nodeDir(), { recursive: true, mode: 0o700 })
  const lines = [`INYON_HUB=${hub}`, `INYON_TOKEN=${token}`, ...(WIN && process.env.INYON_SH ? [`INYON_SH=${process.env.INYON_SH}`] : [])]
  const file = path.join(nodeDir(), WIN ? '.env' : 'env')
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 })
  // the other file name may hold a token from an earlier pairing
  rmSync(path.join(nodeDir(), WIN ? 'env' : '.env'), { force: true })
  if (WIN) Bun.spawnSync(['icacls', file, '/inheritance:r', '/grant:r', `${os.userInfo().username}:(R,W)`, 'SYSTEM:(F)'], { stdout: 'ignore', stderr: 'ignore' })
  for (const role of oldServices()) if (role === 'node') moveOldService(role)
  const mux = missingMux()
  if (mux) console.log(`Note: ${mux}`)
  const r = installService('node', true)
  if (!r.ok) fail(`Couldn't run the connection in the background (${r.how}). Run \`inyon connect\` to connect now.`)
  console.log(`inyon is connecting to ${new URL(hub).host}. It runs as ${r.how}.`)
}

/**
 * A machine set up before the rename to Inyon keeps its tether-node services until this version
 * runs: a couple of minutes after it starts (an update that's still checking this copy came up
 * has finished by then), it moves them to inyon's own names, from a process of its own.
 */
function laterMoveOldServices() {
  if (self().length > 1) return
  setTimeout(() => {
    try {
      if (!oldServices().length) return
      const r = detach([...self(), 'migrate'])
      console.log(r.ok ? `moving the services set up before the rename to Inyon (${r.how})` : `couldn't move the old services yet: ${r.how}`)
    } catch (err) {
      console.log(`couldn't move the old services yet: ${(err as Error).message}`)
    }
  }, 2 * 60_000).unref()
}

/** `inyon migrate`: moves every job from its tether-node service to inyon's own. */
function migrate() {
  const lock = path.join(nodeDir(), 'migrate.lock')
  try {
    mkdirSync(nodeDir(), { recursive: true })
    writeFileSync(lock, String(process.pid), { flag: 'wx' })
  } catch {
    return console.log('another copy is moving the old services already')
  }
  try {
    for (const role of oldServices()) {
      const r = moveOldService(role)
      console.log(`${new Date().toISOString()} ${role}: ${r.ok ? `moved; it runs as ${r.how}` : `not moved (${r.how})`}`)
    }
  } finally {
    rmSync(lock, { force: true })
    forgetUpdateTask()
  }
}

// ---------- the phone link ----------

const running = () => {
  const pid = currentState()?.pid
  if (!pid || pid === process.pid) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return !exited(pid)
}

/** Reads link options; what you pass is saved, so the service keeps them on its next start. */
function linkOptions(args: string[]): LinkConfig {
  const c = loadConfig()
  const given = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--lan' || a === '--no-lan') c.lan = a === '--lan'
    else if (a === '--vpn' || a === '--no-vpn') c.vpn = a === '--vpn'
    else if (a === '--url' && args[i + 1]) {
      const u = args[++i]!
      if (!/^wss?:\/\/[^/]+\/link$/.test(u)) fail(`--url needs a WebSocket address ending in /link, like wss://laptop.tail1234.ts.net:8443/link, not ${u}`)
      if (!given.has('url')) c.urls = []
      given.add('url')
      c.urls.push(u)
    } else if (a === '--no-url') c.urls = []
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
  // wait for an address the phone can use (the tunnel takes a few seconds to come up). A private
  // network's ws:// address comes first, but browsers only open wss://, so wait for the tunnel too
  const wanted = config.tunnel || config.lan || config.vpn || config.urls.length || config.relays.length
  const enough = (s: { urls: string[]; relays: string[] }) => s.relays.length > 0 || (config.tunnel ? s.urls.some((u) => u.startsWith('wss://')) : s.urls.length > 0)
  for (let i = 0; wanted && i < 60; i++) {
    const s = currentState()
    if (s && enough(s) && (service || s.pid === process.pid)) break
    await Bun.sleep(500)
  }
  const s = currentState()
  const where = { urls: s?.urls ?? [], relays: s?.relays ?? [] }
  const info = { id: identity().id, secret, name: os.hostname(), ...where }
  const link = pairLink(info)
  // the QR code opens the web app when scanned with a phone's camera; the Inyon app reads it too.
  // INYON_WEB_URL points it at a copy of the web app you host yourself
  const qr = pairLink(info, process.env.INYON_WEB_URL || WEB_URL)
  // the typed-in code needs the relays to know this ID; without them there's still the QR code
  const typed = await Promise.race([publishShortCode(short, { machine: identity().id, name: os.hostname(), ...where }).then(() => true, () => false), new Promise<false>((r) => setTimeout(r, 8000, false).unref())])
  console.log(`\nScan this with your phone's camera, or in the Inyon app (Add a computer → Scan the code), within 10 minutes:\n`)
  console.log(renderUnicodeCompact(qr, { border: 2 }))
  if (typed) console.log(`\nCan't scan it? Choose "Type a code" in the app and enter\n\n    ID    ${formatShortId(short.id)}\n    Code  ${short.code.slice(0, 3)} ${short.code.slice(3)}\n`)
  console.log(`\nOr paste this link into the app:\n${link}\n`)
  if (!s?.urls.length && !s?.relays.length) console.log('No address yet: the phone will look this machine up once its tunnel is up.\n')
  if (service) return true
  console.log('Keep this running so the phone can connect, or run `inyon install` to keep it running in the background.')
}

/**
 * The one step a new laptop needs (also what a double-click does): keep the link running in the
 * background, check for tmux, and show the pairing code.
 */
async function setup() {
  console.log(`inyon ${VERSION}: setting up this ${process.platform === 'darwin' ? 'Mac' : 'machine'} for the Inyon app\n`)
  const mux = missingMux()
  let svc: { ok: boolean; how: string }
  let note: string
  if (oldServices().includes('link')) {
    // set up before the rename to Inyon: the link moves to inyon's own service, running this version
    svc = moveOldService('link')
    note = `✓ Restarted with version ${VERSION}.`
  } else {
    // an older version still running (get.sh or get.ps1 run again to update): start this one instead
    const stale = running() && staleLink(currentState(), VERSION)
    const already = running() && !stale
    svc = already ? { ok: true, how: '' } : installService('link', stale)
    note = already ? '✓ Already running in the background' : stale ? `✓ Restarted with version ${VERSION}.` : `✓ Runs as ${svc.how}.`
  }
  if (svc.ok) {
    console.log(note)
    // wait for the service to come up before asking it for a code
    for (let i = 0; i < 20 && !running(); i++) await Bun.sleep(500)
  } else console.log(`! Couldn't set up a background service (${svc.how}). Keep this window open instead.`)
  if (mux) console.log(`! ${mux}`)
  else console.log(WIN ? '✓ psmux (tmux for Windows) is installed' : '✓ tmux is installed')
  if (loadConfig().vpn) for (const n of await detectNetworks()) console.log(`✓ ${LABEL[n.kind]}: the Android app on the same network connects straight to ${n.ip}`)
  await pair([])
  if (svc.ok) {
    console.log('Paired phones connect by themselves from now on. To pair another phone later, run `inyon pair`.')
    await pause()
    // the service has it from here; don't wait on a slow relay before giving the terminal back
    process.exit(0)
  }
}

/** A window opened by double-clicking closes as soon as the program ends: keep it until Enter. */
async function pause() {
  if (!WIN || !process.stdin.isTTY || process.env.INYON_NO_PAUSE) return
  console.log('\nPress Enter to close this window. Inyon keeps running in the background.')
  for await (const _ of console) break
}

function phones() {
  const all = Object.entries(listPhones())
  if (!all.length) return console.log('No phones paired yet. Run `inyon pair`.')
  for (const [key, p] of all) {
    const seen = p.lastSeen ? new Date(p.lastSeen).toLocaleString() : 'never'
    console.log(`${p.name.padEnd(24)} ${key.slice(0, 12)}  paired ${new Date(p.pairedAt).toLocaleDateString()}, last seen ${seen}`)
  }
}

function forget(which?: string) {
  if (!which) fail('usage: inyon forget <name|key>')
  const matches = Object.entries(listPhones()).filter(([key, p]) => key.startsWith(which.toLowerCase()) || p.name === which)
  if (matches.length !== 1) fail(matches.length ? `"${which}" matches ${matches.length} phones; use more of the key` : `No paired phone matches "${which}"`)
  forgetPhone(matches[0]![0])
  console.log(`Forgot ${matches[0]![1].name}. It can't connect until it pairs again.`)
}

const USAGE = `inyon ${VERSION}

  inyon                             set up this machine: run in the background and show a code
  inyon pair                        show a code to pair the phone app with this machine
  inyon link [options]              run the phone link (pair starts it too)
    --lan / --no-lan                also answer on this machine's LAN addresses
    --vpn / --no-vpn                also answer on Tailscale, NetBird, ZeroTier, WireGuard (on)
    --tunnel / --no-tunnel          open a free Cloudflare tunnel so any network works (on)
    --url <wss://…> / --no-url      publish an address of your own (repeatable)
    --relay <url> / --no-relay      keep a connection to an Inyon relay (repeatable)
    --port <n>                      local port (4780)
  inyon phones                      list paired phones
  inyon forget <name|key>           unpair a phone
  inyon push                        list the browsers this machine sends notifications to
  inyon join <hub-url>              add this machine to an Inyon hub, with the token in INYON_TOKEN
  inyon connect                     run the connection to that hub
  inyon hub                         run the hub
  inyon install [link|node|hub]     start running in the background (at login)
  inyon uninstall [link|node|hub]   stop running in the background
  inyon update                      get the newest version and restart what runs in the background`

/**
 * Gets the newest version and restarts what runs in the background with it. With --background
 * (how the app asks for it) the update runs on its own, since the restart ends the process that asked.
 */
async function updateCommand(args: string[]) {
  const cmd = self()
  setStatus('running')
  if (args.includes('--background')) {
    const r = detachUpdate(cmd)
    if (!r.ok) {
      setStatus(`failed: ${r.how}`)
      fail(`Couldn't start the update: ${r.how}`)
    }
    return console.log(`Updating inyon in the background (${r.how}). Progress goes to ${path.join(nodeDir(), 'update.log')}.`)
  }
  try {
    const roles = () => ROLES.filter((r) => hasService(r) || isRunning(r))
    const r = await update(findInstall(cmd), { version: VERSION, fetch, roles, restart: restartService, started: waitStarted, log: (l) => console.log(l) })
    setStatus(r.changed ? `done ${r.version ?? ''}`.trim() : `current ${VERSION}`)
    console.log(r.message)
  } catch (err) {
    const message = err instanceof UpdateError ? err.message : `The update failed: ${(err as Error).message}`
    setStatus(`failed: ${message}`)
    console.error(message)
    process.exitCode = 1
  } finally {
    forgetUpdateTask()
  }
}

/** The job `inyon install` or `uninstall` is about: the one named, or the one this machine has. */
function roleArg(arg: string | undefined, installing: boolean): Role {
  if (arg) {
    if (!(ROLES as string[]).includes(arg)) fail(`${arg} isn't one of ${ROLES.join(', ')}`)
    return arg as Role
  }
  if (savedEnv().INYON_HUB || process.env.INYON_HUB) return 'node'
  if (!installing) {
    const have = ROLES.filter((r) => hasService(r))
    if (have.length === 1) return have[0]!
  }
  return 'link'
}

const [cmd, ...rest] = process.argv.slice(2)
// copies an earlier update renamed aside (a running .exe can't be deleted until it has stopped)
cleanupOld(self().at(-1)!)
const joined = !!(process.env.INYON_HUB || savedEnv().INYON_HUB)
if (cmd === 'pair') {
  await ensureShell()
  if (await pair(rest)) process.exit(0)
} else if (cmd === 'link') {
  if (running()) fail(`The link is already running (pid ${currentState()!.pid}).`)
  await ensureShell()
  startLink(linkOptions(rest))
  laterMoveOldServices()
} else if (cmd === 'setup' || (!cmd && !joined)) {
  await ensureShell().catch((err) => console.log(`! ${(err as Error).message}`))
  await setup()
} else if (cmd === 'join') await join(rest[0])
else if (cmd === 'connect' || !cmd) {
  await ensureShell().catch((err) => console.log(`! ${(err as Error).message}`))
  connectMode(rest[0])
} else if (cmd === 'hub') {
  // a hub leaves itself out of the copies it builds for the machines it adds (see build.ts)
  if (process.env.INYON_NODE_ONLY) fail('This copy of inyon has no hub in it. Get the full program with get.sh --hub.')
  await (await import('./hub.ts')).hubCommand(rest)
}
else if (cmd === 'install') {
  const role = roleArg(rest[0], true)
  const r = installService(role, true)
  console.log(r.ok ? `inyon ${role} runs as ${r.how}.` : `Couldn't install the service: ${r.how}`)
  if (!r.ok) process.exit(1)
} else if (cmd === 'uninstall') {
  const role = roleArg(rest[0], false)
  const r = uninstallService(role)
  // the link started without a service manager (or by hand): stop the copy that's still running
  if (role === 'link' && running()) {
    try {
      process.kill(currentState()!.pid!)
    } catch {}
  }
  if (!r.ok) {
    console.error(`Couldn't remove everything: ${r.how}.${role === 'link' ? ' Your pairings are kept.' : ''}`)
    process.exit(1)
  }
  console.log(`inyon ${role} stopped; ${r.how}.${role === 'link' ? ' Your pairings are kept.' : ''}`)
} else if (cmd === 'update') await updateCommand(rest)
else if (cmd === 'migrate') migrate()
else if (cmd === 'phones') phones()
else if (cmd === 'forget') forget(rest[0])
else if (cmd === 'push') await (await import('./push.ts')).pushCommand(rest)
else if (cmd === 'version' || cmd === '--version') console.log(VERSION)
else if (cmd === 'help' || cmd === '--help' || cmd === '-h') console.log(USAGE)
// the form tether-node's installers used: a hub address, with the token in the environment
else if (/^https?:\/\//.test(cmd)) connectMode(cmd, rest[0])
else fail(USAGE)
