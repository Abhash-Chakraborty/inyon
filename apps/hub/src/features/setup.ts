import { AGENTS, AGENT_KINDS, type AgentDef, type AgentKind } from '@inyon/protocol'
import { shq } from '../hosts/host.ts'
import { HIDDEN_PREFIXES } from '../tmux/tmux.ts'
import { HttpError, registry } from '../hosts/registry.ts'
import { loadSettings, saveSettings } from '../config.ts'
import { signedInTest } from '../agents/auth-sh.ts'
import { compareVersions, latestAgentVersions } from './agent-latest.ts'
import { parseAuthList } from './providers.ts'

export const PATHS = 'export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$PATH:$d"; done'

export interface SetupCheck {
  id: string
  label: string
  ok: boolean
  detail?: string
  /** a one-tap fix Inyon can run */
  fix?: { label: string; action: string }
  /** a command for the user to run themselves (e.g. needs sudo or a browser) */
  manual?: string
  docs?: string
}

/** npm: an npm package (updated with npm, global or under its own prefix) · installer: the agent's own installer */
export type InstalledVia = 'npm' | 'installer'

export interface SetupAgent {
  kind: AgentKind
  installed: boolean
  version?: string
  signedIn: boolean
  /** the newest published version, when the registry answered */
  latest?: string
  /** the installed version is older than `latest` */
  outdated?: boolean
  via?: InstalledVia
  /** an npm install that isn't global: the folder whose node_modules holds it, updated in place */
  prefix?: string
  /** OpenCode: the providers it's connected to on the machine (a saved credential or an environment variable) */
  providers?: string[]
}

export interface SetupReport {
  os: string
  pkg?: string
  sudo: boolean
  checks: SetupCheck[]
  agents: SetupAgent[]
  keepSession: boolean
}

/** What an install or update step came back with. */
export interface SetupResult {
  ok: boolean
  output?: string
  /** a sign-in that opened a terminal pane */
  pane?: string
  /** the agent's version once the step ran */
  version?: string
  latest?: string
  /** when it failed: the command to run on the machine yourself */
  manual?: string
  /** when it failed: the likely cause, in one line */
  hint?: string
}

/** the program an agent's version command runs */
const binary = (def: Pick<AgentDef, 'version'>) => def.version.split(' ')[0]

const PKG_INSTALL: Record<string, (p: string) => string> = {
  apt: (p) => `apt-get update -qq && apt-get install -y -qq ${p}`,
  dnf: (p) => `dnf install -y -q ${p}`,
  yum: (p) => `yum install -y -q ${p}`,
  pacman: (p) => `pacman -S --noconfirm ${p}`,
  apk: (p) => `apk add ${p}`,
  zypper: (p) => `zypper -n install ${p}`,
  brew: (p) => `brew install ${p}`,
}

