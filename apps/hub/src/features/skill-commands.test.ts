import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Host } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { listCommands } from './features.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())
const home = mkdtempSync('/tmp/tether-skills-')
afterAll(() => rmSync(home, { recursive: true, force: true }))

const skill = (dir: string, name: string, description: string) => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody\n`)
}
// a repo with the pane open in a folder inside it
const repo = join(home, 'repo')
mkdirSync(join(repo, 'apps/web'), { recursive: true })
Bun.spawnSync(['git', 'init', '-q', repo])

const local = new Host({ id: 'skills-test', name: 'Box', kind: 'local' } as any)
// the machine's own HOME is the test folder, so nothing real is read
const host = { config: local.config, exec: (cmd: string, o?: any) => local.exec(`export HOME='${home}'; ${cmd}`, o) } as unknown as Host
const pane = (kind: string) => ({ pane: { id: '%9', cwd: join(repo, 'apps/web'), agent: { kind } } })
spyOn(registry, 'get').mockReturnValue({ host, probe: { home } } as any)

test('Codex lists its skills as $name, from the repo root, its home and plugins', async () => {
  skill(join(repo, '.agents/skills'), 'impeccable', 'Design work')
  skill(join(home, '.codex/skills'), 'mine', 'My own skill')
  skill(join(home, '.codex/skills/.system'), 'imagegen', 'Make images')
  skill(join(home, '.codex/plugins/cache/market/google-drive/0.1.9/skills'), 'google-slides', 'Old copy')
  skill(join(home, '.codex/plugins/cache/market/google-drive/0.1.20/skills'), 'google-slides', 'Slides')
  spyOn(registry, 'findPane').mockReturnValue(pane('codex') as any)
  const list = await listCommands('skills-test', '%9')
  const byName = new Map(list.map((c) => [c.name, c]))
  expect(byName.get('$impeccable')).toMatchObject({ source: 'project', description: 'Design work' })
  expect(byName.get('$mine')?.source).toBe('skill')
  expect(byName.get('$imagegen')?.source).toBe('skill')
  // the newest cached version of a plugin wins
  expect(byName.get('$google-drive:google-slides')).toMatchObject({ source: 'plugin', description: 'Slides' })
  // built-in commands are still there
  expect(byName.has('/model')).toBe(true)
})

test('Claude finds a project skill in the repo root while the pane is in a folder inside it', async () => {
  spyOn(registry, 'findPane').mockReturnValue(pane('claude') as any)
  skill(join(repo, '.claude/skills'), 'tether-ui', 'UI rules')
  expect((await listCommands('skills-test', '%9')).find((c) => c.name === '/tether-ui')?.source).toBe('project')
})
