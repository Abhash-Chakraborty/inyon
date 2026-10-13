import { expect, test } from 'bun:test'
import { coalesce } from './coalesce.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('the first call goes out at once', () => {
  let n = 0
  const go = coalesce(() => n++, 50)
  go()
  expect(n).toBe(1)
})

test('a burst becomes one more call at the end of the window', async () => {
  let n = 0
  const go = coalesce(() => n++, 30)
  go()
  go()
  go()
  go()
  expect(n).toBe(1)
  await sleep(45)
  expect(n).toBe(2)
  // quiet since: nothing more
  await sleep(45)
  expect(n).toBe(2)
})

test('after a quiet window the next call is immediate again', async () => {
  let n = 0
  const go = coalesce(() => n++, 20)
  go()
  await sleep(35)
  go()
  expect(n).toBe(2)
})
