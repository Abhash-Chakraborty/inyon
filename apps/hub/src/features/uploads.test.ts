import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { uploadFiles, uploadPiece } from './features.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())

const home = mkdtempSync(join(tmpdir(), 'tether-up-'))
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
  expect(first.path.startsWith(`${home}/.tether/uploads/`)).toBe(true)
  // a piece that doesn't follow on from what's there is refused rather than corrupting the file
  await expect(uploadPiece('up', undefined, piece(4_000_000, 10), { total: video.length, offset: 4_000_000, path: first.path })).rejects.toThrow()
  const last = await uploadPiece('up', undefined, piece(3_000_000, video.length - 3_000_000), { total: video.length, offset: 3_000_000, path: first.path })
  expect(last).toEqual({ ...first, size: video.length })
  expect(new Uint8Array(readFileSync(first.path))).toEqual(video)
})

test('pieces only go into the uploads folder', async () => {
  const p = new File(['x'], 'a.txt')
  for (const path of ['/etc/passwd', `${home}/.tether/uploads/../../.bashrc`, `${home}/.ssh/authorized_keys`, undefined]) {
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
