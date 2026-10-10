import { expect, test } from 'bun:test'
import { SendReceipts } from './send-receipts.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const receipts = new SendReceipts()
const sendOnce = receipts.sendOnce.bind(receipts)

test('in-flight and lost-response retries submit only once', async () => {
  let sends = 0
  const submit = async () => { sends++; return 'accepted' }
  const key = crypto.randomUUID()
  expect(await Promise.all([sendOnce(key, 'hello', submit), sendOnce(key, 'hello', submit)])).toEqual(['accepted', 'accepted'])
  expect(await sendOnce(key, 'hello', submit)).toBe('accepted')
  expect(sends).toBe(1)
  await expect(sendOnce(key, 'different', submit)).rejects.toThrow('different message')
})

test('a rejected send can be retried with the same id', async () => {
  const key = crypto.randomUUID()
  await expect(sendOnce(key, 'hello', async () => { throw new Error('disconnected') })).rejects.toThrow('disconnected')
  expect(await sendOnce(key, 'hello', async () => 'accepted')).toBe('accepted')
})

test('accepted and interrupted sends remain protected after a hub restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-send-test-'))
  try {
    const file = path.join(directory, 'receipts.json')
    const before = new SendReceipts(file)
    await before.sendOnce('accepted', 'hello', async () => undefined)
    let finish!: () => void
    const pending = before.sendOnce('interrupted', 'world', () => new Promise<void>((resolve) => { finish = resolve }))
    await Promise.resolve()
    const after = new SendReceipts(file)
    let duplicates = 0
    await after.sendOnce('accepted', 'hello', async () => { duplicates++ })
    await expect(after.sendOnce('interrupted', 'world', async () => { duplicates++ })).rejects.toThrow('hub restarted')
    expect(duplicates).toBe(0)
    expect(fs.readFileSync(file, 'utf8')).not.toContain('hello')
    finish()
    await pending
  } finally { fs.rmSync(directory, { recursive: true }) }
})
