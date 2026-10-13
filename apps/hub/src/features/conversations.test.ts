import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Host } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { setSessionName } from '../hosts/names.ts'
import { agyTime, jsonStringAt, listConversations, oneLine, paneConversations, switchConversation, switchSteps, yamlScalar } from './conversations.ts'

// A throwaway home with each agent's files in it: the real ~/.claude, ~/.codex and the rest are
// never read.
const home = mkdtempSync(join(tmpdir(), 'inyon-convos-'))
const local = new Host({ id: 'convos', name: 'convos', kind: 'local' } as any)
const own = `export HOME='${home}'; unset CODEX_HOME XDG_DATA_HOME;`
const host = { ...local, config: local.config, exec: (cmd: string, o?: any) => local.exec(`${own} ${cmd}`, o) } as unknown as Host

const CWD = '/work/app'
const OTHER = '/work/other'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const day = Date.UTC(2026, 9, 12) / 1000

/** Writes a file and sets when it was last written, in seconds. */
function file(path: string, lines: unknown[], mtime: number) {
  const p = join(home, path)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  utimesSync(p, mtime, mtime)
}

const userLine = (text: unknown, extra: object = {}) => ({ type: 'user', ...extra, message: { role: 'user', content: text } })

describe('Claude Code', () => {
  const dir = '.claude/projects/-work-app'
  file(`${dir}/${id(1)}.jsonl`, [{ type: 'mode' }, userLine('Fix the login page'), { type: 'ai-title', aiTitle: 'Login fix' }, { type: 'custom-title', customTitle: 'Auth work' }, { type: 'ai-title', aiTitle: 'Login fix again' }], day + 300)
  file(`${dir}/${id(2)}.jsonl`, [userLine('<local-command-caveat>Caveat: ignore</local-command-caveat>'), userLine('<command-name>/model</command-name>'), userLine([{ type: 'text', text: 'Write   the\nREADME' }]), { type: 'ai-title', aiTitle: 'Readme draft' }], day + 200)
  file(`${dir}/${id(3)}.jsonl`, [{ type: 'mode' }, userLine('ignored', { isMeta: true }), userLine('Plan the "release" notes')], day + 100)
  // opened and closed without a word: nothing to resume
  file(`${dir}/${id(4)}.jsonl`, [{ type: 'mode' }, { type: 'permission-mode' }], day + 400)
  file(`.claude/projects/-work-other/${id(5)}.jsonl`, [userLine('Elsewhere')], day + 500)

  test('lists the folder newest first, with /rename over the made-up title over the first prompt', async () => {
    const list = await listConversations(host, 'claude', CWD)
    expect(list).toEqual([
      { id: id(1), title: 'Auth work', at: (day + 300) * 1000 },
      { id: id(2), title: 'Readme draft', at: (day + 200) * 1000 },
      { id: id(3), title: 'Plan the "release" notes', at: (day + 100) * 1000 },
    ])
  })

  test('a folder with no transcripts has none', async () => {
    expect(await listConversations(host, 'claude', '/nowhere')).toEqual([])
  })
})

describe('Codex', () => {
  const meta = (n: number, cwd: string, source: unknown) => ({ timestamp: '2026-10-12T00:00:00Z', type: 'session_meta', payload: { id: id(n), cwd, source, instructions: 'x'.repeat(2000) } })
  const msg = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
  const env = msg('<environment_context>\n  <cwd>/work/app</cwd>\n</environment_context>')
  const roll = (n: number, seg = '') => `.codex/sessions/2026/10/12/rollout-2026-10-12T00-00-00-${id(n)}${seg}.jsonl`
  file(roll(10), [meta(10, CWD, 'cli'), env, msg('Add a dark mode'), msg('later')], day + 50)
  file(roll(11), [meta(11, CWD, 'vscode'), env, msg('Speed up the build')], day + 60)
  // the same thread continued in a segment file after a rewind
  file(roll(11, `_${id(99)}`), [meta(11, CWD, 'vscode'), msg('Rewound')], day + 90)
  file(roll(12), [meta(12, CWD, 'exec'), msg('From a script')], day + 70)
  file(roll(13), [meta(13, CWD, { subagent: { thread_spawn: {} } }), msg('Subagent work')], day + 80)
  file(roll(14), [meta(14, OTHER, 'cli'), msg('Other folder')], day + 85)
  file(roll(15), [meta(15, CWD, 'cli'), env], day + 95)
  file('.codex/session_index.jsonl', [{ id: id(10), thread_name: 'Dark mode' }, { id: id(10), thread_name: 'Dark mode toggle' }], day)

  test("lists the folder's threads from Codex's terminal and editor, named as Codex names them", async () => {
    const list = await listConversations(host, 'codex', CWD)
    expect(list).toEqual([
      { id: id(11), title: 'Speed up the build', at: (day + 90) * 1000 },
      { id: id(10), title: 'Dark mode toggle', at: (day + 50) * 1000 },
    ])
  })
})

