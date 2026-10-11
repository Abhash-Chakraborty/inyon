import { afterAll, expect, spyOn, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMsg } from '@tether/protocol'
import { metaCommand, parseSize, sizeCommand, tailCommand, TranscriptReader, untilStdinCloses, utf8Length } from './transcript-tail.ts'
import { Host } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { newMeta, normalize } from './transcript.ts'
import { watchers } from './watcher.ts'

const dir = mkdtempSync(join(tmpdir(), 'tether-tail-'))
afterAll(() => {
  watchers.stop('tail-test:%1')
  watchers.stop('tail-test:%2')
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
  const cmd = tailCommand(file, 0, true, false)
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
  for (const l of lines(tailCommand(file, 0, true, false))) first.line(l)
  appendFileSync(file, user('three') + user('four'))
  const next = new TranscriptReader(first.offset)
  const texts = lines(tailCommand(file, first.offset, true, false)).map((l) => next.line(l)?.entry?.message.content[0].text).filter(Boolean)
  expect(texts).toEqual(['three', 'four'])
  expect(next.offset).toBe(statSync(file).size)
})

test.skipIf(!Bun.which('setsid'))('a remote follow ends once its stdin closes, tail and all', async () => {
  const file = join(dir, 'closed.jsonl')
  writeFileSync(file, user('quiet'))
  // as over SSH: its own session, stdin a pipe from the hub, and nobody kills the group
  const p = Bun.spawn(['setsid', 'sh', '-c', `${tailCommand(file, 0, true)}; echo exited`], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  const out = new Response(p.stdout).text()
  await Bun.sleep(300)
  const tails = () => Bun.spawnSync(['ps', '-eo', 'args=']).stdout.toString().split('\n').filter((l) => l.startsWith('tail ') && l.includes(file))
  expect(tails()).toHaveLength(1)
  p.stdin.end()
  expect(await Promise.race([p.exited, Bun.sleep(3000).then(() => 'stuck')])).not.toBe('stuck')
  expect(await out).toContain('exited')
  expect(tails()).toHaveLength(0)
})

test.skipIf(!Bun.which('setsid'))('any command can be made to end with its stdin', async () => {
  const file = join(dir, 'events.jsonl')
  writeFileSync(file, '')
  // the shape of the hook event follow: a setup step, then the tail
  const cmd = `touch ${file} && { ${untilStdinCloses(`tail -n0 -F ${file} 2>/dev/null`)}; }; echo exited`
  const p = Bun.spawn(['setsid', 'sh', '-c', cmd], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  const out = new Response(p.stdout).text()
  await Bun.sleep(300)
  const tails = () => Bun.spawnSync(['ps', '-eo', 'args=']).stdout.toString().split('\n').filter((l) => l.startsWith('tail ') && l.includes(file))
  expect(tails()).toHaveLength(1)
  p.stdin.end()
  expect(await Promise.race([p.exited, Bun.sleep(3000).then(() => 'stuck')])).not.toBe('stuck')
  expect(await out).toContain('exited')
  expect(tails()).toHaveLength(0)
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
  const out = lines(tailCommand(file, 0, true, false)).map((l) => (l.startsWith('{') ? l.replace('🙂', '\ufffd') : l))
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

test('a long backlog is read out of sight and shown at once; the saved place survives a restart', async () => {
  const file = join(dir, 'away.jsonl')
  const goal = (condition: string, met: boolean) =>
    JSON.stringify({ type: 'attachment', uuid: `g${++n}`, timestamp: new Date(1_800_000_000_000 + n * 1000).toISOString(), attachment: { type: 'goal_status', condition, met } }) + '\n'
  writeFileSync(file, Array.from({ length: 30 }, (_, i) => user(`m${i}`)).join(''))
  const pane = { id: '%2', title: 'claude', agent: { kind: 'claude', transcriptPath: file, sessionId: 's2' } }
  const config = { id: 'tail-test', name: 'Remote', kind: 'ssh' as const, ssh: 'nowhere' }
  spyOn(registry, 'get').mockReturnValue({ host: new Host(config as any), state: { status: 'online' } } as any)
  spyOn(registry, 'host').mockReturnValue(new Host({ ...config, kind: 'local' } as any))
  spyOn(registry, 'findPane').mockReturnValue({ pane } as any)
  const streams = spyOn(Host.prototype, 'stream')
  const got: ServerMsg[] = []
  const sub = { send: (m: ServerMsg) => got.push(m) }
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 400 && !ok(); i++) await Bun.sleep(25)
    expect(ok()).toBe(true)
  }
  const users = (m: any) => m.items.filter((i: any) => i.kind === 'user').map((i: any) => i.text)

  const w = watchers.get('tail-test', '%2')
  w.subscribe(sub)
  await until(() => got.some((m) => m.t === 'chat.reset'))

  // hours of work while away, with a goal set and met on the way
  ;(w as any).tail.kill()
  await until(() => (w as any).tailLost)
  const backlog = [goal('ship it', false), ...Array.from({ length: 300 }, (_, i) => user(`away ${i} ${'x'.repeat(300)}`)), goal('ship it', true)]
  appendFileSync(file, backlog.join(''))
  got.length = 0
  w.sync()
  await until(() => got.some((m) => m.t === 'chat.reset'))
  await Bun.sleep(300)
  // nothing replayed message by message, and no passing state (the active goal) was ever shown
  expect(got.filter((m) => m.t === 'chat.append')).toHaveLength(0)
  expect(got.some((m) => m.t === 'chat.info' && m.info.goal && !m.info.goal.met)).toBe(false)
  expect(got.some((m) => m.t === 'chat.progress')).toBe(true)
  const reset = got.find((m) => m.t === 'chat.reset') as Extract<ServerMsg, { t: 'chat.reset' }>
  expect(reset.info.goal?.met).toBe(true)
  expect(users(reset).at(-1)).toStartWith('away 299')

  // a small catch-up still streams in as it's read
  ;(w as any).tail.kill()
  await until(() => (w as any).tailLost)
  appendFileSync(file, user('just one'))
  got.length = 0
  w.sync()
  await until(() => got.some((m) => m.t === 'chat.append' && users(m).includes('just one')))
  expect(got.filter((m) => m.t === 'chat.reset')).toHaveLength(0)

  // the app restarts (or comes back hours later): its saved copy says where reading stopped
  const all = w.items.map((i) => [i.seq, i.uuid])
  watchers.stop(w.key)
  ;(watchers as any).parked.clear()
  appendFileSync(file, user('after the restart'))
  got.length = 0
  const fresh = watchers.get('tail-test', '%2')
  fresh.subscribe(sub)
  const first = got.find((m) => m.t === 'chat.reset') as Extract<ServerMsg, { t: 'chat.reset' }>
  expect(users(first).at(-1)).toBe('just one')
  expect(first.hasMore).toBe(true)
  await until(() => got.some((m) => m.t === 'chat.append' && users(m).includes('after the restart')))
  expect(String(streams.mock.calls.at(-1)![0])).not.toContain('tail -c +1 ')
  expect(fresh.items.length).toBeLessThan(all.length)

  // earlier messages than the saved copy holds come from the file, numbered as before
  for (let more: any; (more = got.findLast((m) => m.t === 'chat.more')), !more || more.hasMore; ) {
    const n0 = got.length
    await fresh.more(sub, fresh.items[0].seq)
    expect(got.length).toBe(n0 + 1)
  }
  expect(fresh.items.map((i) => [i.seq, i.uuid])).toEqual([...all, ...fresh.items.slice(all.length).map((i) => [i.seq, i.uuid])])
  expect(fresh.items[0].seq).toBe(0)
  watchers.stop(fresh.key)
}, 60_000)

test('a long conversation opens on its last stretch and reads earlier messages as you scroll up', async () => {
  const file = join(dir, 'long.jsonl')
  const at = () => new Date(1_800_000_000_000 + ++n * 1000).toISOString()
  const goal = JSON.stringify({ type: 'attachment', uuid: `g${n}`, timestamp: at(), attachment: { type: 'goal_status', condition: 'early goal', met: false } }) + '\n'
  const turn = () => JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: `t${++n}`, timestamp: at(), durationMs: 1000 }) + '\n'
  // about 2.4 MB: well past the last stretch read at first, with a screenshot in the middle
  const lines = [goal, turn()]
  for (let i = 0; i < 2000; i++) lines.push(user(`msg ${i} ${'x'.repeat(1100)}`, i === 1000), ...(i % 100 === 0 ? [turn()] : []))
  writeFileSync(file, lines.join(''))
  expect(statSync(file).size).toBeGreaterThan(2_000_000)

  const pane = { id: '%3', title: 'claude', agent: { kind: 'claude', transcriptPath: file, sessionId: 's3' } }
  const config = { id: 'tail-test', name: 'Remote', kind: 'ssh' as const, ssh: 'nowhere' }
  spyOn(registry, 'get').mockReturnValue({ host: new Host(config as any), state: { status: 'online' } } as any)
  spyOn(registry, 'host').mockReturnValue(new Host({ ...config, kind: 'local' } as any))
  spyOn(registry, 'findPane').mockReturnValue({ pane } as any)
  const streams = spyOn(Host.prototype, 'stream')
  streams.mockClear()
  const got: ServerMsg[] = []
  const sub = { send: (m: ServerMsg) => got.push(m) }
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 400 && !ok(); i++) await Bun.sleep(25)
    expect(ok()).toBe(true)
  }
  const num = (i: any) => Number(/^msg (\d+)/.exec(i.text)?.[1])

  const t0 = performance.now()
  const w = watchers.get('tail-test', '%3')
  w.subscribe(sub)
  await until(() => got.some((m) => m.t === 'chat.reset'))
  const opened = performance.now() - t0
  const reset = got.find((m) => m.t === 'chat.reset') as Extract<ServerMsg, { t: 'chat.reset' }>
  const cmds = streams.mock.calls.map((c) => String(c[0]))
  // nothing read the whole file: a summary of the early part, then the last stretch
  expect(cmds.some((c) => c.includes('tail -c +1 '))).toBe(false)
  expect(cmds.some((c) => c.includes('grep -E'))).toBe(true)
  expect(reset.items.filter((i) => i.kind === 'user').map(num).at(-1)).toBe(1999)
  expect(reset.hasMore).toBe(true)
  // what's known about the whole conversation still came through
  expect(reset.info.goal?.condition).toBe('early goal')
  expect(reset.info.stats.turns).toBe(21)
  expect(w.items.length).toBeLessThan(2000)

  // scrolling up: every earlier message once, in order, until the start of the file
  for (let more: any; (more = got.findLast((m) => m.t === 'chat.more')), !more || more.hasMore; ) await w.more(sub, w.items[0]!.seq)
  const all = w.items.filter((i) => i.kind === 'user').map(num)
  expect(all).toEqual(Array.from({ length: 2000 }, (_, i) => i))
  expect(new Set(w.items.map((i) => i.seq)).size).toBe(w.items.length)
  expect(w.items.every((it, i) => i === 0 || it.seq > w.items[i - 1]!.seq)).toBe(true)
  expect(w.items.find((i) => i.kind === 'user' && num(i) === 1000)).toMatchObject({ images: 1 })
  console.log(`opened a ${(statSync(file).size / 1e6).toFixed(1)} MB conversation in ${Math.round(opened)} ms`)
  watchers.stop(w.key)
}, 60_000)

