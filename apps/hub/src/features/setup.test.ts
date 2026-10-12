import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS } from '@inyon/protocol'
import { installCommand } from './setup.ts'

// The real install commands, run against a stand-in curl and npm: nothing is downloaded.
const root = mkdtempSync(join(tmpdir(), 'inyon-setup-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** an installer that puts a working `codex` in ~/.local/bin, as the real one does */
const INSTALLER = `mkdir -p "$HOME/.local/bin"; printf '#!/bin/sh\\necho codex 1.0\\n' > "$HOME/.local/bin/codex"; chmod +x "$HOME/.local/bin/codex"`

function machine({ download, npm }: { download: boolean; npm: boolean }) {
  const home = mkdtempSync(join(root, 'home-'))
  const bin = join(home, 'tools')
  mkdirSync(bin)
  // like `curl -fsSL`, a failed download prints nothing, so the piped shell still exits 0
  writeFileSync(join(bin, 'installer.sh'), INSTALLER)
  writeFileSync(join(bin, 'curl'), download ? `#!/bin/sh\ncat '${bin}/installer.sh'\n` : '#!/bin/sh\nexit 22\n', { mode: 0o755 })
  if (npm) writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "npm $*" >> "$HOME/npm-calls"\n[ "$1" = config ] && [ "$2" = get ] && echo "$HOME/.npm-global"\nexit 0\n`, { mode: 0o755 })
  const run = (cmd: string) => {
    const r = Bun.spawnSync(['sh', '-c', cmd], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } })
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
  }
  const npmCalls = () => (existsSync(join(home, 'npm-calls')) ? readFileSync(join(home, 'npm-calls'), 'utf8').trim().split('\n') : [])
  return { home, run, npmCalls }
}

test("an agent's own installer is used, and npm isn't touched when it works", () => {
  const m = machine({ download: true, npm: true })
  const r = m.run(installCommand(AGENTS.codex))
  expect(r.code).toBe(0)
  expect(existsSync(join(m.home, '.local/bin/codex'))).toBe(true)
  expect(m.npmCalls()).toEqual([])
})

test('when the installer fails quietly, its npm package is installed instead', () => {
  const m = machine({ download: false, npm: true })
  const r = m.run(installCommand(AGENTS.codex))
  expect(r.code).toBe(0)
  expect(r.out).toContain('trying npm instead')
  expect(m.npmCalls()).toContain('npm install -g @openai/codex')
})

test('when the installer fails and there is no npm, the step fails and says why', () => {
  const m = machine({ download: false, npm: false })
  const r = m.run(installCommand(AGENTS.codex))
  expect(r.code).not.toBe(0)
  expect(r.out).toContain("there's no npm here")
})

test('an agent with no installer of its own goes straight to npm', () => {
  const m = machine({ download: true, npm: true })
  expect(m.run(installCommand(AGENTS.gemini)).code).toBe(0)
  expect(m.npmCalls()).toContain('npm install -g @google/gemini-cli')
})
