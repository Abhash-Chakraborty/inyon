import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { gitCommit, gitDiff, gitStatus, inside, listDir, parseHunks, parseStatus, readFile } from './workspace.ts'

afterAll(() => mock.restore())

const dir = mkdtempSync(join(tmpdir(), 'inyon-ws-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const host = new Host({ id: 'ws', name: 'Ws', kind: 'local' } as any)
spyOn(registry, 'get').mockReturnValue({ host, probe: { home: dir }, state: { status: 'online' } } as any)
spyOn(registry, 'findPane').mockReturnValue({ session: { name: 's' }, pane: { id: '%1', cwd: dir } } as any)
spyOn(registry, 'agentProc').mockReturnValue(undefined)

const git = (cmd: string) => Bun.spawnSync(['sh', '-c', `git -c user.name=T -c user.email=t@t -c commit.gpgsign=false ${cmd}`], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })

test('paths stay inside the session folder', () => {
  expect(inside('src/a.ts')).toBe('src/a.ts')
  expect(inside('./src/')).toBe('src')
  expect(inside('')).toBe('')
  for (const bad of ['../x', 'a/../../b', 'a\nb']) expect(() => inside(bad)).toThrow('Bad path')
  // a leading slash means the session folder, not the machine's root
  expect(inside('/etc/passwd')).toBe('etc/passwd')
})

test('git status, renames and counts are read from porcelain output', () => {
  const status = '## main...origin/main [ahead 2, behind 1]\0 M src/a.ts\0R  new.ts\0old.ts\0?? notes.md\0D  gone.txt\0'
  const numstat = '3\t1\tsrc/a.ts\0' + '0\t0\t\0old.ts\0new.ts\0' + '0\t4\tgone.txt\0'
  expect(parseStatus(status, numstat)).toEqual({
    branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1,
    files: [
      { path: 'src/a.ts', status: 'M', add: 3, del: 1 },
      { path: 'new.ts', from: 'old.ts', status: 'R', add: 0, del: 0 },
      { path: 'notes.md', status: '?', add: 0, del: 0 },
      { path: 'gone.txt', status: 'D', add: 0, del: 4 },
    ],
  })
  expect(parseStatus('## No commits yet on main\0', '').branch).toBe('main')
})

test('unified diff hunks keep their line numbers', () => {
  const h = parseHunks('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@ fn\n a\n-b\n+c\n+d\n@@ -10 +11 @@\n-x\n+y\n\\ No newline at end of file\n')
  expect(h).toEqual([
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', '+d'] },
    { oldStart: 10, oldLines: 1, newStart: 11, newLines: 1, lines: ['-x', '+y', '\\ No newline at end of file'] },
  ])
})

test('a folder that is not a repository says so', async () => {
  expect(await gitStatus('ws', '%1')).toEqual({ repo: false, files: [] })
})

test('files, the working tree and a commit, on a real repository', async () => {
  git('init -q -b main')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'b.ts'), 'export {}\n')
  writeFileSync(join(dir, 'pic.png'), Buffer.from([137, 80, 78, 71]))
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 0, 2, 0]))
  git('add -A && git -c user.name=T -c user.email=t@t -c commit.gpgsign=false commit -q -m first')

  const root = await listDir('ws', '%1', '')
  expect(root.entries.map((e) => `${e.dir ? 'd' : 'f'} ${e.name}`)).toEqual(['d src', 'f a.txt', 'f blob.bin', 'f pic.png'])
  expect((await listDir('ws', '%1', 'src')).entries[0]).toMatchObject({ name: 'b.ts', dir: false, size: 10 })
  await expect(listDir('ws', '%1', 'nope')).rejects.toThrow('No such folder')

  expect(await readFile('ws', '%1', 'a.txt')).toEqual({ kind: 'text', path: 'a.txt', text: 'one\ntwo\n', size: 8, truncated: false })
  expect(await readFile('ws', '%1', 'pic.png')).toMatchObject({ kind: 'image', type: 'image/png', data: Buffer.from([137, 80, 78, 71]).toString('base64') })
  expect(await readFile('ws', '%1', 'blob.bin')).toMatchObject({ kind: 'binary', size: 4 })

  writeFileSync(join(dir, 'a.txt'), 'one\n2\nthree\n')
  writeFileSync(join(dir, 'new file.md'), '# hi\n')
  const s = await gitStatus('ws', '%1')
  expect(s).toMatchObject({ repo: true, branch: 'main', remote: false })
  expect(s.files).toEqual([
    { path: 'a.txt', status: 'M', add: 2, del: 1 },
    { path: 'new file.md', status: '?', add: 0, del: 0 },
  ])
  expect((await gitDiff('ws', '%1', 'a.txt')).hunks[0].lines).toEqual([' one', '-two', '+2', '+three'])
  expect((await gitDiff('ws', '%1', 'new file.md')).hunks[0]).toMatchObject({ newStart: 1, lines: ['+# hi'] })

  await expect(gitCommit('ws', '%1', '  ')).rejects.toThrow('Write a commit message')
  // git here has no name set and no global config; the error comes back as git said it
  const prev = { ...process.env }
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' })
  try {
    const c = await gitCommit('ws', '%1', 'Second commit\n\nWith a body')
    expect(c.commit).toMatch(/^[0-9a-f]{7,}$/)
  } finally {
    for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
  expect((await gitStatus('ws', '%1')).files).toEqual([])
  expect(new TextDecoder().decode(git('log -1 --format=%B').stdout).trim()).toBe('Second commit\n\nWith a body')
  expect(readFileSync(join(dir, 'new file.md'), 'utf8')).toBe('# hi\n')
})
