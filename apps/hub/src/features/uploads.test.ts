import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { cleanScript, uploadFiles, uploadPiece } from './features.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())

const home = mkdtempSync(join(tmpdir(), 'inyon-up-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

const host = new Host({ id: 'up', name: 'Up', kind: 'local' } as any)
spyOn(registry, 'get').mockReturnValue({ host, probe: { home }, state: { status: 'online' } } as any)
spyOn(registry, 'findPane').mockReturnValue(undefined)

const video = new Uint8Array(5 * 1024 * 1024 + 123).map((_, i) => (i * 7) & 255)

test('a large file is written a few megabytes at a time, never in one go', async () => {
  const exec = spyOn(host, 'exec')
  const [u] = await uploadFiles('up', undefined, [new File([video], 'clip.mp4', { type: 'video/mp4' })])
  expect(exec.mock.calls).toHaveLength(3)
  expect(Math.max(...exec.mock.calls.map((c) => (c[1] as any).input.length))).toBeLessThanOrEqual(2 * 1024 * 1024)
  expect(new Uint8Array(readFileSync(u.path))).toEqual(video)
  exec.mockRestore()
})

test('the phone sends pieces; they join into the file, in order only', async () => {
  const piece = (at: number, n: number) => new File([video.slice(at, at + n)], 'clip.mp4', { type: 'video/mp4' })
  const first = await uploadPiece('up', undefined, piece(0, 3_000_000), { total: video.length, offset: 0 })
  expect(first.path.startsWith(`${home}/.inyon/uploads/`)).toBe(true)
  // a piece that doesn't follow on from what's there is refused rather than corrupting the file
  await expect(uploadPiece('up', undefined, piece(4_000_000, 10), { total: video.length, offset: 4_000_000, path: first.path })).rejects.toThrow()
  const last = await uploadPiece('up', undefined, piece(3_000_000, video.length - 3_000_000), { total: video.length, offset: 3_000_000, path: first.path })
  expect(last).toEqual({ ...first, size: video.length })
  expect(new Uint8Array(readFileSync(first.path))).toEqual(video)
})

test('pieces only go into the uploads folder', async () => {
  const p = new File(['x'], 'a.txt')
  for (const path of ['/etc/passwd', `${home}/.inyon/uploads/../../.bashrc`, `${home}/.ssh/authorized_keys`, undefined]) {
    await expect(uploadPiece('up', undefined, p, { total: 10, offset: 5, path })).rejects.toThrow('Bad upload path')
  }
  await expect(uploadPiece('up', undefined, p, { total: 200 * 1024 * 1024, offset: 0 })).rejects.toThrow('larger than')
})

test('the upload route takes a chunked piece and counts what it reads', async () => {
  const { coreRoutes } = await import('../core.ts')
  const post = (coreRoutes['/api/hosts/:id/uploads'] as any).POST
  const send = (form: FormData) => {
    // re-sent as a stream, so there is no Content-Length to go by
    const r = new Request('http://hub/api/hosts/up/uploads', { method: 'POST', body: form })
    return post(Object.assign(new Request(r.url, { method: 'POST', body: r.body, headers: { 'content-type': r.headers.get('content-type')! } }), { params: { id: 'up' } }))
  }
  const form = new FormData()
  form.append('files', new File([video.slice(0, 1000)], 'small.bin'), 'small.bin')
  form.append('total', '1000')
  form.append('offset', '0')
  const res = await send(form)
  expect(res.status).toBe(200)
  expect((await res.json()).files[0].size).toBe(1000)
  // over the 100 MB setting (plus a megabyte for the form itself)
  const big = new FormData()
  big.append('files', new File([new Uint8Array(102 * 1024 * 1024)], 'big.bin'), 'big.bin')
  const refused = await send(big)
  expect(refused.status).toBe(413)
  expect((await refused.json()).error).toBe('Uploads are limited to 100 MB')
})

test('a piece sent twice (its answer was lost, so the phone retried) is written once', async () => {
  const piece = (at: number, n: number) => new File([video.slice(at, at + n)], 'again.mp4', { type: 'video/mp4' })
  const first = await uploadPiece('up', undefined, piece(0, 2_000_000), { total: video.length, offset: 0 })
  const second = { total: video.length, offset: 2_000_000, path: first.path }
  await uploadPiece('up', undefined, piece(2_000_000, 2_000_000), second)
  await uploadPiece('up', undefined, piece(2_000_000, 2_000_000), second)
  await uploadPiece('up', undefined, piece(4_000_000, video.length - 4_000_000), { ...second, offset: 4_000_000 })
  expect(new Uint8Array(readFileSync(first.path))).toEqual(video)
})

test('two files of the same name sent in the same second both keep their bytes', async () => {
  const [a, b] = await uploadFiles('up', '%3', [new File(['FIRST'], 'screenshot.png'), new File(['SECOND'], 'screenshot.png')])
  expect(a.path).not.toBe(b.path)
  expect(readFileSync(a.path, 'utf8')).toBe('FIRST')
  expect(readFileSync(b.path, 'utf8')).toBe('SECOND')
})

test('a file in progress is a .part file, and takes its name only once the last piece is in', async () => {
  const piece = (at: number, n: number) => new File([video.slice(at, at + n)], 'half.mp4', { type: 'video/mp4' })
  const first = await uploadPiece('up', undefined, piece(0, 1_000_000), { total: 2_000_000, offset: 0 })
  // cut off here: an agent can't be handed a file that is half there
  expect(existsSync(first.path)).toBe(false)
  expect(existsSync(`${first.path}.part`)).toBe(true)
  await uploadPiece('up', undefined, piece(1_000_000, 1_000_000), { total: 2_000_000, offset: 1_000_000, path: first.path })
  expect(existsSync(`${first.path}.part`)).toBe(false)
  expect(statSync(first.path).size).toBe(2_000_000)
  // the last piece sent again, after its answer was lost: the whole file stays as it is
  await uploadPiece('up', undefined, piece(1_000_000, 1_000_000), { total: 2_000_000, offset: 1_000_000, path: first.path })
  expect(statSync(first.path).size).toBe(2_000_000)
})

test('the janitor deletes old uploads, leftover .part files and the oldest past the size limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inyon-clean-'))
  try {
    const file = (name: string, kb: number, daysOld: number, minsOld = 0) => {
      const p = join(dir, name)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, new Uint8Array(kb * 1024))
      const t = new Date(Date.now() - daysOld * 86400_000 - minsOld * 60_000)
      utimesSync(p, t, t)
      return p
    }
    const ancient = file('2026-09-01/a/old.png', 10, 40)
    const stale = file('2026-10-14/b/cut.mp4.part', 10, 0, 90)
    const fresh = file('2026-10-14/b/going.mp4.part', 10, 0, 5)
    const big1 = file('2026-10-10/c/one.bin', 600, 4)
    const big2 = file('2026-10-13/c/two.bin', 600, 1)
    const today = file('2026-10-14/c/three.bin', 600, 0)
    const sh = Bun.spawnSync(['sh', '-c', cleanScript(dir, 30, 1)])
    expect(sh.exitCode).toBe(0)
    expect([ancient, stale, big1, big2].map(existsSync)).toEqual([false, false, false, false])
    // still being written, and today's file under the 1 MB cap, both stay
    expect([fresh, today].map(existsSync)).toEqual([true, true])
    expect(existsSync(join(dir, '2026-09-01'))).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