/** Everything Inyon needs on a machine, checked in one round trip. */
export async function setupReport(hostId: string): Promise<SetupReport> {
  const host = registry.host(hostId)
  const authTests = AGENT_KINDS.map((k) => `echo "AUTH ${k} $(${signedInTest(k)} && echo 1 || echo 0)"`).join('\n')
  const script = `${PATHS}
echo "OS $(uname -s) $(uname -m)"
for p in apt dnf yum pacman apk zypper brew; do command -v $p >/dev/null 2>&1 && { [ $p = apt ] && command -v apt-get >/dev/null || [ $p != apt ]; } && { echo "PKG $p"; break; }; done
sudo -n true >/dev/null 2>&1 && echo "SUDO 1" || echo "SUDO 0"
echo "TMUX $(tmux -V 2>/dev/null)"
# the same sessions the list shows: not Inyon's own terminal views and sign-ins
echo "SESSIONS $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -c -v ${HIDDEN_PREFIXES.map((p) => `-e '^${p}'`).join(' ')})"
echo "NODE $(node --version 2>/dev/null)"
echo "NPM $(npm --version 2>/dev/null)"
echo "CURL $(command -v curl >/dev/null && echo 1)"
echo "GIT $(git --version 2>/dev/null)"
${AGENT_KINDS.map((k) => `echo "VER ${k} $(${AGENTS[k].version} 2>/dev/null | head -1)"`).join('\n')}
${AGENT_KINDS.map((k) => `echo "BIN ${k} $(b=$(command -v ${binary(AGENTS[k])} 2>/dev/null) && { readlink -f "$b" 2>/dev/null || echo "$b"; })"`).join('\n')}
echo "NPMLS $(npm ls -g --depth=0 --parseable 2>/dev/null | tr '\\n' ' ')"
command -v opencode >/dev/null 2>&1 && echo "OCAUTH $(opencode auth list 2>/dev/null | base64 | tr -d '\\n')"
${authTests}
`
  // the registry is asked while the machine runs the script, so the report isn't slower for it
  const [r, latest] = await Promise.all([host.exec(script, { timeoutMs: 30000 }), latestAgentVersions()])
  const get = (k: string) => r.stdout.split('\n').find((l) => l.startsWith(`${k} `))?.slice(k.length + 1).trim() ?? ''
  const os = get('OS')
  const pkg = get('PKG') || undefined
  const sudo = get('SUDO') === '1'
  const tmux = get('TMUX')
  const sessions = Number(get('SESSIONS')) || 0
  const node = get('NODE')
  const keepSession = loadSettings().keepSession?.[hostId] ?? false
  const install = (p: string) => (pkg ? PKG_INSTALL[pkg](p) : undefined)
  const asRoot = (cmd?: string) => (cmd && pkg !== 'brew' ? `sudo sh -c ${shq(cmd)}` : cmd)

  const checks: SetupCheck[] = [
    {
      id: 'tmux',
      label: 'tmux',
      ok: !!tmux,
      detail: tmux || 'Not installed. Inyon lists and controls agents through tmux.',
      fix: !tmux && pkg && (sudo || pkg === 'brew') ? { label: 'Install tmux', action: 'install:tmux' } : undefined,
      manual: !tmux ? asRoot(install('tmux')) ?? 'Install tmux with your package manager' : undefined,
    },
    {
      id: 'session',
      label: 'A tmux session to work in',
      ok: sessions > 0,
      detail: sessions ? `${sessions} running` : 'No tmux sessions yet',
      fix: tmux && !sessions ? { label: 'Start a session', action: 'session' } : undefined,
    },
    {
      id: 'node',
      label: 'Node.js (for npm-installed agents)',
      ok: !!node,
      detail: node || 'Needed for Codex, Gemini CLI and GitHub Copilot',
      fix: !node && pkg && (sudo || pkg === 'brew') ? { label: 'Install Node.js', action: 'install:node' } : undefined,
      manual: !node ? asRoot(install(pkg === 'brew' ? 'node' : 'nodejs npm')) : undefined,
    },
  ]
  const npmGlobals = get('NPMLS')
  const agents = AGENT_KINDS.map((k): SetupAgent => {
    const version = get(`VER ${k}`)
    const auth = r.stdout.split('\n').find((l) => l.startsWith(`AUTH ${k} `))?.endsWith('1') ?? false
    const a: SetupAgent = { kind: k, installed: !!version, version: version || undefined, signedIn: auth }
    if (latest[k]) a.latest = latest[k]
    if (!version) return a
    if (k === 'opencode') a.providers = connectedProviders(get('OCAUTH'))
    const where = installedVia(AGENTS[k], get(`BIN ${k}`), npmGlobals)
    a.via = where.via
    if (where.prefix) a.prefix = where.prefix
    if (a.latest) a.outdated = compareVersions(version, a.latest) < 0
    return a
  })
  return { os, pkg, sudo, checks, agents, keepSession }
}

/** The provider names `opencode auth list` (base64 in the report) says are connected, credentials first. */
export function connectedProviders(encoded: string): string[] {
  let text = ''
  try {
    text = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : ''
  } catch {
    return []
  }
  const auth = parseAuthList(text)
  return [...new Set([...auth.credentials.map((c) => c.name), ...auth.env.map((e) => e.name)])]
}

/** A global npm install into the user's own prefix when the global one isn't theirs to write. */
const npmGlobal = (spec: string) => `{ npm config get prefix | grep -q "^$HOME" || npm config set prefix "$HOME/.npm-global"; npm install -g ${spec}; }`

/**
 * The agent's own installer when it has one. If the agent still doesn't run after it (a piped
 * installer reports success even when its download failed) and npm is there, its npm package.
 * npm installs into the user's prefix when the global one isn't writable.
 */
