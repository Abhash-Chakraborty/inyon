import { afterAll, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host, type ExecOptions } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { DELETE_WAIT, INYON, WAIT, missing, readAnswer, tempDelete, tempFiles, tempList, tempPreview, tooOld } from './temp.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())

const host = new Host({ id: 'box', name: 'Studio', kind: 'node' } as any)
let connected = true
spyOn(registry, 'get').mockImplementation(((id: string) => (id === 'box' ? { host, probe: connected ? { home: '/home/me' } : undefined, state: { status: 'online' } } : undefined)) as any)

type Call = { cmd: string; input?: string; timeoutMs?: number }
let calls: Call[] = []
let answer: (cmd: string) => { code: number; stdout: string; stderr: string } = () => ({ code: 0, stdout: '{}', stderr: '' })
spyOn(host, 'exec').mockImplementation(async (cmd: string, opts: ExecOptions = {}) => {
  calls.push({ cmd, input: typeof opts.input === 'string' ? opts.input : undefined, timeoutMs: opts.timeoutMs })
  return answer(cmd)
})
beforeEach(() => {
  calls = []
  connected = true
  answer = () => ({ code: 0, stdout: '{}', stderr: '' })
})

const listing = { v: 1, ok: true, host: 'studio', roots: [{ id: 'claude-tmp', agent: 'claude', label: 'Claude Code temp files', path: '/tmp/claude-1000', size: 10, items: 1, exists: true }], items: [] }

test('the list is the machine’s own inyon temp ls, handed on as it answered', async () => {
  answer = () => ({ code: 0, stdout: JSON.stringify(listing) + '\n', stderr: '' })
  expect(await tempList('box')).toEqual(listing)
  expect(calls[0].cmd).toBe(`${INYON} ls --json`)
})

test('paths go to the machine quoted, after --', async () => {
  answer = () => ({ code: 0, stdout: '{"v":1,"ok":true,"files":[]}', stderr: '' })
  await tempFiles('box', "/tmp/claude-1000/it's here")
  expect(calls[0].cmd).toBe(`${INYON} files --json -- '/tmp/claude-1000/it'\\''s here'`)
  await tempPreview('box', '/tmp/claude-1000/a.png', 1_500_000)
  expect(calls[1].cmd).toBe(`${INYON} show --json --max 1500000 -- '/tmp/claude-1000/a.png'`)
  // never more than the CLI's own limit, whatever is asked
  await tempPreview('box', '/tmp/claude-1000/a.png', 1e12)
  expect(calls[2].cmd).toContain('--max 8388608 ')
  // below 1 byte is 1 byte; nothing, 0 or a fraction of a byte is the whole limit (as the Rust hub)
  for (const [max, sent] of [[-5, 1], [-Infinity, 1], [0.5, 8388608], [0, 8388608], [Number.NaN, 8388608], [undefined, 8388608]] as const) {
    await tempPreview('box', '/tmp/claude-1000/a.png', max)
    expect(calls.at(-1)!.cmd).toContain(`--max ${sent} `)
  }
  await expect(tempFiles('box', '')).rejects.toThrow('Which item?')
})

test('deleting sends the paths on stdin and returns what stayed', async () => {
  answer = () => ({ code: 1, stdout: JSON.stringify({ v: 1, ok: false, removed: [], freed: 0, failed: [['/etc', 'That isn’t inside one of the temp folders Inyon lists']] }), stderr: '' })
  const r = await tempDelete('box', ['/etc'])
  expect(calls[0]).toEqual({ cmd: `${INYON} rm --stdin --json`, input: '["/etc"]', timeoutMs: DELETE_WAIT })
  expect(r).toMatchObject({ ok: true, removed: [], failed: [['/etc', 'That isn’t inside one of the temp folders Inyon lists']] })
  for (const bad of [undefined, [], ['ok', 3], [''], 'x']) await expect(tempDelete('box', bad)).rejects.toThrow('Send the paths to delete')
})

test("the hub gives up on the machine before the server drops the app's quiet connection", async () => {
  // a request that outlasts Bun's idleTimeout is cut off with no answer at all
  const idle = [...readFileSync(join(import.meta.dir, '../index.ts'), 'utf8').matchAll(/idleTimeout: (\d+)/g)].map((m) => Number(m[1]) * 1000)
  expect(idle.length).toBeGreaterThan(0)
  for (const limit of idle) expect(DELETE_WAIT).toBeLessThan(limit)
  expect(WAIT).toBeLessThan(DELETE_WAIT)
  answer = () => ({ code: 0, stdout: '{"v":1,"ok":true}', stderr: '' })
  await tempList('box')
  await tempFiles('box', '/tmp/a')
  await tempPreview('box', '/tmp/a')
  expect(calls.map((c) => c.timeoutMs)).toEqual([WAIT, WAIT, WAIT])
})

