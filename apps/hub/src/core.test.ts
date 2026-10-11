import { expect, test } from 'bun:test'
import { body } from './core.ts'

/** A body sent in chunks, so the request has no Content-Length to check. */
const chunked = (chunks: number, size: number) => {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent++ >= chunks) return c.close()
      c.enqueue(new TextEncoder().encode(sent === 1 ? '{"x":"' : 'a'.repeat(size)))
    },
  })
  return { req: new Request('http://hub/api/login', { method: 'POST', body: stream }), pulled: () => sent }
}

test('a chunked body is cut off once it passes the limit', async () => {
  const { req, pulled } = chunked(10_000, 1024)
  expect(req.headers.get('content-length')).toBeNull()
  await expect(body(req, 8 * 1024)).rejects.toThrow('Request too large')
  // it stopped reading near the limit instead of taking in all 10 MB
  expect(pulled()).toBeLessThan(100)
})

test('small bodies still parse, and bad ones say so', async () => {
  expect(await body<{ password: string }>(new Request('http://hub/', { method: 'POST', body: '{"password":"pw"}' }), 8 * 1024)).toEqual({ password: 'pw' })
  await expect(body(new Request('http://hub/', { method: 'POST', body: '{nope' }))).rejects.toThrow('Invalid JSON')
  await expect(body(new Request('http://hub/', { method: 'POST', body: 'x'.repeat(9000), headers: { 'content-length': '9000' } }), 8 * 1024)).rejects.toThrow('Request too large')
})