describe('GitHub Copilot', () => {
  const s = '.copilot/session-state'
  const ws = (n: number, lines: string[], mtime: number, events: unknown[] = [{ type: 'session.start', data: { context: { cwd: CWD } } }]) => {
    file(`${s}/${id(n)}/workspace.yaml`, lines, mtime)
    file(`${s}/${id(n)}/events.jsonl`, events, mtime)
  }
  ws(20, [`id: ${id(20)}`, `cwd: ${CWD}`, 'name: Fix flaky tests', 'user_named: false'], day + 20)
  ws(21, [`id: ${id(21)}`, `cwd: "${CWD}"`, `name: 'It''s quoted'`], day + 30)
  ws(22, [`id: ${id(22)}`, `cwd: ${CWD}`], day + 40, [{ type: 'session.start', data: { context: { cwd: CWD } } }, { type: 'user.message', data: { content: 'No name yet' } }])
  ws(23, [`id: ${id(23)}`, `cwd: ${OTHER}`, 'name: Elsewhere'], day + 50)
  // before workspace.yaml: the first event says where it ran
  file(`${s}/${id(24)}/events.jsonl`, [{ type: 'session.start', data: { context: { cwd: CWD } } }, { type: 'user.message', data: { content: 'Old style' } }], day + 10)

  test("lists the folder's sessions by their names, or the first prompt", async () => {
    const list = await listConversations(host, 'copilot', CWD)
    expect(list.map((c) => [c.id, c.title])).toEqual([
      [id(22), 'No name yet'],
      [id(21), "It's quoted"],
      [id(20), 'Fix flaky tests'],
      [id(24), 'Old style'],
    ])
  })
})

describe('OpenCode', () => {
  mkdirSync(join(home, '.local/share/opencode'), { recursive: true })
  const db = new Database(join(home, '.local/share/opencode/opencode.db'))
  db.run('create table session (id text primary key, title text, directory text, parent_id text, time_created integer, time_updated integer, agent text, model text, time_archived integer)')
  const add = db.prepare('insert into session values (?, ?, ?, ?, ?, ?, null, null, ?)')
  add.run('ses_new', 'Refactor parser', CWD, null, 1, 2000, null)
  add.run('ses_old', 'Write tests', CWD, null, 1, 1000, null)
  add.run('ses_child', 'Subtask', CWD, 'ses_new', 1, 3000, null)
  add.run('ses_gone', 'Archived', CWD, null, 1, 4000, 5)
  add.run('ses_far', 'Other', OTHER, null, 1, 5000, null)
  db.close()

  test("lists the folder's top-level, unarchived sessions", async () => {
    expect(await listConversations(host, 'opencode', CWD)).toEqual([
      { id: 'ses_new', title: 'Refactor parser', at: 2000 },
      { id: 'ses_old', title: 'Write tests', at: 1000 },
    ])
  })
})

