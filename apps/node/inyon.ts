#!/usr/bin/env bun
/**
 * inyon-engine: the program behind the inyon command (apps/cli). The command draws the setup,
 * the status screen and every answer, and it owns the background services and updates. It runs
 * this program for what has to run for long or touch the keys: the phone link, the connection
 * to a hub, the hub itself, and the pairing and phone records in ~/.inyon/node.
 *
 *   inyon-engine pair [options]      make a pairing code (starts the link here if none runs)
 *   inyon-engine link [options]      run the phone link
 *   inyon-engine phones              list paired phones
 *   inyon-engine forget <name|key>   unpair a phone
 *   inyon-engine push …              the browsers this machine sends notifications to
 *   inyon-engine join <hub-url>      save a hub's address and the token in INYON_TOKEN
 *   inyon-engine connect             run the connection to that hub
 *   inyon-engine hub                 run the hub
 *   inyon-engine hub code            show the setup code a new hub asks for
 *   inyon-engine hub reset-password  choose a new password for a forgotten one
 *   inyon-engine version             print the version
 *   inyon-engine hidden <program> …  run a program with no window and wait for it
 *
 * With --json a command answers in one JSON line (`{"v":1,…}`), which the command reads. The
 * phone link is end-to-end encrypted; tunnels and relays only carry ciphertext. For a hub, plain
 * http:// is only accepted for private addresses (localhost, LAN, Tailscale/NetBird).
 */
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { renderUnicodeCompact } from 'uqr'
import { formatShortId, pairLink, publishShortCode } from '@inyon/link'
import { INSTALL_URL, WEB_URL } from '@inyon/protocol'
import { ensureShell, serveOps, WIN } from './ops.ts'
import { privateHost } from './hub.ts'
import { startTidying } from './tidy.ts'
import { currentState, forgetPhone, identity, linkRunning, listPhones, loadConfig, newPairing, saveConfig, startLink, VERSION, type LinkConfig } from './link.ts'
import { argv, emit, fail, JSON_OUT, pairResult, say } from './output.ts'
import { inyonCommand, logFile, nodeDir, runningFile, savedEnv } from './paths.ts'

// run in the background (a service, the sign-in task) there's no console to print to: log to a
// file. Commands people run (pair, phones…) always print, even from a script, so the pairing code
// shows, and so does what the inyon command runs in a terminal (it sets INYON_CONSOLE).
const INTERACTIVE = new Set(['pair', 'join', 'phones', 'forget', 'push', 'update', 'version', '--version', 'help', '--help', '-h'])
const firstArg = argv[0]
const BACKGROUND = WIN && !process.stdout.isTTY && !process.env.INYON_CONSOLE && !(firstArg && INTERACTIVE.has(firstArg))
if (BACKGROUND) {
  const log = logFile(firstArg === 'link' ? 'link' : 'node')
  const write = (...a: unknown[]) => {
    try {
      appendFileSync(log, `${new Date().toISOString()} ${a.map(String).join(' ')}\n`)
    } catch {}
  }
  console.log = write
  console.error = write
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
  const wsUrl = `${secure(url) ? 'wss' : 'ws'}://${url.host}/node`
  // who's running, for `inyon update` and the hub's update script: they wait for this file to name
  // the new version, and stop the copy it names when there's no service manager
  try {
    mkdirSync(nodeDir(), { recursive: true })
    writeFileSync(runningFile('node'), JSON.stringify({ pid: process.pid, version: VERSION }))
  } catch {}

  /** A hub answers 410 to a machine removed while it was off (a token it never knew gets 403). */
  const removedThere = () =>
    fetch(`${secure(url) ? 'https' : 'http'}://${url.host}/node`, { headers: { authorization: `Bearer ${token}` } }).then(
      (r) => r.status === 410,
      () => false,
    )

  function connect(attempt = 0) {
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } } as any)
    const send = (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))
    const ops = serveOps(send)
    let opened = false

    ws.onopen = () => {
      opened = true
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

    ws.onclose = async (e) => {
      ops.close()
      if (e.code === 4001 || (!opened && (await removedThere()))) return leave(`This machine was removed from ${url.host}.`)
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

/**
 * The hub removed this machine. `inyon disconnect` takes the background service down and forgets
 * the hub, so nothing starts this again and calls the hub for ever. It runs in a session of its
 * own: stopping the service may stop everything started from this process.
 */
function leave(why: string) {
  const cli = process.env.INYON_CLI
  console.log(`${why} Removing the background service.`)
  if (!cli) {
    for (const name of ['env', '.env']) rmSync(path.join(nodeDir(), name), { force: true })
    process.exit(0)
  }
  const p = spawn(cli, ['disconnect'], { detached: true, stdio: 'inherit', windowsHide: true })
  p.on('exit', () => process.exit(0))
  p.on('error', () => process.exit(0))
}

/**
 * The Inyon icon in the Windows notification area while this runs in the background, so you can
 * see it runs and reach it without a terminal. The inyon command draws it and removes it once this
 * process has gone; an older command without it just exits.
 */
function showTray(role: 'link' | 'node') {
  const cli = inyonCommand()
  if (!BACKGROUND || !cli) return
  try {
    Bun.spawn([cli, 'tray', role, '--pid', String(process.pid)], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true } as any).unref()
  } catch (err) {
    console.log(`! no tray icon: ${(err as Error).message}`)
  }
}

/** Checks a hub address; refuses to send a token over plain http to a public address. */
/** Whether the hub is reached with TLS: https and wss are, http and ws aren't. */
const secure = (url: URL) => url.protocol === 'https:' || url.protocol === 'wss:'

function hubUrl(hub: string) {
  let url: URL
  try {
    url = new URL(hub)
  } catch {
    fail(`${hub} isn't a web address.`)
  }
  if (!secure(url) && !privateHost(url) && !process.env.INYON_ALLOW_INSECURE) fail(`Refusing to send the token over plain http to ${url.hostname}. Use https, or a private network address.`)
  return url
}

/**
 * `join <hub-url>`: saves the hub and token (readable only by you) in the node's folder, where
 * `connect` reads them. The inyon command's own `join` writes the same file and then sets up the
 * background service; this one is for starting the connection by hand.
 */
async function join(hubArg?: string) {
  const hub = (hubArg ?? '').replace(/\/+$/, '')
  const token = process.env.INYON_TOKEN ?? ''
  if (!hub || !token) fail('usage: INYON_TOKEN=<token> inyon-engine join <hub-url>')
  hubUrl(hub)
  await ensureShell().catch((err) => say(`! ${(err as Error).message}`))
  mkdirSync(nodeDir(), { recursive: true, mode: 0o700 })
  const lines = [`INYON_HUB=${hub}`, `INYON_TOKEN=${token}`, ...(WIN && process.env.INYON_SH ? [`INYON_SH=${process.env.INYON_SH}`] : [])]
  const file = path.join(nodeDir(), WIN ? '.env' : 'env')
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 })
  // the other file name may hold a token from an earlier pairing
  rmSync(path.join(nodeDir(), WIN ? 'env' : '.env'), { force: true })
  if (WIN) Bun.spawnSync(['icacls', file, '/inheritance:r', '/grant:r', `${os.userInfo().username}:(R,W)`, 'SYSTEM:(F)'], { stdout: 'ignore', stderr: 'ignore' })
  emit({ hub }, `Saved the hub ${new URL(hub).host}. Run \`inyon connect\` to connect, or \`inyon service install node\` to connect in the background.`)
}