export function installCommand(def: Pick<AgentDef, 'install' | 'version'>, paths = PATHS): string {
  const { cmd, npm } = def.install
  const viaNpm = npmGlobal(npm!)
  if (!cmd) return `${paths}; ${viaNpm}`
  if (!npm) return `${paths}; ${cmd}`
  return [
    `${paths}; ${cmd}`,
    `if ${def.version} >/dev/null 2>&1; then :`,
    `elif command -v npm >/dev/null 2>&1; then echo "The installer didn't finish; trying npm instead."; ${viaNpm}`,
    `else echo "The installer didn't finish, and there's no npm here to try instead."; false; fi`,
  ].join('\n')
}

/**
 * How an installed agent got there: through npm when `npm ls -g` lists its package or its program
 * lives in a node_modules or npm-global folder, otherwise through its own installer. An npm copy
 * outside the global folder (an older Inyon kept OpenCode under ~/.local/share/tether-tools, say)
 * comes with the folder it was installed into, so an update goes there and not to a second copy
 * the PATH would never reach.
 */
export function installedVia(def: Pick<AgentDef, 'install' | 'latest'>, binPath: string, npmGlobals: string): { via: InstalledVia; prefix?: string } {
  const pkg = def.latest?.npm ?? def.install.npm
  const globals = npmGlobals.split(/\s+/).filter(Boolean)
  if (pkg && globals.some((p) => p.endsWith(`/node_modules/${pkg}`))) return { via: 'npm' }
  const own = pkg && binPath.match(new RegExp(`^(.*)/node_modules/${pkg.replace(/[/@.]/g, '\\$&')}/`))
  if (own) {
    // the first word of npm ls -g is the global folder; a package under it, or under lib/, is global
    const root = globals[0]
    const prefix = own[1]
    const global = (root && (prefix === root || prefix === `${root}/lib`)) || /\/(lib|\.npm-global)$/.test(prefix)
    return global ? { via: 'npm' } : { via: 'npm', prefix }
  }
  if (/node_modules|npm-global/.test(binPath)) return { via: 'npm' }
  return { via: 'installer' }
}

/** npm install into a folder of its own, where an agent already lives, so the PATH keeps pointing at it. */
const npmPrefixed = (prefix: string, spec: string) => `npm install --prefix ${shq(prefix)} ${spec}`

/**
 * The step that brings an agent to its newest version: npm for an npm install (into the user's
 * prefix, as installCommand does, or the folder it already sits in), else the agent's own updater,
 * else its installer again.
 */
export function updateCommand(def: Pick<AgentDef, 'install' | 'latest' | 'update' | 'version'>, via: InstalledVia | undefined, paths = PATHS, prefix?: string): string {
  const pkg = def.latest?.npm ?? def.install.npm
  if (via === 'npm' && pkg && prefix) return `${paths}; ${npmPrefixed(prefix, `${pkg}@latest`)}`
  if (via === 'npm' && pkg) return `${paths}; ${npmGlobal(`${pkg}@latest`)}`
  if (def.update) return `${paths}; ${def.update}`
  return installCommand(def, paths)
}

/** The same step as one line the user can paste into a terminal on the machine. */
export function manualCommand(def: Pick<AgentDef, 'install' | 'latest' | 'update'>, step: 'install' | 'update', via?: InstalledVia, prefix?: string): string {
  const pkg = def.latest?.npm ?? def.install.npm
  if (step === 'update' && via === 'npm' && pkg && prefix) return npmPrefixed(prefix, `${pkg}@latest`)
  if (step === 'update' && via === 'npm' && pkg) return `npm install -g ${pkg}@latest`
  if (step === 'update' && def.update) return def.update
  return def.install.cmd ?? `npm install -g ${def.install.npm}`
}

/** The likely cause of a failed install or update, in one line, from what it printed. */
export function failureHint(output: string, pkg?: string): string | undefined {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return undefined
  if (/EACCES|permission denied|EPERM/i.test(output))
    return `npm can't write there; set a user prefix: npm config set prefix "$HOME/.npm-global" && npm install -g ${pkg ?? '<package>'}@latest`
  if (/(command not found: npm|npm: (command )?not found|node: (command )?not found|command not found: node|no npm here)/i.test(output))
    return 'Install Node.js first (the Setup tab can)'
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timed out|Could not resolve host|Failed to connect|Connection refused|Network is unreachable|\bE(403|50[0-9])\b|returned error: (403|50[0-9])|HTTP(\/[\d.]+)? (403|50[0-9])\b|\b(403|50[0-9]) (Forbidden|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)/i.test(output))
    return "The machine couldn't reach the download; check its network and try again"
  const err = [...lines].reverse().find((l) => /error|fail|cannot|can't|not /i.test(l)) ?? lines[lines.length - 1]
  return err.slice(0, 200)
}

