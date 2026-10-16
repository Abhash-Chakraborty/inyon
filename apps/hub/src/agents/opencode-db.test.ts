import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OCDB, OcdbCache, guessOpenCodeSession, ocdbRows, ocdbSessionInfo, ocdbSessions, ocdbShape, ocdbStamp, ocdbTodos } from './opencode-db.ts'

// A database laid out like OpenCode's, read through the reader's real shell script (sqlite3 or
// python3, whichever the machine has), so a slow path shows up here as a slow test.
const root = mkdtempSync(join(tmpdir(), 'inyon-ocdb-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const S = 'ses_test0000000000000000001'
const OLDER = 'ses_test0000000000000000002'
mkdirSync(join(root, 'opencode'))
const db = new Database(join(root, 'opencode/opencode.db'))
db.exec(`create table session (id text primary key, title text, directory text, parent_id text, time_created integer, time_updated integer, time_archived integer, agent text, model text, revert text, cost real, summary_additions integer, summary_deletions integer, summary_files integer);
create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
create table todo (session_id text, content text, status text, position integer)`)
db.exec(`insert into session values ('${S}', 'Greeting', '/work', null, 1000, 5000, null, 'build', 'x/y', null, 0.5, 3, 1, 2)`)
db.exec(`insert into session values ('${OLDER}', 'Older talk', '/work', null, 500, 900, null, null, null, null, null, null, null, null)`)
// a user message whose summary carries the turn's whole diff: two megabytes of lock file
const diff = 'x'.repeat(2_000_000)
db.query('insert into message values (?, ?, ?, ?, ?)').run('msg_1', S, 1000, 1000, JSON.stringify({ role: 'user', time: { created: 1000 }, summary: { diffs: [{ file: 'Cargo.lock', patch: diff }] } }))
db.query('insert into message values (?, ?, ?, ?, ?)').run('msg_2', S, 2000, 5000, JSON.stringify({ role: 'assistant', time: { created: 2000 }, modelID: 'y', providerID: 'x', cost: 0.5 }))
db.query('insert into part values (?, ?, ?, ?, ?, ?)').run('prt_1', 'msg_1', S, 1000, 1000, JSON.stringify({ type: 'text', text: 'hi' }))
db.query('insert into part values (?, ?, ?, ?, ?, ?)').run('prt_2', 'msg_2', S, 2000, 2000, JSON.stringify({ type: 'text', text: 'hello "there"\nline | two' }))
db.exec(`insert into todo values ('${S}', 'second', 'pending', 2), ('${S}', 'first', 'completed', 1)`)
db.close()

/** a machine whose OpenCode data lives in `dataDir` */
const machine = (dataDir: string) =>
  ({
    exec: async (cmd: string, opts?: { timeoutMs?: number }) => {
      const p = Bun.spawn(['/bin/sh', '-c', cmd], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dataDir, XDG_DATA_HOME: dataDir }, stdout: 'pipe', stderr: 'pipe' })
      const timer = setTimeout(() => p.kill('SIGKILL'), opts?.timeoutMs ?? 15_000)
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      clearTimeout(timer)
      return { code, stdout, stderr }
    },
  }) as any
const host = machine(root)

test('a conversation is read in milliseconds, whatever its diff summaries weigh', async () => {
  const t0 = performance.now()
  const rows = await ocdbRows(host, S)
  expect(performance.now() - t0).toBeLessThan(4000)
  expect(rows.messages.map((m) => m.id)).toEqual(['msg_1', 'msg_2'])
  expect(rows.parts.map((p) => p.id)).toEqual(['prt_1', 'prt_2'])
  // the summary stays in the database: nothing in the chat shows it
  expect(JSON.parse(rows.messages[0].data)).toEqual({ role: 'user', time: { created: 1000 } })
  const cache = new OcdbCache()
  cache.merge(rows)
  expect(cache.stamp).toBe(5000)
  expect(cache.list().map((m) => m.parts[0].text)).toEqual(['hi', 'hello "there"\nline | two'])
  // only what moved since the last read
  expect((await ocdbRows(host, S, 2000)).messages.map((m) => m.id)).toEqual(['msg_2'])
})

test("the folder's conversations come newest first, and the pane title names the one on screen", async () => {
  expect((await ocdbSessions(host, '/work')).map((r) => r.id)).toEqual([S, OLDER])
  expect(await guessOpenCodeSession(host, { cwd: '/work', startedAt: 0 }, undefined, 'OC | Older talk')).toBe(OCDB + OLDER)
  expect(await guessOpenCodeSession(host, { cwd: '/work', startedAt: 0 }, undefined, 'OpenCode')).toBe(OCDB)
})

test('stamp, shape, info and todos', async () => {
  expect(await ocdbStamp(host, S)).toBe(5000)
  const shape = await ocdbShape(host, S)
  expect([...shape.ids].sort()).toEqual(['msg_1', 'msg_2'])
  expect(shape.revert).toBeUndefined()
  expect(await ocdbSessionInfo(host, S)).toEqual({ title: 'Greeting', cost: 0.5, additions: 3, deletions: 1, files: 2 })
  expect(await ocdbTodos(host, S)).toEqual([
    { content: 'first', status: 'completed' },
    { content: 'second', status: 'pending' },
  ])
  expect(await ocdbRows(host, 'ses_nothing')).toEqual({ messages: [], parts: [] })
})

test('a machine without the database answers with nothing, not an error', async () => {
  const bare = machine(mkdtempSync(join(root, 'bare-')))
  expect(await ocdbSessions(bare, '/work')).toEqual([])
  expect(await ocdbStamp(bare, S)).toBe(0)
})