// ---------- the phone link ----------

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

/**
 * Shows the pairing code; starts the link here first if it isn't running yet. True when the link
 * runs elsewhere, so this process has nothing left to do. With --json the code's parts go to
 * stdout as one line (the inyon command draws them) and the text below to stderr. The answer's
 * `service` says whether a link was already running, which the command shows as "keep this
 * running" when it wasn't.
 */
async function pair(args: string[]) {
  const config = linkOptions(args)
  const service = await linkRunning(config.port)
  if (!service) {
    startLink(config)
    startTidying()
  }
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
  say(`\nScan this with your phone's camera, or in the Inyon app (Add a computer → Scan the code), within 10 minutes:\n`)
  say(renderUnicodeCompact(qr, { border: 2 }))
  if (typed) say(`\nCan't scan it? Choose "Type a code" in the app and enter\n\n    ID    ${formatShortId(short.id)}\n    Code  ${short.code.slice(0, 3)} ${short.code.slice(3)}\n`)
  say(`\nOr paste this link into the app:\n${link}\n`)
  if (!s?.urls.length && !s?.relays.length) say('No address yet: the phone will look this machine up once its tunnel is up.\n')
  emit(pairResult({ link, qr, short, typed, ...where, service }))
  if (service) return true
  say('Keep this running so the phone can connect, or run `inyon service install` to keep it running in the background.')
}

function phones() {
  const all = Object.entries(listPhones())
  const list = all.map(([key, p]) => ({ key, name: p.name, pairedAt: p.pairedAt, lastSeen: p.lastSeen }))
  if (!all.length) return emit({ phones: list }, 'No phones paired yet. Run `inyon pair`.')
  const lines = all.map(([key, p]) => `${p.name.padEnd(24)} ${key.slice(0, 12)}  paired ${new Date(p.pairedAt).toLocaleDateString()}, last seen ${p.lastSeen ? new Date(p.lastSeen).toLocaleString() : 'never'}`)
  emit({ phones: list }, lines.join('\n'))
}

function forget(which?: string) {
  if (!which) fail('usage: inyon forget <name|key>')
  const matches = Object.entries(listPhones()).filter(([key, p]) => key.startsWith(which.toLowerCase()) || p.name === which)
  if (matches.length !== 1) fail(matches.length ? `"${which}" matches ${matches.length} phones; use more of the key` : `No paired phone matches "${which}"`)
  const [key, phone] = matches[0]!
  forgetPhone(key)
  emit({ forgotten: { key, name: phone.name } }, `Forgot ${phone.name}. It can't connect until it pairs again.`)
}