test('the summary of a long conversation leaves out what was said', () => {
  const file = join(dir, 'meta.jsonl')
  const line = (o: any) => JSON.stringify({ uuid: crypto.randomUUID(), timestamp: '2027-01-01T00:00:00Z', ...o }) + '\n'
  const tool = (id: string, name: string, input: any) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
  const result = (id: string, tur: any) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: tur })
  const notice = `<task-notification><task-id>b2</task-id><status>completed</status><summary>build done</summary><result>${'log '.repeat(5000)}</result></task-notification>`
  writeFileSync(file, [
    line({ type: 'ai-title', aiTitle: 'first title' }),
    line({ type: 'user', message: { role: 'user', content: 'what does "name":"Agent" do? ' + 'x'.repeat(5000) } }),
    line({ type: 'attachment', attachment: { type: 'prompt_snapshot', prompt: '"name":"Agent" <task-notification> ' + 'y'.repeat(5000) } }),
    tool('t1', 'Agent', { description: 'look around', prompt: 'go' }),
    // a command that outlived its timeout: its call never asked for the background
    tool('t2', 'Bash', { command: 'make', description: 'build' }),
    result('t2', { stdout: '', backgroundTaskId: 'b1' }),
    tool('t3', 'TaskStop', { task_id: 'b1' }),
    result('t3', { message: 'Successfully stopped task: b1 (make)' }),
    line({ type: 'queue-operation', operation: 'enqueue', content: notice }),
    line({ type: 'ai-title', aiTitle: 'last title' }),
  ].join(''))
  const out = Bun.spawnSync(['sh', '-c', metaCommand(file, statSync(file).size, false)]).stdout.toString()
  expect(out).not.toContain('xxxx')
  expect(out).not.toContain('yyyy')
  expect(out).not.toContain('log log')
  expect(out).not.toContain('first title')
  const meta = newMeta()
  for (const l of out.split('\n').filter(Boolean)) normalize(JSON.parse(l), meta)
  expect(meta.title).toBe('last title')
  expect([...meta.subagents.values()].map((s) => s.description)).toEqual(['look around'])
  expect(meta.tasks.get('b1')?.status).toBe('stopped')
  expect(meta.tasks.get('b2')?.summary).toBe('build done')
})
