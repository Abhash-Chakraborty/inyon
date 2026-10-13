import { expect, test } from 'bun:test'
import path from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { pairResult } from './output.ts'

const INYON = path.join(import.meta.dir, 'inyon.ts')

test('the pairing answer carries the link, what the QR code holds, the addresses, and the short code only once published', () => {
  const base = { link: 'inyon://pair?m=a', qr: 'https://web/#pair?m=a', short: { id: 'K7Q4MX2T', code: '493812' }, urls: ['wss://x/link'], relays: [], service: true }
  expect(pairResult({ ...base, typed: true })).toEqual({ link: 'inyon://pair?m=a', qr: 'https://web/#pair?m=a', urls: ['wss://x/link'], relays: [], service: true, short: { id: 'K7Q4MX2T', code: '493812' } })
  expect(pairResult({ ...base, typed: false })).not.toHaveProperty('short')
})

// The program run for real with --json, against a throwaway home with one paired phone.
function run(args: string[], home: string) {
  const p = Bun.spawnSync([process.execPath, INYON, ...args], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

test('phones, forget and push answer as one JSON line under --json, and errors the same way', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'inyon-json-'))
  try {
    const dir = path.join(home, '.inyon', 'node')
    Bun.spawnSync(['mkdir', '-p', dir])
    const key = 'a'.repeat(64)
    writeFileSync(path.join(dir, 'phones.json'), JSON.stringify({ [key]: { name: 'Pixel 9', pairedAt: 1700000000000 } }))

    const phones = run(['phones', '--json'], home)
    expect(phones.code).toBe(0)
    expect(JSON.parse(phones.out)).toEqual({ v: 1, ok: true, phones: [{ key, name: 'Pixel 9', pairedAt: 1700000000000 }] })

    const push = run(['--json', 'push'], home)
    expect(JSON.parse(push.out)).toEqual({ v: 1, ok: true, browsers: [] })

    const missing = run(['forget', 'nobody', '--json'], home)
    expect(missing.code).toBe(1)
    expect(JSON.parse(missing.out)).toEqual({ v: 1, ok: false, error: 'No paired phone matches "nobody"' })

    const forgot = run(['forget', 'Pixel 9', '--json'], home)
    expect(forgot.code).toBe(0)
    expect(JSON.parse(forgot.out)).toEqual({ v: 1, ok: true, forgotten: { key, name: 'Pixel 9' } })
    expect(JSON.parse(run(['phones', '--json'], home).out).phones).toEqual([])

    // without the flag, text as before
    const text = run(['phones'], home)
    expect(text.out).toBe('No phones paired yet. Run `inyon pair`.\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
