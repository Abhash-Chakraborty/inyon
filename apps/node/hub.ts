import os from 'node:os'
import path from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import dns from 'node:dns/promises'
import { isIPv4, isIPv6 } from 'node:net'
import { VERSION } from './link.ts'
import { nodeDir, readEnvFile, runningFile } from './paths.ts'
import { emit, fail } from './output.ts'

/**
 * `inyon-engine hub`: runs the hub, the server the app signs in to, from this same program. Its
 * settings (PORT, BIND, TLS_CERT and TLS_KEY, INYON_ALLOW_HTTP…) can go in ~/.inyon/hub.env, one
 * NAME=value a line, so the background service picks them up too. Running it in the background
 * is the inyon command's job (`inyon hub start`).
 *
 *   inyon-engine hub                 run it here
 *   inyon-engine hub code            show the setup code a new hub asks for
 *   inyon-engine hub companion-code  a one-time code for a companion app (Legato) to pair with
 *   inyon-engine hub reset-password  choose a new password when the old one is forgotten
 */
const dataDir = () => process.env.INYON_DATA_DIR || path.join(os.homedir(), '.inyon')
export const hubEnvFile = () => path.join(dataDir(), 'hub.env')

/**
 * An address plain http may carry the token to: this machine, or a VPN that encrypts on its own
 * (Tailscale and NetBird's 100.64.0.0/10, Tailscale's fd7a:115c:a1e0::/48). A LAN address isn't:
 * anyone on the Wi-Fi can read the token there, or answer in the hub's place.
 */
export function plainHttpIp(ip: string) {
  const v6 = ip.replace(/^\[|\]$/g, '').toLowerCase()
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return plainHttpIp(mapped[1]!)
  if (isIPv4(v6)) {
    const [a, b] = v6.split('.').map(Number) as [number, number]
    return a === 127 || (a === 100 && b >= 64 && b <= 127)
  }
  if (!isIPv6(v6)) return false
  const full = expandIPv6(v6)
  // an IPv4 address in IPv6 form, as URL writes it (::ffff:6464:101)
  if (full.startsWith('0000:0000:0000:0000:0000:ffff:')) {
    const [hi, lo] = full.split(':').slice(6).map((g) => parseInt(g, 16)) as [number, number]
    return plainHttpIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  return full === '0000:0000:0000:0000:0000:0000:0000:0001' || full.startsWith('fd7a:115c:a1e0:')
}

function expandIPv6(ip: string) {
  const [head, tail = ''] = ip.split('::') as [string, string?]
  const h = head ? head.split(':') : []
  const t = ip.includes('::') && tail ? tail.split(':') : []
  const parts = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h
  return parts.map((p) => p.padStart(4, '0')).join(':')
}

/** What a hub address on plain http is: fine, a name to look up and check before each connection, or refused. */
export function plainHost(url: URL): 'ok' | 'look up' | 'refused' {
  const h = url.hostname
  if (h.startsWith('[') || isIPv4(h)) return plainHttpIp(h) ? 'ok' : 'refused'
  if (h === 'localhost') return 'ok'
  return 'look up'
}

/** Why a hub address can't take the token over plain http, and what to do instead. */
/**
 * Whether Inyon before 0.20 sent the token over plain http to this address: a private one (10/8,
 * 172.16/12, 192.168/16, 100.64/10, loopback, fc00::/7, fe80::/10), localhost, a single-label name,
 * or one ending in .ts.net, .netbird.cloud, .netbird.selfhosted, .local, .lan or .internal. A
 * machine added then keeps connecting to such a hub, with a warning; a public address it never went
 * to stays refused. The same rule as plain_before_0_20 in crates/inyon-engine/src/hub.rs.
 */
export function plainBefore020(url: URL) {
  const h = url.hostname.toLowerCase()
  if (h.startsWith('[')) return /^\[(::1\]|f[cd][0-9a-f]{0,2}:|fe[89ab][0-9a-f]?:)/.test(h)
  const v4 = h.split('.')
  if (v4.length === 4 && v4.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    const [a, b] = v4.map(Number) as [number, number]
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127)
  }
  if (h === 'localhost' || /\.(ts\.net|netbird\.cloud|netbird\.selfhosted|local|lan|internal)$/.test(h)) return true
  return !h.includes('.')
}

