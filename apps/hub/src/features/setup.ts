import { AGENTS, AGENT_KINDS, type AgentKind } from '@inyon/protocol'
import { shq } from '../hosts/host.ts'
import { HIDDEN_PREFIXES } from '../tmux/tmux.ts'
import { HttpError, registry } from '../hosts/registry.ts'
import { loadSettings, saveSettings } from '../config.ts'
import { signedInTest } from '../agents/auth-sh.ts'

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

export interface SetupReport {
  os: string
  pkg?: string
  sudo: boolean
  checks: SetupCheck[]
  agents: { kind: AgentKind; installed: boolean; version?: string; signedIn: boolean }[]
  keepSession: boolean
}

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
${authTests}
`
  const r = await host.exec(script, { timeoutMs: 30000 })
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
  const agents = AGENT_KINDS.map((k) => {
    const version = get(`VER ${k}`)
    const auth = r.stdout.split('\n').find((l) => l.startsWith(`AUTH ${k} `))?.endsWith('1') ?? false
    return { kind: k, installed: !!version, version: version || undefined, signedIn: auth }
  })
  return { os, pkg, sudo, checks, agents, keepSession }
}

/** Runs one setup step. Installs run non-interactively; sign-ins go through features/signin.ts. */
export async function runSetup(hostId: string, action: string): Promise<{ ok: boolean; output?: string; pane?: string }> {
  const host = registry.host(hostId)
  const report = await setupReport(hostId)
  const pkg = report.pkg
  const root = (cmd: string) => (pkg === 'brew' ? cmd : `sudo -n sh -c ${shq(cmd)}`)
  let cmd: string | undefined
  if (action === 'install:tmux' && pkg) cmd = root(PKG_INSTALL[pkg]('tmux'))
  else if (action === 'install:node' && pkg) cmd = root(PKG_INSTALL[pkg](pkg === 'brew' ? 'node' : 'nodejs npm'))
  else if (action === 'session') {
    const r = await host.exec(`tmux new-session -d -s main -c "$HOME" 2>&1 || tmux new-session -d -c "$HOME" 2>&1`)
    registry.refresh(hostId, 200)
    return { ok: r.code === 0, output: r.stdout + r.stderr }
  } else if (action.startsWith('agent:')) {
    const kind = action.slice(6) as AgentKind
    const def = AGENTS[kind]
    if (!def) throw new HttpError(400, 'Unknown agent')
    if (def.install.needsNode && !report.checks.find((c) => c.id === 'node')?.ok) throw new HttpError(409, 'Install Node.js first')
    // npm -g into the user's prefix when the global one isn't writable
    cmd = def.install.needsNode
      ? `${PATHS}; npm config get prefix | grep -q "^$HOME" || npm config set prefix "$HOME/.npm-global"; ${def.install.cmd}`
      : `${PATHS}; ${def.install.cmd}`
  } else throw new HttpError(400, 'Unknown setup step')
  if (!cmd) throw new HttpError(409, 'No package manager found on that machine')
  const r = await host.exec(cmd, { timeoutMs: 600_000 })
  registry.refresh(hostId, 200)
  return { ok: r.code === 0, output: (r.stdout + r.stderr).slice(-6000) }
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
