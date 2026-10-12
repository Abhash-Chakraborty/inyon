import os from 'node:os'
import path from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { PRODUCT } from '@inyon/protocol'
import { detectNetworks, LABEL, type Network } from '../hub/src/networks.ts'
import { VERSION } from './link.ts'
import { nodeDir, readEnvFile } from './paths.ts'
import { installService, uninstallService } from './service.ts'
import { runningFile } from './update.ts'

/**
 * `inyon hub`: runs the hub, the server the app signs in to, from this same program. Its settings
 * (PORT, BIND, TLS_CERT and TLS_KEY, INYON_ALLOW_HTTP…) can go in ~/.inyon/hub.env, one NAME=value
 * a line, so the background service picks them up too.
 *
 *   inyon hub              run it here
 *   inyon hub install      run it in the background from now on, and say how to sign in
 *   inyon hub uninstall    stop running it in the background (its records stay)
 */
const dataDir = () => process.env.INYON_DATA_DIR || path.join(os.homedir(), '.inyon')
export const hubEnvFile = () => path.join(dataDir(), 'hub.env')

export async function hubCommand(args: string[]) {
  const [sub] = args
  if (sub === 'install') return install()
  if (sub === 'uninstall') {
    const r = uninstallService('hub')
    console.log(r.ok ? `The hub stopped; ${r.how}. Its records stay in ${dataDir()}.` : `Couldn't remove everything: ${r.how}.`)
    if (!r.ok) process.exit(1)
    return
  }
  if (sub) {
    console.error('usage: inyon hub [install|uninstall]')
    process.exit(2)
  }
  for (const [k, v] of Object.entries(readEnvFile(hubEnvFile()))) process.env[k] ??= v
  // for `inyon update`: it waits for this to name the new version
  try {
    mkdirSync(nodeDir(), { recursive: true })
    writeFileSync(runningFile('hub'), JSON.stringify({ pid: process.pid, version: VERSION }))
  } catch {}
  await import('../hub/src/index.ts')
}

/** Sets the hub up as a background service and prints where to open it, with the setup code. */
async function install() {
  if (process.platform === 'win32') {
    console.error(`The ${PRODUCT} hub runs on Linux and macOS. On Windows, install it inside WSL.`)
    process.exit(1)
  }
  const env = { ...readEnvFile(hubEnvFile()), ...process.env }
  const r = installService('hub', true)
  if (!r.ok) {
    console.error(`Couldn't run the hub in the background: ${r.how}. Run \`inyon hub\` to start it here.`)
    process.exit(1)
  }
  const tls = !!(env.TLS_CERT && env.TLS_KEY)
  const bind = env.BIND || '127.0.0.1'
  const where = `${tls ? 'https' : 'http'}://${/^(127\.|::1$|localhost$|0\.0\.0\.0$|::$)/.test(bind) ? 'localhost' : bind}:${env.PORT || 4777}`
  console.log(`The ${PRODUCT} hub runs as ${r.how}.`)
  // a new hub writes a one-time code for choosing its password as it starts
  const local = `${tls ? 'https' : 'http'}://${bind === '0.0.0.0' || bind === '::' || bind === '127.0.0.1' ? '127.0.0.1' : bind}:${env.PORT || 4777}`
  let code = ''
  for (let i = 0; i < 60; i++) {
    const session = await fetch(`${local}/api/session`, { tls: { rejectUnauthorized: false } } as any).then((r) => r.json() as Promise<{ setup?: boolean }>, () => undefined)
    if (session) {
      if (session.setup) code = readFileSync(path.join(dataDir(), 'setup-code'), 'utf8').trim()
      break
    }
    await Bun.sleep(250)
  }
  console.log(`\nOpen ${where} in a browser${code ? ` and enter the setup code ${code} to choose a password` : ' and sign in'}.`)
  if (bind === '127.0.0.1' && !tls) console.log('\n' + reachAdvice(await detectNetworks(), Number(env.PORT || 4777), hubEnvFile()).join('\n'))
}

/**
 * How to open a hub that answers on this machine only from a phone, for the private networks this
 * machine is on: Tailscale's own HTTPS where it has it, the network address otherwise, and
 * NetBird's reverse proxy for a public address.
 */
export function reachAdvice(nets: Network[], port: number, envFile: string): string[] {
  if (!nets.length) return [`It answers on this machine only. To open it from your phone, put it behind HTTPS (Caddy, a tunnel) or set BIND in ${envFile}.`]
  const lines = ['To open it from your phone:']
  let plain = false
  for (const n of nets) {
    if (n.https) lines.push(`  ${LABEL[n.kind]}: run \`tailscale serve --bg ${port}\`, then open https://${n.https}`)
    else {
      plain = true
      lines.push(`  ${LABEL[n.kind]}: add BIND=${n.ip} and INYON_ALLOW_HTTP=1 to ${envFile}, run \`inyon hub install\` again, then open http://${n.name ?? n.ip}:${port}`)
    }
    if (n.expose) lines.push(`  ${LABEL[n.kind]}, public HTTPS: run \`netbird expose ${port}\` and add the address it prints to INYON_ALLOWED_HOSTS in ${envFile}`)
  }
  // the network encrypts it either way; browsers still treat plain http as unsafe
  if (plain) lines.push('Over plain http the browser won\'t install the app or show notifications; HTTPS lets it.')
  return lines
}