export const plainRefusal = (host: string) =>
  `Refusing to send the token over plain http to ${host}: anyone on that network could read it, or answer in the hub's place. Use the hub's https address, or its Tailscale or NetBird address (100.x.y.z), or set INYON_ALLOW_INSECURE=1 to send it anyway.`

/**
 * Looks up a hub's name for a connection made right after, to the addresses it returns and no
 * others. Only the ones plain http may go to are kept, so a name that also has a LAN address or
 * NetBird's own IPv6 still works: the connection never goes there. The refusal when no address is
 * allowed; null when it couldn't be looked up, worth trying again.
 */
export async function checkName(host: string): Promise<{ addrs: string[] } | { why: string } | null> {
  const all = await lookUp(host)
  if (!all) return null
  const kept = all.filter(plainHttpIp)
  return kept.length ? { addrs: kept } : { why: refusedName(host, all[0]!) }
}

/** For something that looks the name up again itself: the refusal, '' when it may go, null when it didn't resolve. */
export async function checkNameNow(host: string): Promise<string | null> {
  const all = await lookUp(host)
  if (!all) return null
  const bad = notPlain(all)
  return bad ? refusedName(host, bad) : ''
}

async function lookUp(host: string) {
  try {
    const all = (await dns.lookup(host, { all: true })).map((a) => a.address)
    return all.length ? all : null
  } catch {
    return null
  }
}

const refusedName = (host: string, bad: string) => `${plainRefusal(host).replace(/\.$/, '')} (${host} is ${bad})`

/**
 * The first of a name's addresses plain http mustn't go to, when something looks the name up again
 * and may use any of them. Every address must be allowed, with one exception: NetBird gives each
 * peer an IPv6 address too, in a unique-local /64 picked at random per network (fd91:8fa2:…), so
 * no fixed range names it. A unique-local IPv6 (fc00::/7) passes when the name also has an allowed
 * IPv4 (100.64/10 or loopback): that is the VPN's own overlay next to its 100.x address. A LAN or
 * public address anywhere still refuses, and so does a unique-local address alone. Same rule as
 * `judge` in crates/inyon-engine/src/hub.rs.
 */
export function notPlain(addresses: string[]): string | undefined {
  const vpnV4 = addresses.some((a) => isIPv4(a) && plainHttpIp(a))
  const overlay = (a: string) => isIPv6(a) && /^f[cd]/i.test(expandIPv6(a.toLowerCase()))
  return addresses.find((a) => !plainHttpIp(a) && !(vpnV4 && overlay(a)))
}

export async function hubCommand(args: string[]) {
  const [sub] = args
  for (const [k, v] of Object.entries(readEnvFile(hubEnvFile()))) process.env[k] ??= v
  if (sub === 'code') return showSetupCode()
  if (sub === 'companion-code') return showCompanionCode()
  if (sub === 'reset-password') return resetPassword(args[1])
  if (sub) {
    console.error('usage: inyon-engine hub [code|companion-code|reset-password]')
    process.exit(2)
  }
  // for `inyon update`: it waits for this to name the new version
  try {
    mkdirSync(nodeDir(), { recursive: true })
    writeFileSync(runningFile('hub'), JSON.stringify({ pid: process.pid, version: VERSION }))
  } catch {}
  await import('../hub/src/index.ts')
}

/** The hub's own address on this machine, for asking it questions. */
function localUrl(env: Record<string, string | undefined> = { ...readEnvFile(hubEnvFile()), ...process.env }) {
  const tls = !!(env.TLS_CERT && env.TLS_KEY)
  const bind = env.BIND || '127.0.0.1'
  return `${tls ? 'https' : 'http'}://${bind === '0.0.0.0' || bind === '::' || bind === '127.0.0.1' ? '127.0.0.1' : bind}:${env.PORT || 4777}`
}

/** The running hub's answer, or nothing when it's not there or something else answers at its address. */
const askHub = (url: string): Promise<{ setup?: boolean } | undefined> =>
  fetch(`${url}/api/session`, { tls: { rejectUnauthorized: false } } as any)
    .then((r) => r.json() as Promise<{ setup?: boolean }>)
    .catch(() => undefined)

