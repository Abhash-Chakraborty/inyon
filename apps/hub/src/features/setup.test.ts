import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS } from '@inyon/protocol'
import { failureHint, installCommand, installedVia, manualCommand, runSetup, setupReport, updateCommand } from './setup.ts'
import { registry } from '../hosts/registry.ts'
import { forgetLatest } from './agent-latest.ts'

// The real install commands, run against a stand-in curl and npm: nothing is downloaded. The PATH
// holds only the stand-ins and a few basic tools, so a real npm on the test machine isn't found.
const root = mkdtempSync(join(tmpdir(), 'inyon-setup-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterAll(() => mock.restore())

/** an installer that puts a working `codex` in ~/.local/bin, as the real one does */
const PATHS = 'export PATH="$HOME/.local/bin:$PATH"'
const INSTALLER = `mkdir -p "$HOME/.local/bin"; printf '#!/bin/sh\\necho codex 1.0\\n' > "$HOME/.local/bin/codex"; chmod +x "$HOME/.local/bin/codex"`

function machine({ download, npm }: { download: boolean; npm: boolean }) {
  const home = mkdtempSync(join(root, 'home-'))
  const bin = join(home, 'tools')
  mkdirSync(bin)
  for (const tool of ['sh', 'cat', 'mkdir', 'chmod', 'grep']) symlinkSync(Bun.which(tool)!, join(bin, tool))
  // like `curl -fsSL`, a failed download prints nothing, so the piped shell still exits 0
  writeFileSync(join(bin, 'installer.sh'), INSTALLER)
  writeFileSync(join(bin, 'curl'), download ? `#!/bin/sh\ncat '${bin}/installer.sh'\n` : '#!/bin/sh\nexit 22\n', { mode: 0o755 })
  if (npm) writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "npm $*" >> "$HOME/npm-calls"\n[ "$1" = config ] && [ "$2" = get ] && echo "$HOME/.npm-global"\nexit 0\n`, { mode: 0o755 })
  const run = (cmd: string) => {
    const r = Bun.spawnSync(['sh', '-c', cmd], { cwd: home, env: { HOME: home, PATH: bin } })
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
  }
  const npmCalls = () => (existsSync(join(home, 'npm-calls')) ? readFileSync(join(home, 'npm-calls'), 'utf8').trim().split('\n') : [])
  return { home, run, npmCalls }
}

test("an agent's own installer is used, and npm isn't touched when it works", () => {
  const m = machine({ download: true, npm: true })
  const r = m.run(installCommand(AGENTS.codex, PATHS))
  expect(r.code).toBe(0)
  expect(existsSync(join(m.home, '.local/bin/codex'))).toBe(true)
  expect(m.npmCalls()).toEqual([])
})

test('when the installer fails quietly, its npm package is installed instead', () => {
  const m = machine({ download: false, npm: true })
  const r = m.run(installCommand(AGENTS.codex, PATHS))
  expect(r.code).toBe(0)
  expect(r.out).toContain('trying npm instead')
  expect(m.npmCalls()).toContain('npm install -g @openai/codex')
})

test('when the installer fails and there is no npm, the step fails and says why', () => {
  const m = machine({ download: false, npm: false })
  const r = m.run(installCommand(AGENTS.codex, PATHS))
  expect(r.code).not.toBe(0)
  expect(r.out).toContain("there's no npm here")
})

test('an agent with no installer of its own goes straight to npm', () => {
  const m = machine({ download: true, npm: true })
  expect(m.run(installCommand(AGENTS.gemini, PATHS)).code).toBe(0)
  expect(m.npmCalls()).toContain('npm install -g @google/gemini-cli')
})

// ---------- updates ----------

test('how an agent was installed: npm when its package is listed or its program sits in node_modules', () => {
  const globals = '/usr/lib /usr/lib/node_modules/@openai/codex /usr/lib/node_modules/npm'
  expect(installedVia(AGENTS.codex, '/usr/bin/codex', globals)).toBe('npm')
  expect(installedVia(AGENTS.codex, '/home/me/.local/bin/codex', '')).toBe('installer')
  expect(installedVia(AGENTS.claude, '/home/me/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js', '')).toBe('npm')
  expect(installedVia(AGENTS.claude, '/home/me/.local/bin/claude', globals)).toBe('installer')
  expect(installedVia(AGENTS.antigravity, '/home/me/.local/bin/agy', globals)).toBe('installer')
})

test('the update step: npm for an npm install, else the agent’s own updater, else its installer', () => {
  expect(updateCommand(AGENTS.codex, 'npm', PATHS)).toBe(`${PATHS}; { npm config get prefix | grep -q "^$HOME" || npm config set prefix "$HOME/.npm-global"; npm install -g @openai/codex@latest; }`)
  expect(updateCommand(AGENTS.claude, 'npm', PATHS)).toContain('npm install -g @anthropic-ai/claude-code@latest')
  expect(updateCommand(AGENTS.codex, 'installer', PATHS)).toBe(`${PATHS}; codex update`)
  expect(updateCommand(AGENTS.claude, 'installer', PATHS)).toBe(`${PATHS}; claude update`)
  expect(updateCommand(AGENTS.opencode, 'installer', PATHS)).toBe(`${PATHS}; opencode upgrade`)
  expect(updateCommand(AGENTS.copilot, 'installer', PATHS)).toBe(`${PATHS}; copilot update`)
  expect(updateCommand(AGENTS.antigravity, 'installer', PATHS)).toBe(`${PATHS}; agy update`)
  // Gemini CLI has no updater of its own: npm again, which is also its installer
  expect(updateCommand(AGENTS.gemini, 'installer', PATHS)).toBe(installCommand(AGENTS.gemini, PATHS))
  expect(updateCommand(AGENTS.gemini, 'npm', PATHS)).toContain('npm install -g @google/gemini-cli@latest')
})

test('the command to run by hand is one line', () => {
  expect(manualCommand(AGENTS.codex, 'update', 'npm')).toBe('npm install -g @openai/codex@latest')
  expect(manualCommand(AGENTS.codex, 'update', 'installer')).toBe('codex update')
  expect(manualCommand(AGENTS.gemini, 'update', 'installer')).toBe('npm install -g @google/gemini-cli')
  expect(manualCommand(AGENTS.codex, 'install')).toBe(AGENTS.codex.install.cmd!)
  expect(manualCommand(AGENTS.gemini, 'install')).toBe('npm install -g @google/gemini-cli')
})

test('a failed step is explained in one line', () => {
  expect(failureHint('npm ERR! code EACCES\nnpm ERR! syscall mkdir\nnpm ERR! path /usr/lib/node_modules', '@openai/codex')).toBe(
    'npm can\'t write there; set a user prefix: npm config set prefix "$HOME/.npm-global" && npm install -g @openai/codex@latest',
  )
  expect(failureHint('sh: 1: npm: not found')).toBe('Install Node.js first (the Setup tab can)')
  expect(failureHint('zsh: command not found: npm')).toBe('Install Node.js first (the Setup tab can)')
  expect(failureHint("The installer didn't finish, and there's no npm here to try instead.")).toBe('Install Node.js first (the Setup tab can)')
  expect(failureHint('npm ERR! code ENOTFOUND\nnpm ERR! network request to https://registry.npmjs.org/@openai%2fcodex failed')).toBe("The machine couldn't reach the download; check its network and try again")
  expect(failureHint('curl: (22) The requested URL returned error: 503')).toBe("The machine couldn't reach the download; check its network and try again")
  expect(failureHint('curl: (28) Operation timed out after 4000 milliseconds')).toBe("The machine couldn't reach the download; check its network and try again")
  // a version number with a 50x in it isn't a network error
  expect(failureHint('installed codex 1.0.502\nerror: checksum mismatch')).toBe('error: checksum mismatch')
  expect(failureHint('Checking…\nDone\n')).toBe('Done')
  expect(failureHint('')).toBeUndefined()
})

/** a machine that answers the report script and then the step */
function fakeMachine({ installed, via, step }: { installed: string; via: 'npm' | 'installer'; step: { code: number; out: string; after: string } }) {
  const ran: string[] = []
  const host = {
    exec: async (cmd: string) => {
      ran.push(cmd)
      if (cmd.includes('echo "OS ')) {
        const bin = via === 'npm' ? '/usr/lib/node_modules/@openai/codex/bin/codex.js' : '/home/me/.local/bin/codex'
        return { code: 0, stdout: `OS Linux x86_64\nPKG apt\nSUDO 0\nTMUX tmux 3.4\nSESSIONS 1\nNODE v24.0.0\nNPM 11.0.0\nVER codex ${installed}\nBIN codex ${bin}\nNPMLS /usr/lib\n`, stderr: '' }
      }
      return { code: step.code, stdout: `${step.out}\nINYON_VERSION ${step.after}\n`, stderr: '' }
    },
  }
  spyOn(registry, 'host').mockReturnValue(host as any)
  spyOn(registry, 'refresh').mockImplementation(() => {})
  return { ran }
}

const registryAnswering = (version: string) => (async () => new Response(JSON.stringify({ version }))) as unknown as typeof fetch

const realFetch = globalThis.fetch
afterEach(() => {
  mock.restore()
  forgetLatest()
  globalThis.fetch = realFetch
})

test('the report says which agents are behind, and how each was installed', async () => {
  globalThis.fetch = registryAnswering('0.50.0')
  fakeMachine({ installed: 'codex-cli 0.49.0', via: 'npm', step: { code: 0, out: '', after: '' } })
  const codex = (await setupReport('h')).agents.find((a) => a.kind === 'codex')!
  expect(codex).toEqual({ kind: 'codex', installed: true, version: 'codex-cli 0.49.0', signedIn: false, latest: '0.50.0', via: 'npm', outdated: true })
  const claude = (await setupReport('h')).agents.find((a) => a.kind === 'claude')!
  expect(claude).toEqual({ kind: 'claude', installed: false, signedIn: false, latest: '0.50.0' })
})

test('an update runs the step, reads the new version and reports it', async () => {
  globalThis.fetch = registryAnswering('0.50.0')
  const m = fakeMachine({ installed: 'codex-cli 0.49.0', via: 'npm', step: { code: 0, out: 'added 1 package', after: 'codex-cli 0.50.0' } })
  const r = await runSetup('h', 'update:codex')
  expect(r).toEqual({ ok: true, output: 'added 1 package', version: 'codex-cli 0.50.0', latest: '0.50.0' })
  expect(m.ran[1]).toContain('npm install -g @openai/codex@latest')
  expect(m.ran[1]).toContain('codex --version')
})

test('an installer-installed agent is updated with its own updater', async () => {
  globalThis.fetch = registryAnswering('0.50.0')
  const m = fakeMachine({ installed: 'codex-cli 0.49.0', via: 'installer', step: { code: 0, out: '', after: 'codex-cli 0.50.0' } })
  await runSetup('h', 'update:codex')
  expect(m.ran[1]).toContain('; codex update\n')
  expect(m.ran[1]).not.toContain('npm install')
})

test('a failed update says why, and what to run by hand', async () => {
  globalThis.fetch = registryAnswering('0.50.0')
  fakeMachine({ installed: 'codex-cli 0.49.0', via: 'npm', step: { code: 1, out: 'npm ERR! code EACCES\nnpm ERR! syscall mkdir', after: 'codex-cli 0.49.0' } })
  const r = await runSetup('h', 'update:codex')
  expect(r.ok).toBe(false)
  expect(r.version).toBe('codex-cli 0.49.0')
  expect(r.manual).toBe('npm install -g @openai/codex@latest')
  expect(r.hint).toStartWith("npm can't write there")
  expect(r.output).toBe('npm ERR! code EACCES\nnpm ERR! syscall mkdir')
})

test('an install that ends without the agent is a failure, even when the installer said nothing', async () => {
  globalThis.fetch = registryAnswering('0.50.0')
  fakeMachine({ installed: '', via: 'installer', step: { code: 0, out: '', after: '' } })
  const r = await runSetup('h', 'agent:claude')
  expect(r.ok).toBe(false)
  expect(r.hint).toBe("Claude Code still doesn't run after the step")
  expect(r.manual).toBe(AGENTS.claude.install.cmd!)
})

test('updating an agent that is not installed installs it', async () => {
  globalThis.fetch = registryAnswering('0.50.0')
  const m = fakeMachine({ installed: '', via: 'installer', step: { code: 0, out: '', after: 'codex-cli 0.50.0' } })
  const r = await runSetup('h', 'update:codex')
  expect(r.ok).toBe(true)
  expect(m.ran[1]).toContain('chatgpt.com/codex/install.sh')
})
