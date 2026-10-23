import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host, tmuxLiteral } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { launch, renamePane, respawnShell } from './actions.ts'

// tmux expands formats in session names, start folders and window names, and `#(cmd)` runs a
// command. A folder or name with one in it must reach tmux as plain text. A tmux server of the
// test's own, never the user's.
const dir = mkdtempSync(join(tmpdir(), 'inyon-literal-'))
const own = `unset TMUX TMUX_PANE; export TMUX_TMPDIR='${dir}';`
const local = new Host({ id: 'literal', name: 'literal', kind: 'local' } as any)
const host = { ...local, config: local.config, exec: (cmd: string, o?: any) => local.exec(`${own} ${cmd}`, o) } as unknown as Host
// tmux 3.4 (CI's) prints a `$` in a name as `\$`, and its rename-window keeps one there; 3.6 does
// neither. What matters here is that nothing ran and `#` stays as typed.
const tmux = async (args: string) => (await host.exec(`tmux -f /dev/null ${args}`)).stdout.trim().replace(/\\+\$/g, '$')
const socket = `${dir}/tmux-${process.getuid!()}/default`
const ran = (name: string) => join(dir, `ran-${name}`)
/** a format that leaves a file behind if tmux ever runs it (no slash, so it fits in a folder name) */
const runs = (name: string) => `#(cd $TMUX_TMPDIR; touch ran-${name})`
// a folder an agent could have made, whose name runs a command if tmux expands it
const folder = join(dir, `x${runs('folder')}`)

beforeAll(async () => {
  mkdirSync(folder)
  spyOn(registry, 'host').mockReturnValue(host)
  spyOn(registry, 'refresh').mockImplementation(() => {})
  await host.exec(`tmux -f /dev/null new-session -d -s guard 'sleep 600'`)
  if (!(await tmux(`display -p -t guard '#{socket_path}'`)).startsWith(dir)) throw new Error('tmux used a server other than the test\'s own')
})
afterAll(() => mock.restore())
afterAll(async () => {
  await host.exec(`tmux -S '${socket}' kill-server 2>/dev/null; true`)
  rmSync(dir, { recursive: true, force: true })
})

test('a new session in a folder whose name holds #(…) starts there and runs nothing', async () => {
  const pane = await launch('literal', { cwd: folder, name: `a${runs('name')}` } as any)
  await Bun.sleep(500)
  expect(existsSync(ran('folder'))).toBe(false)
  expect(existsSync(ran('name'))).toBe(false)
  expect(await tmux(`display -p -t ${pane} '#{pane_start_path}'`)).toBe(folder)
  // # can't be in a session name at all, as . and : can't
  expect(await tmux(`display -p -t ${pane} '#{session_name}'`)).toBe('a-(cd $TMUX_TMPDIR; touch ran-name)')
  // a window opened in that folder in an existing session, as Fork does
  const more = await launch('literal', { cwd: folder, session: 'guard' } as any)
  await Bun.sleep(300)
  expect(existsSync(ran('folder'))).toBe(false)
  expect(await tmux(`display -p -t ${more} '#{pane_start_path}'`)).toBe(folder)
}, 15_000)

test('renaming a plain terminal keeps the name as typed', async () => {
  const pane = await tmux(`new-session -d -s plain -P -F '#{pane_id}'`)
  spyOn(registry, 'findPane').mockReturnValue({ session: { name: 'plain' }, pane: { id: pane } } as any)
  await renamePane('literal', pane, `build ${runs('rename')} ##2`)
  await Bun.sleep(300)
  expect(existsSync(ran('rename'))).toBe(false)
  expect(await tmux(`display -p -t ${pane} '#{window_name}'`)).toBe(`build ${runs('rename')} ##2`)
})

test('a restarted shell gets its folder doubled for tmux, but not on psmux', () => {
  expect(respawnShell(false, "'%1'", '/srv/x#y')).toContain(`-c '/srv/x##y'`)
  expect(respawnShell(true, "'%1'", 'C:/code/C#')).toContain(`-c 'C:/code/C#'`)
  expect(tmuxLiteral('#{pane_id} #(id)')).toBe('##{pane_id} ##(id)')
})