describe('Antigravity CLI', () => {
  mkdirSync(join(home, '.gemini/antigravity-cli'), { recursive: true })
  const db = new Database(join(home, '.gemini/antigravity-cli/conversation_summaries.db'))
  db.run("create table conversation_summaries (conversation_id text primary key, title text not null default '', preview text not null default '', last_modified_time datetime not null, workspace_uris text not null, parent_conversation_id text not null default '', nesting_depth integer not null default 0)")
  const add = db.prepare('insert into conversation_summaries values (?, ?, ?, ?, ?, ?, ?)')
  const uris = (...dirs: string[]) => JSON.stringify(dirs.map((d) => `file://${d}`))
  add.run(id(30), 'Ship the CLI', 'ship it', '2026-10-11 08:22:33.43735957+00:00', uris('/home/u/.inyon/uploads', CWD), '', 0)
  add.run(id(31), '', 'Only a preview', '2026-10-10 10:00:00.5+00:00', uris(CWD), '', 0)
  add.run(id(32), 'Child', '', '2026-10-12 10:00:00+00:00', uris(CWD), id(30), 1)
  add.run(id(33), 'Prefix folder', '', '2026-10-12 11:00:00+00:00', uris(`${CWD}-old`), '', 0)
  add.run(id(34), 'Spaces', '', '2026-10-12 12:00:00+00:00', JSON.stringify([`file://${encodeURI('/work/my app')}`]), '', 0)
  db.close()

  test("lists the folder's conversations, not subagents' or a folder sharing its name's start", async () => {
    expect(await listConversations(host, 'antigravity', CWD)).toEqual([
      { id: id(30), title: 'Ship the CLI', at: Date.parse('2026-10-11T08:22:33.437Z') },
      { id: id(31), title: 'Only a preview', at: Date.parse('2026-10-10T10:00:00.5Z') },
    ])
  })

  test('folders written as URIs match their plain path', async () => {
    expect((await listConversations(host, 'antigravity', '/work/my app')).map((c) => c.title)).toEqual(['Spaces'])
  })

  test("agy's times parse", () => {
    expect(agyTime('2026-10-11 08:22:33.43735957+00:00')).toBe(Date.parse('2026-10-11T08:22:33.437Z'))
    expect(agyTime('nonsense')).toBe(0)
  })
})

describe('reading lines cut short on the machine', () => {
  test('a JSON string stops at its end, or where the line was cut', () => {
    expect(jsonStringAt('"a\\"b\\nc" tail', 1)).toBe('a"b\nc')
    expect(jsonStringAt('"caf\\u00e9 and more', 1)).toBe('café and more')
    // a cut in the middle of an escape drops the broken part
    expect(jsonStringAt('"half \\u00', 1)).toBe('half ')
    expect(jsonStringAt('"ends with \\', 1)).toBe('ends with ')
  })

  test('titles are one line without the tags agents wrap prompts in', () => {
    expect(oneLine('<system-reminder>hidden</system-reminder>\n Fix  the\tbug ')).toBe('Fix the bug')
    expect(oneLine('x'.repeat(500)).length).toBe(200)
  })

  test('YAML scalars', () => {
    expect(yamlScalar(' plain words ')).toBe('plain words')
    expect(yamlScalar(' "a: \\"b\\"" ')).toBe('a: "b"')
    expect(yamlScalar(" 'it''s' ")).toBe("it's")
  })
})

describe('a pane', () => {
  const pane = (agent?: object) => ({ session: { windows: [] }, window: { panes: [] }, pane: { id: '%7', cwd: CWD, agent } }) as any
  beforeEach(() => {
    spyOn(registry, 'host').mockReturnValue(host)
    spyOn(registry, 'agentProc').mockReturnValue(undefined)
  })

  test("lists the running agent's conversations, marks the open one, and shows names given in Inyon", async () => {
    spyOn(registry, 'findPane').mockReturnValue(pane({ kind: 'copilot', sessionId: id(21) }))
    setSessionName('convos', id(20), 'Named in Inyon', undefined, 'copilot')
    const r = await paneConversations('convos', '%7', 'claude')
    expect(r.agent).toBe('copilot')
    expect(r.conversations.find((c) => c.id === id(21))?.current).toBe(true)
    expect(r.conversations.find((c) => c.id === id(20))?.title).toBe('Named in Inyon')
    expect(r.conversations.filter((c) => c.current)).toHaveLength(1)
  })

  test('with no agent running, lists the one asked for', async () => {
    spyOn(registry, 'findPane').mockReturnValue(pane())
    expect((await paneConversations('convos', '%7', 'claude')).conversations.map((c) => c.id)).toEqual([id(1), id(2), id(3)])
    await expect(paneConversations('convos', '%7')).rejects.toThrow('Say which agent')
    await expect(paneConversations('convos', '%7', 'nope')).rejects.toThrow('Unknown agent')
  })

  test('agents Inyon cannot list say so', async () => {
    spyOn(registry, 'findPane').mockReturnValue(pane({ kind: 'gemini' }))
    await expect(paneConversations('convos', '%7')).rejects.toThrow("can't list Gemini")
  })
})