const USAGE = `inyon-engine ${VERSION}: the program behind the inyon command, which runs it for these.

  inyon-engine pair [options]       make a pairing code (starts the link here if none runs)
  inyon-engine link [options]       run the phone link
    --lan / --no-lan                also answer on this machine's LAN addresses
    --vpn / --no-vpn                also answer on Tailscale, NetBird, ZeroTier, WireGuard (on)
    --tunnel / --no-tunnel          open a free Cloudflare tunnel so any network works (on)
    --url <wss://…> / --no-url      publish an address of your own (repeatable)
    --relay <url> / --no-relay      keep a connection to an Inyon relay (repeatable)
    --port <n>                      local port (4780)
  inyon-engine phones               list paired phones
  inyon-engine forget <name|key>    unpair a phone
  inyon-engine push …               the browsers this machine sends notifications to
  inyon-engine join <hub-url>       save a hub's address, with the token in INYON_TOKEN
  inyon-engine connect              run the connection to that hub
  inyon-engine hub                  run the hub
  inyon-engine hub code             show the setup code a new hub asks for
  inyon-engine hub reset-password   choose a new password for a forgotten one
  inyon-engine version              print the version

Services and updates are the inyon command's: inyon setup, inyon service, inyon hub start, inyon update.`

/**
 * `update`: the inyon command owns updates since 0.14, so this only hands the call on. It's
 * still answered because the app asks the program it knows: the hub runs "$INYON_EXE" update
 * --background on a machine, and INYON_EXE names this program on a 0.10.x install whose own
 * updater put a newer engine at ~/.inyon/bin/inyon without the command next to it. Without the
 * command there's nothing here that can update, and the status file the app reads says so.
 */
function updateShim(args: string[]) {
  const cli = inyonCommand()
  if (cli) {
    const p = Bun.spawnSync([cli, 'update', ...args, ...(JSON_OUT ? ['--json'] : [])], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
    process.exit(p.exitCode ?? 1)
  }
  const message = `This copy of inyon can't update itself. Install the new version with: ${WIN ? `irm ${INSTALL_URL}/get.ps1 | iex` : `curl -fsSL ${INSTALL_URL}/get.sh | sh`}`
  try {
    mkdirSync(nodeDir(), { recursive: true })
    writeFileSync(path.join(nodeDir(), 'update-status'), `failed: ${message}\n`)
    appendFileSync(path.join(nodeDir(), 'update.log'), `${new Date().toISOString()} failed: ${message}\n`)
  } catch {}
  fail(message, 1)
}

const [cmd, ...rest] = argv
const joined = !!(process.env.INYON_HUB || savedEnv().INYON_HUB)
if (cmd === 'pair') {
  await ensureShell()
  if (await pair(rest)) process.exit(0)
} else if (cmd === 'link') {
  const config = linkOptions(rest)
  if (await linkRunning(config.port)) {
    const pid = currentState()?.pid
    fail(`The link is already running${pid ? ` (pid ${pid})` : ` on port ${config.port}`}.`)
  }
  await ensureShell()
  startLink(config)
  startTidying()
  showTray('link')
} else if (cmd === 'join') await join(rest[0])
// tether-node's installers started the hub connection with no arguments
else if (cmd === 'connect' || (!cmd && joined)) {
  await ensureShell().catch((err) => console.log(`! ${(err as Error).message}`))
  connectMode(rest[0])
  startTidying()
  showTray('node')
} else if (cmd === 'hub') {
  // a hub leaves itself out of the copies it builds for the machines it adds (see build.ts)
  if (process.env.INYON_NODE_ONLY) fail('This copy of inyon has no hub in it. Get the full program with get.sh --hub.')
  await (await import('./hub.ts')).hubCommand(rest)
} else if (cmd === 'update') updateShim(rest)
// a program run with no window, which this one has none of on Windows either: the inyon
// command's one-off update task starts `inyon update` through it
else if (cmd === 'hidden') {
  if (!rest.length) fail('usage: inyon-engine hidden <program> [arguments…]')
  const p = Bun.spawn(rest, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true } as any)
  process.exit(await p.exited)
}
else if (cmd === 'phones') phones()
else if (cmd === 'forget') forget(rest[0])
else if (cmd === 'push') await (await import('./push.ts')).pushCommand(rest)
else if (cmd === 'version' || cmd === '--version') emit({ version: VERSION, engine: true }, VERSION)
else if (cmd === 'help' || cmd === '--help' || cmd === '-h') console.log(USAGE)
// the form tether-node's installers used: a hub address, with the token in the environment
else if (cmd && /^https?:\/\//.test(cmd)) {
  connectMode(cmd, rest[0])
  startTidying()
}
else fail(USAGE)
