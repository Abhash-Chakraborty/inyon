import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { lastReply, plainLine } from './last-reply.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())

test('markdown becomes one short plain line', () => {
  expect(plainLine('## Done\n\n**All 12 tests** pass. See `src/app.ts` and [the PR](https://x.y).\n\n```ts\ncode\n```\n- next: ship')).toBe('Done All 12 tests pass. See src/app.ts and the PR. next: ship')
  const long = plainLine('word '.repeat(100))
  expect(long.length).toBeLessThanOrEqual(181)
  expect(long.endsWith('word…')).toBe(true)
})

test("a finished notification quotes the start of the agent's reply from its transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tether-reply-'))
  const file = join(dir, 's.jsonl')
  const line = (o: object) => JSON.stringify({ timestamp: '2026-10-11T10:00:00Z', uuid: crypto.randomUUID(), ...o }) + '\n'
  writeFileSync(file, 'x'.repeat(300_000) + '\n' +
    line({ type: 'user', message: { role: 'user', content: 'fix the build' } }) +
    line({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'make' } }] } }) +
    line({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '**Fixed.** The build passes again.' }] } }))
  spyOn(registry, 'findPane').mockReturnValue({ pane: { id: '%9', agent: { kind: 'claude', transcriptPath: file } } } as any)
  spyOn(registry, 'host').mockReturnValue(new Host({ id: 'r', name: 'r', kind: 'local' } as any))
  expect(await lastReply('r', '%9')).toBe('Fixed. The build passes again.')
})