describe('switching', () => {
  const calls: string[] = []
  const steps = { ...switchSteps }
  const pane = (agent?: object) => ({ session: { windows: [] }, window: { panes: [] }, pane: { id: '%7', cwd: CWD, agent } }) as any
  let release: () => void = () => {}
  beforeEach(() => {
    calls.length = 0
    spyOn(registry, 'host').mockReturnValue(host)
    switchSteps.exit = async (_h, p) => void calls.push(`exit ${p}`)
    switchSteps.ready = async (_h, p) => void calls.push(`ready ${p}`)
    switchSteps.start = async (_h, p, kind, resume) => void calls.push(`start ${p} ${kind} ${resume}`)
  })
  afterAll(() => Object.assign(switchSteps, steps))

  test('exits the running agent, waits for the shell, then resumes the other conversation', async () => {
    spyOn(registry, 'findPane').mockReturnValue(pane({ kind: 'claude', sessionId: id(1) }))
    expect(await switchConversation('convos', '%7', 'claude', id(2))).toEqual({ switched: true })
    expect(calls).toEqual(['exit %7', 'ready %7', `start %7 claude ${id(2)}`])
  })

  test('with nothing running, just starts it', async () => {
    spyOn(registry, 'findPane').mockReturnValue(pane())
    await switchConversation('convos', '%7', 'codex', id(10))
    expect(calls).toEqual([`start %7 codex ${id(10)}`])
  })

  test('the open conversation is left as it is', async () => {
    spyOn(registry, 'findPane').mockReturnValue(pane({ kind: 'claude', sessionId: id(1) }))
    expect(await switchConversation('convos', '%7', 'claude', id(1))).toEqual({ switched: false })
    expect(calls).toEqual([])
  })

  test('refuses an id a shell could read as more, and another agent', async () => {
    spyOn(registry, 'findPane').mockReturnValue(pane({ kind: 'claude', sessionId: id(1) }))
    await expect(switchConversation('convos', '%7', 'claude', `${id(2)}; rm -rf ~`)).rejects.toThrow('Bad conversation id')
    await expect(switchConversation('convos', '%7', 'claude', '')).rejects.toThrow('Bad conversation id')
    await expect(switchConversation('convos', '%7', 'codex', id(2))).rejects.toMatchObject({ status: 409 })
    expect(calls).toEqual([])
  })

  test('a second switch while one is under way is refused', async () => {
    spyOn(registry, 'findPane').mockReturnValue(pane({ kind: 'claude', sessionId: id(1) }))
    switchSteps.exit = () => new Promise<void>((r) => (release = r))
    const first = switchConversation('convos', '%7', 'claude', id(2))
    await expect(switchConversation('convos', '%7', 'claude', id(3))).rejects.toMatchObject({ status: 409 })
    release()
    await first
  })

  test("an agent that won't exit fails the switch, and nothing is started", async () => {
    spyOn(registry, 'findPane').mockReturnValue(pane({ kind: 'claude', sessionId: id(1) }))
    switchSteps.exit = async () => {
      throw Object.assign(new Error('Claude Code did not exit'), { status: 504 })
    }
    await expect(switchConversation('convos', '%7', 'claude', id(2))).rejects.toThrow('did not exit')
    expect(calls).toEqual([])
  })
})

afterAll(() => mock.restore())