/** Runs one setup step. Installs run non-interactively; sign-ins go through features/signin.ts. */
export async function runSetup(hostId: string, action: string): Promise<SetupResult> {
  const host = registry.host(hostId)
  const report = await setupReport(hostId)
  const pkg = report.pkg
  const root = (cmd: string) => (pkg === 'brew' ? cmd : `sudo -n sh -c ${shq(cmd)}`)
  let cmd: string | undefined
  let agent: { def: AgentDef; step: 'install' | 'update'; via?: InstalledVia; prefix?: string } | undefined
  let state: SetupAgent | undefined
  if (action === 'install:tmux' && pkg) cmd = root(PKG_INSTALL[pkg]('tmux'))
  else if (action === 'install:node' && pkg) cmd = root(PKG_INSTALL[pkg](pkg === 'brew' ? 'node' : 'nodejs npm'))
  else if (action === 'session') {
    const r = await host.exec(`tmux new-session -d -s main -c "$HOME" 2>&1 || tmux new-session -d -c "$HOME" 2>&1`)
    registry.refresh(hostId, 200)
    return { ok: r.code === 0, output: r.stdout + r.stderr }
  } else if (action.startsWith('agent:') || action.startsWith('update:')) {
    const kind = action.slice(action.indexOf(':') + 1) as AgentKind
    const def = AGENTS[kind]
    if (!def) throw new HttpError(400, 'Unknown agent')
    state = report.agents.find((a) => a.kind === kind)
    // updating something that isn't there is an install
    const step = action.startsWith('update:') && state?.installed ? 'update' : 'install'
    const node = report.checks.find((c) => c.id === 'node')?.ok
    if (step === 'install' && !def.install.cmd && !node) throw new HttpError(409, 'Install Node.js first')
    agent = { def, step, via: state?.via, prefix: state?.prefix }
    cmd = step === 'update' ? updateCommand(def, state?.via, PATHS, state?.prefix) : installCommand(def)
  } else throw new HttpError(400, 'Unknown setup step')
  if (!cmd) throw new HttpError(409, 'No package manager found on that machine')
  if (!agent) {
    const r = await host.exec(cmd, { timeoutMs: 600_000 })
    registry.refresh(hostId, 200)
    return { ok: r.code === 0, output: (r.stdout + r.stderr).slice(-6000) }
  }
  // the agent's version is read in the same round trip, after the step
  const r = await host.exec(`${cmd}\n__inyon_code=$?; echo "INYON_VERSION $(${PATHS}; ${agent.def.version} 2>/dev/null | head -1)"; exit $__inyon_code`, { timeoutMs: 600_000 })
  registry.refresh(hostId, 200)
  const out = r.stdout + r.stderr
  const version = out.split('\n').find((l) => l.startsWith('INYON_VERSION '))?.slice(14).trim() || undefined
  const output = out.split('\n').filter((l) => !l.startsWith('INYON_VERSION ')).join('\n').trim().slice(-6000)
  const latest = state?.latest
  // the step said it failed, or it ended and the agent still isn't there
  const ok = r.code === 0 && !!version
  const result: SetupResult = { ok, output, version, latest }
  if (!ok) {
    result.manual = manualCommand(agent.def, agent.step, agent.via, agent.prefix)
    result.hint = failureHint(output, agent.def.latest?.npm ?? agent.def.install.npm) ?? (version ? undefined : `${agent.def.name} still doesn't run after the step`)
  }
  return result
}

export function setKeepSession(hostId: string, on: boolean) {
  const s = loadSettings()
  s.keepSession = { ...(s.keepSession ?? {}), [hostId]: on }
  saveSettings(s)
  if (on) ensureSessions()
}

/** "Keep a tmux session running": make sure each opted-in machine has at least one session. */
export async function ensureSessions() {
  const keep = loadSettings().keepSession ?? {}
  for (const h of registry.overview()) {
    if (!keep[h.config.id] || h.status !== 'online' || h.tmux === 'missing') continue
    if (h.sessions.length === 0) {
      await registry.host(h.config.id).exec(`tmux new-session -d -s main -c "$HOME" 2>/dev/null || true`)
      registry.refresh(h.config.id, 200)
    }
  }
}
