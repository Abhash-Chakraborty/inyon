import os from 'node:os'
import path from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/** A private IPv4 address: a whole dotted quad (10.0.0.1.example.com is a name, not one) in a private range. */
function privateIPv4(h: string) {
  const parts = h.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false
  const [a, b] = parts.map(Number) as [number, number]
  if (a === 10 || a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return a === 100 && b >= 64 && b <= 127 // CGNAT range used by Tailscale and NetBird
}

/** Whether a hub's address is on your own network, where plain http:// is accepted for the token. */
export function privateHost(url: URL) {
  const h = url.hostname
  // IPv6 literals: loopback, unique-local (fc00::/7, Tailscale uses fd7a:115c:a1e0::/48), link-local
  if (h.startsWith('[')) return /^\[(::1|f[cd][0-9a-f]{0,2}:|fe[89ab][0-9a-f]?:)/i.test(h)
  if (h === 'localhost' || h === '::1' || privateIPv4(h)) return true
  if (/\.(ts\.net|netbird\.cloud|netbird\.selfhosted|local|lan|internal)$/.test(h)) return true
  return !h.includes('.') // single-label names on your private network
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
  const r = await fetch(`${url}/api/local/companion-code?token=${encodeURIComponent(token)}`, { method: 'POST', tls: { rejectUnauthorized: false } } as any)
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
