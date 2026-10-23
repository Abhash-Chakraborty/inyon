import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { registry } from '../hosts/registry.ts'
import { forkConversation } from './actions.ts'
import { asKeys } from '../tmux/as-keys.ts'

afterAll(() => mock.restore())

const id = '0b6e2a52-3c1d-4f7a-9e44-5d1f0c2b7a19'
const ran: string[] = []
// what was typed, with send-keys' own quoting taken off
const typed = () => ran.filter((c) => c.includes('send-keys')).map((c) => c.replaceAll("'\\''", "'")).join('\n')
const host = {
  exec: async (typed: string, opts: { input?: string } = {}) => {
    const { cmd } = asKeys(typed, opts.input)
    ran.push(cmd)
    if (cmd.startsWith('test -s')) return { code: 0, stdout: 'yes\n', stderr: '' }
    if (cmd.includes('new-window')) return { code: 0, stdout: '%9\n', stderr: '' }
    if (cmd.includes('capture-pane')) return { code: 0, stdout: '@@CAP %9\nuser@box ~/app $ \n', stderr: '' }
    if (cmd.includes('/cmdline')) return { code: 0, stdout: `/usr/bin/node\n/home/u/.local/bin/${cmd.includes('/41/') ? 'codex' : 'claude'}\n--model\nopus\n`, stderr: '' }
    if (cmd.includes('command -v')) return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  },
}
spyOn(registry, 'host').mockReturnValue(host as any)
spyOn(registry, 'refresh').mockImplementation(() => {})
const pane = (kind: string, extra: object = {}) =>
  spyOn(registry, 'findPane').mockReturnValue({ session: { name: 'work' }, pane: { id: '%1', cwd: '/home/u/app', agent: { kind, sessionId: id, transcriptPath: '/t.jsonl', ...extra } } } as any)

test('a Claude conversation forks into a new window, same folder and flags', async () => {
  pane('claude')
  spyOn(registry, 'agentProc').mockReturnValue({ pid: 40, cwd: '/home/u/app', args: 'claude --model opus' } as any)
  ran.length = 0
  expect(await forkConversation('h', '%1')).toBe('%9')
  expect(ran.find((c) => c.includes('new-window'))).toBe(`tmux new-window -t 'work' -c '/home/u/app' -P -F '#{pane_id}'`)
  expect(typed()).toContain(`-t '%9' -l -- 'claude --resume ${id} '--model' 'opus' --fork-session'`)
})

test('Codex uses its fork command', async () => {
  pane('codex')
  spyOn(registry, 'agentProc').mockReturnValue({ pid: 41, cwd: '/home/u/app', args: 'codex --model opus' } as any)
  ran.length = 0
  await forkConversation('h', '%1')
  expect(typed()).toContain(`codex fork ${id} '--model' 'opus'`)
})

test('nothing to fork before the first message, and not every agent forks', async () => {
  pane('claude', { sessionId: undefined })
  await expect(forkConversation('h', '%1')).rejects.toThrow('No conversation to fork yet')
  pane('antigravity')
  await expect(forkConversation('h', '%1')).rejects.toThrow('Only Claude Code, Codex and OpenCode')
})