test('an inyon too old for temp, or none at all, gets a message that says what to do', () => {
  const old = { code: 2, stdout: '', stderr: "error: unrecognized subcommand 'temp'\n\nUsage: inyon [OPTIONS] [COMMAND]\n" }
  expect(() => readAnswer('Studio', old)).toThrow(tooOld('Studio'))
  expect(tooOld('Studio')).toBe('Update Inyon on Studio to see its temp files')
  // the engine an older install points INYON_EXE at
  expect(() => readAnswer('Studio', { code: 2, stdout: '', stderr: 'inyon-engine 0.12.0: the engine behind inyon\n' })).toThrow(tooOld('Studio'))
  expect(() => readAnswer('Studio', { code: 127, stdout: '', stderr: 'inyon: not found\n' })).toThrow(missing('Studio'))
  expect(() => readAnswer('Studio', { code: 124, stdout: '', stderr: 'timed out' })).toThrow('Studio took too long to answer')
  expect(() => readAnswer('Studio', { code: 1, stdout: '', stderr: 'something broke\n' })).toThrow('something broke')
})

test('the routes answer with the right status', async () => {
  const { coreRoutes } = await import('../core.ts')
  const call = async (route: string, method: string, url: string, body?: unknown) => {
    const handler = (coreRoutes[route] as any)[method]
    const req = new Request(`http://hub${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'content-type': 'application/json' } })
    const res: Response = await handler(Object.assign(req, { params: { id: url.split('/')[3] } }))
    return [res.status, await res.json()] as const
  }
  answer = () => ({ code: 0, stdout: JSON.stringify(listing), stderr: '' })
  expect(await call('/api/hosts/:id/temp', 'GET', '/api/hosts/box/temp')).toEqual([200, listing])
  answer = () => ({ code: 2, stdout: '', stderr: "error: unrecognized subcommand 'temp'" })
  expect(await call('/api/hosts/:id/temp', 'GET', '/api/hosts/box/temp')).toEqual([409, { error: 'Update Inyon on Studio to see its temp files' }])
  expect(await call('/api/hosts/:id/temp', 'GET', '/api/hosts/nope/temp')).toEqual([404, { error: 'Unknown machine' }])
  connected = false
  expect(await call('/api/hosts/:id/temp', 'GET', '/api/hosts/box/temp')).toEqual([503, { error: 'Machine is not connected yet' }])
  connected = true
  // a refusal from the machine is the person's mistake, not the hub's
  answer = () => ({ code: 1, stdout: '{"v":1,"ok":false,"error":"That isn\'t inside one of the temp folders Inyon lists"}', stderr: '' })
  expect(await call('/api/hosts/:id/temp/preview', 'GET', '/api/hosts/box/temp/preview?path=%2Fetc%2Fpasswd')).toEqual([400, { error: "That isn't inside one of the temp folders Inyon lists" }])
  expect(calls.at(-1)!.cmd).toContain("-- '/etc/passwd'")
  answer = () => ({ code: 0, stdout: '{"v":1,"ok":true,"path":"/tmp/x","files":[],"truncated":false}', stderr: '' })
  expect((await call('/api/hosts/:id/temp/files', 'GET', '/api/hosts/box/temp/files?path=%2Ftmp%2Fx'))[0]).toBe(200)
  answer = () => ({ code: 0, stdout: '{"v":1,"ok":true,"removed":["/tmp/x"],"freed":5,"failed":[]}', stderr: '' })
  expect(await call('/api/hosts/:id/temp/delete', 'POST', '/api/hosts/box/temp/delete', { paths: ['/tmp/x'] })).toEqual([200, { v: 1, ok: true, removed: ['/tmp/x'], freed: 5, failed: [] }])
  expect(calls.at(-1)!.input).toBe('["/tmp/x"]')
})

test('the shell finds the machine’s inyon and passes the arguments through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inyon-temp-sh-'))
  try {
    const fake = (where: string, tag: string) => {
      mkdirSync(where, { recursive: true })
      const p = join(where, 'inyon')
      writeFileSync(p, `#!/bin/sh\nprintf '${tag}'; for a in "$@"; do printf ' [%s]' "$a"; done\n`)
      chmodSync(p, 0o755)
      return p
    }
    const sh = (env: Record<string, string>) => {
      const r = Bun.spawnSync(['/bin/sh', '-c', `${INYON} files --json -- '/tmp/a b'`], { env: { PATH: '/usr/bin:/bin', HOME: join(dir, 'home'), ...env } })
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
    }
    expect(sh({})).toEqual({ code: 127, out: '', err: 'inyon: not found\n' })
    fake(join(dir, 'home', '.inyon', 'bin'), 'home')
    expect(sh({}).out).toBe('home [temp] [files] [--json] [--] [/tmp/a b]')
    fake(join(dir, 'path'), 'path')
    expect(sh({ PATH: `${join(dir, 'path')}:/usr/bin:/bin` }).out).toBe('path [temp] [files] [--json] [--] [/tmp/a b]')
    // the program the connection runs from comes first, with its script when it's the Bun one
    const exe = fake(join(dir, 'exe'), 'exe')
    expect(sh({ PATH: `${join(dir, 'path')}:/usr/bin:/bin`, INYON_EXE: exe, INYON_SCRIPT: '/opt/inyon.ts' }).out).toBe('exe [/opt/inyon.ts] [temp] [files] [--json] [--] [/tmp/a b]')
    expect(sh({ INYON_EXE: exe, INYON_SCRIPT: '' }).out).toBe('exe [temp] [files] [--json] [--] [/tmp/a b]')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
