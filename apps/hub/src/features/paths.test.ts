import { afterAll, expect, spyOn, test } from 'bun:test'
import { Host } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { isTaskFile, listSubagents, readTranscript, taskOutput } from './features.ts'
import { isSessionId } from '../claude/actions.ts'

const home = '/home/me'
const host = new Host({ id: 'paths', name: 'Paths', kind: 'local' } as any)
const exec = spyOn(host, 'exec').mockResolvedValue({ code: 0, stdout: '', stderr: '' })
// one session keeps its transcripts elsewhere (CLAUDE_CONFIG_DIR)
const sessions = [{ windows: [{ panes: [{ agent: { transcriptPath: '/home/me/.claude-work/projects/-w/abc.jsonl' } }] }] }]
const get = spyOn(registry, 'get').mockReturnValue({ host, probe: { home }, state: { status: 'online', sessions } } as any)
afterAll(() => {
  exec.mockRestore()
  get.mockRestore()
})

test('transcripts are read from Claude projects folders only', async () => {
  for (const ok of ['/home/me/.claude/projects/-x/s.jsonl', '/home/me/.claude-work/projects/-w/abc/subagents/agent-1.jsonl']) {
    await readTranscript('paths', ok)
    await listSubagents('paths', ok)
  }
  for (const bad of [
    '/home/me/.claude/projects/../../.ssh/id.jsonl',
    '/home/me/.claude/projects/-x/./s.jsonl',
    '/etc/.claude/projects/x.jsonl',
    '/home/me/other/.claude/projects/x.jsonl',
    'relative/.claude/projects/x.jsonl',
    '/home/me/.claude/projects/-x/s.txt',
  ]) {
    await expect(readTranscript('paths', bad)).rejects.toThrow('Bad transcript path')
    await expect(listSubagents('paths', bad)).rejects.toThrow('Bad transcript path')
  }
})

test('task output only from temp folders or agy under home', async () => {
  expect(isTaskFile('/tmp/claude-1000/-p/s1/tasks/b1.output', home)).toBe(true)
  expect(isTaskFile('/private/tmp/claude-501/-p/s1/tasks/b1.output', home)).toBe(true)
  expect(isTaskFile('/home/me/.gemini/antigravity-cli/brain/c1/.system_generated/tasks/t1.log', home)).toBe(true)
  for (const bad of ['/tmp/../home/me/x/tasks/b1.output', '/tmp//tasks/b1.output', '/etc/tasks/b1.output', '/srv/x/.gemini/antigravity-cli/brain/c1/.system_generated/tasks/t1.log'])
    expect(isTaskFile(bad, home)).toBe(false)
  await expect(taskOutput('paths', '/var/lib/tasks/x.output')).rejects.toThrow('Not a task output file')
})

test('a resumed session id must be a UUID before it is typed into a shell', () => {
  for (const ok of [undefined, null, '', '7409eef9-d507-4808-a592-0bfabe896e3a']) expect(isSessionId(ok)).toBe(true)
  for (const bad of ['7409eef9-d507-4808-a592-0bfabe896e3a; rm -rf ~', '$(id)', 'latest', ['7409eef9-d507-4808-a592-0bfabe896e3a'], 42]) expect(isSessionId(bad)).toBe(false)
})
