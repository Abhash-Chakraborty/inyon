import { afterAll, expect, spyOn, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMsg } from '@tether/protocol'
import { parseSize, sizeCommand, tailCommand, TranscriptReader, utf8Length } from './transcript-tail.ts'
import { Host } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { watchers } from './watcher.ts'

const dir = mkdtempSync(join(tmpdir(), 'tether-tail-'))
afterAll(() => {
  watchers.stop('tail-test:%1')
  rmSync(dir, { recursive: true, force: true })
})

const png = 'iVBORw0KGgo' + 'A'.repeat(50_000)
let n = 0
const user = (text: string, image = false) =>
  JSON.stringify({
    type: 'user',
    uuid: `u${++n}`,
    timestamp: new Date(1_800_000_000_000 + n * 1000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }, ...(image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] : [])] },
  }) + '\n'

/** Runs a command to the end and returns its lines, as a stream would hand them over. */
const lines = (cmd: string) => Bun.spawnSync(['sh', '-c', cmd]).stdout.toString().split('\n').slice(0, -1)

test('drops image data on the far side but counts every byte of the file', () => {
  const file = join(dir, 'slim.jsonl')
  writeFileSync(file, user('héllo ✓ 🙂') + user('a screenshot', true) + user('after'))
  const cmd = tailCommand(file, 0, true).replace(' -F ', ' ')
  const out = lines(cmd)
  expect(out.join('\n').length).toBeLessThan(2000)
  const r = new TranscriptReader()
  const entries = out.map((l) => r.line(l)?.entry).filter(Boolean)
  expect(entries.map((e) => e.message.content[0].text)).toEqual(['héllo ✓ 🙂', 'a screenshot', 'after'])
  expect(entries[1].message.content[1].type).toBe('image')
  expect(r.offset).toBe(statSync(file).size)
})

test('reading on from an offset gives exactly the lines after it', () => {
  const file = join(dir, 'resume.jsonl')
  writeFileSync(file, user('one') + user('two', true))
  const first = new TranscriptReader()
  for (const l of lines(tailCommand(file, 0, true).replace(' -F ', ' '))) first.line(l)
  appendFileSync(file, user('three') + user('four'))
  const next = new TranscriptReader(first.offset)
  const texts = lines(tailCommand(file, first.offset, true).replace(' -F ', ' ')).map((l) => next.line(l)?.entry?.message.content[0].text).filter(Boolean)
  expect(texts).toEqual(['three', 'four'])
  expect(next.offset).toBe(statSync(file).size)
})

test('a line cut short by a dropped stream is read again, not skipped', () => {
  const full = user('whole')
  const r = new TranscriptReader()
  r.line(user('before').slice(0, -1))
  const at = r.offset
  expect(r.line(full.slice(0, 20))?.entry).toBeUndefined()
  expect(r.offset).toBe(at)
  expect(utf8Length('é🙂')).toBe(6)
})

test('counts by the sizes the far side reports, however the text was decoded', () => {
  const file = join(dir, 'marks.jsonl')
  writeFileSync(file, user('🙂 split across chunks') + '\n' + user('next'))
  const r = new TranscriptReader()
  const out = lines(tailCommand(file, 0, true).replace(' -F ', ' ')).map((l) => (l.startsWith('{') ? l.replace('🙂', '\ufffd') : l))
  const texts = out.filter((l) => l).map((l) => r.line(l)?.entry?.message.content[0].text).filter(Boolean)
  expect(texts).toHaveLength(2)
  expect(r.offset).toBe(statSync(file).size)
})

test('checks that a line starts where the read stopped', () => {
  const file = join(dir, 'align.jsonl')
  const one = user('one')
  writeFileSync(file, one + user('two'))
  const at = (from: number) => parseSize(Bun.spawnSync(['sh', '-c', sizeCommand(file, from)]).stdout.toString())
  expect(at(0)).toEqual({ size: statSync(file).size, aligned: true })
  expect(at(utf8Length(one)).aligned).toBe(true)
  expect(at(utf8Length(one) + 7).aligned).toBe(false)
  expect(at(utf8Length(one) - 1).aligned).toBe(false)
})

test('a dropped connection carries on from where it stopped instead of reading it all again', async () => {
  const file = join(dir, 'chat.jsonl')
  writeFileSync(file, user('first') + user('with a picture', true) + user('second'))
  const config = { id: 'tail-test', name: 'Remote', kind: 'ssh' as const, ssh: 'nowhere' }
  const pane = { id: '%1', title: 'claude', agent: { kind: 'claude', transcriptPath: file, sessionId: 's1' } }
  spyOn(registry, 'get').mockReturnValue({ host: new Host(config as any), state: { status: 'online' } } as any)
  // seen as a remote machine (so image data is left out), run here
  spyOn(registry, 'host').mockReturnValue(new Host({ ...config, kind: 'local' } as any))
  spyOn(registry, 'findPane').mockReturnValue({ pane } as any)
  const streams = spyOn(Host.prototype, 'stream')

  const got: ServerMsg[] = []
  const sub = { send: (m: ServerMsg) => got.push(m) }
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(25)
    expect(ok()).toBe(true)
  }
  const first = (i: any) => i.text.split('\n')[0]
  const texts = (t: ServerMsg['t']) => got.filter((m) => m.t === t).flatMap((m: any) => m.items.filter((i: any) => i.kind === 'user').map(first))

  const w = watchers.get('tail-test', '%1')
  w.subscribe(sub)
  await until(() => texts('chat.reset').length === 3)
  expect(texts('chat.reset')).toEqual(['first', 'with a picture', 'second'])
  const cmd = String(streams.mock.calls.at(-1)![0])
  expect(cmd).toContain('tail -c +1 ')
  expect(cmd).toContain('awk')

  // the connection drops; more is said meanwhile; it comes back
  ;(w as any).tail.kill()
  await until(() => (w as any).tailLost)
  appendFileSync(file, user('while away'))
  w.sync()
  await until(() => texts('chat.append').includes('while away'))
  expect(String(streams.mock.calls.at(-1)![0])).not.toContain('tail -c +1 ')
  expect(got.filter((m) => m.t === 'chat.reset')).toHaveLength(1)
  expect(w.items.filter((i) => i.kind === 'user').map(first)).toEqual(['first', 'with a picture', 'second', 'while away'])

  // closed and opened again within half an hour: the next watcher carries on too
  watchers.stop(w.key)
  appendFileSync(file, user('later'))
  const again = watchers.get('tail-test', '%1')
  got.length = 0
  again.subscribe(sub)
  expect(texts('chat.reset')).toEqual(['first', 'with a picture', 'second', 'while away'])
  await until(() => texts('chat.append').includes('later'))
  expect(String(streams.mock.calls.at(-1)![0])).not.toContain('tail -c +1 ')

  // the count is off (the file was replaced by one as long): read it again rather than mid-line
  ;(again as any).tail.kill()
  await until(() => (again as any).tailLost)
  ;(again as any).reader.offset -= 3
  got.length = 0
  again.sync()
  await until(() => texts('chat.reset').length === 5)
  expect(texts('chat.reset')).toEqual(['first', 'with a picture', 'second', 'while away', 'later'])

  // a file that got shorter was rewritten: read it again from the start
  ;(again as any).tail.kill()
  await until(() => (again as any).tailLost)
  got.length = 0
  writeFileSync(file, user('fresh'))
  again.sync()
  await until(() => texts('chat.reset').includes('fresh'))
  expect(again.items.filter((i) => i.kind === 'user').map(first)).toEqual(['fresh'])
  watchers.stop(again.key)
}, 30_000)