/**
 * What `inyon hub code` says: the code while the hub still waits for its first password, and
 * otherwise what to do instead. `code` is the file the hub writes as it starts; `session` is
 * the running hub's answer, if it answered.
 */
export function setupCodeMessage(code: string | undefined, session: { setup?: boolean } | undefined, url: string): string {
  if (session && !session.setup) return 'This hub has a password already, so there is no setup code. Forgotten it? Run `inyon hub reset-password`.'
  if (code && session) return `Setup code: ${code}\nOpen ${url} in a browser and enter it to choose a password.`
  if (code) return `Setup code: ${code}\nThe hub isn't answering right now; start it (\`inyon hub\` or \`inyon hub start\`), then open it in a browser and enter the code.`
  return 'No setup code here: the hub has not started yet. Run `inyon hub` or `inyon hub start`; it makes a code as it starts.'
}

async function showSetupCode() {
  const url = localUrl()
  let code: string | undefined
  try {
    code = readFileSync(path.join(dataDir(), 'setup-code'), 'utf8').trim() || undefined
  } catch {}
  const session = await askHub(url)
  const message = setupCodeMessage(code, session, url)
  emit({ code: session && !session.setup ? undefined : code, url, running: !!session, hasPassword: session ? !session.setup : undefined, message }, message)
}

/** "K7M2QX" as it is shown: K7M-2QX. */
export const formatCompanionCode = (code: string) => (code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code)

/**
 * What `inyon hub companion-code` says once the hub made a code. A hub on loopback sits behind a
 * proxy or `tailscale serve`, whose address this program doesn't know, so it names none then.
 */
export const companionCodeMessage = (code: string, url: string) => {
  const address = /^https?:\/\/(127\.|localhost|\[::1\])/.test(url) ? 'the address you open this hub at' : `this hub's address, ${url}`
  return `Companion code: ${formatCompanionCode(code)}\nType it into the companion app (Legato: Settings > Connections > Inyon) with ${address}. It works once, for 5 minutes.`
}

/**
 * `inyon hub companion-code`: asks the running hub for a companion code over its own address,
 * with the token it wrote for the inyon command on this machine.
 */
async function showCompanionCode() {
  const url = localUrl()
  let token = ''
  try {
    token = readFileSync(path.join(dataDir(), 'local-token'), 'utf8').trim()
  } catch {}
  if (!token) fail("The hub hasn't started here yet. Run `inyon hub` or `inyon hub start` first.", 1)
  // the token in a header, not the address, where a proxy's log would keep it
  const r = await fetch(`${url}/api/local/companion-code`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, tls: { rejectUnauthorized: false } } as any)
    .then(async (res) => ({ status: res.status, body: (await res.json().catch(() => ({}))) as { code?: string; expiresAt?: number; error?: string } }))
    .catch(() => undefined)
  if (!r) fail(`The hub isn't answering at ${url}. Start it with \`inyon hub start\`.`, 1)
  if (r.status === 404) fail('This hub is too old for companion apps. Update it with `inyon update`.', 1)
  if (!r.body.code) fail(r.body.error ?? `The hub answered ${r.status}.`, 1)
  const message = companionCodeMessage(r.body.code, url)
  emit({ code: r.body.code, expiresAt: r.body.expiresAt, url, message }, message)
}

/**
 * A new password for a forgotten one, written straight to the hub's records; a running hub has
 * to restart to pick it up, which the inyon command does after this answers. The password comes
 * as an argument, in INYON_NEW_PASSWORD (how the inyon command passes what it asked for, off the
 * process list), or from a prompt.
 */
async function resetPassword(given?: string) {
  await import('../hub/src/env.ts')
  const { passwordProblem, setPassword } = await import('../hub/src/password.ts')
  const pw = given ?? process.env.INYON_NEW_PASSWORD ?? prompt('New Inyon password:') ?? ''
  const problem = passwordProblem(pw)
  if (problem) fail(problem, 1)
  setPassword(pw)
  const message = 'Password updated; everyone was signed out. Restart the hub to use it (`inyon hub restart`).'
  emit({ message }, message)
}
