import { expect, test } from 'bun:test'
import type { ScreenState, ServerMsg } from '@inyon/protocol'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimCompanion, COMPANION_CODE_TTL, companionFor, companionFrame, contractRefusal, holdCompanionSocket, inboundRefusal, listCompanions, newCompanionCode, revokeCompanion, SCOPES, sendReason, textRefusal } from './companions.ts'
import { pasteText } from './tmux/tmux.ts'
import { hubId } from './phones.ts'
import { rememberAddress, SLOW_LANE_MS } from './limits.ts'

// The code, the claim, the contract header and what a companion may send and receive, against a
// fixed clock; the routes themselves are covered by the conformance scenario, against both hubs.
const T0 = 1_700_000_000_000
const asCompanion = (token: string, contract?: string) =>
  new Request('http://hub/api/overview', { headers: { authorization: `Bearer ${token}`, ...(contract ? { 'x-inyon-contract': contract } : {}) } })
const read = async (r: Response) => ({ status: r.status, body: (await r.json()) as any })

test('a code is six characters without look-alikes, and a new one ends the last', async () => {
  const c = newCompanionCode(T0)
  expect(c.code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/)
  expect(c.expiresAt).toBe(T0 + COMPANION_CODE_TTL)
  const newer = newCompanionCode(T0).code
  if (newer !== c.code) expect((await read(claimCompanion('10.1.0.1', { code: c.code, name: 'Old' }, T0))).body.reason).toBe('bad-code')
})

test('a claim works once, in any case, and its token is kept as a hash', async () => {
  const { code } = newCompanionCode(T0)
  const typed = `${code.slice(0, 3).toLowerCase()}-${code.slice(3)} `
  const r = await read(claimCompanion('10.1.0.2', { code: typed, name: '  Legato on abhash-laptop  ', app: 'Legato for Windows' }, T0 + 1000))
  expect(r.status).toBe(200)
  expect(r.body.token).toHaveLength(43)
  expect(r.body).toMatchObject({ hubId: hubId(), scopes: ['overview', 'chat', 'answer', 'send'], contractVersion: 1 })
  // plain http: no certificate to pin
  expect(r.body.tlsFingerprint).toBeUndefined()
  const c = companionFor(asCompanion(r.body.token), T0 + 1000)!
  expect([c.name, c.app]).toEqual(['Legato on abhash-laptop', 'Legato for Windows'])
  expect(c.tokenHash).not.toBe(r.body.token)
  expect(companionFor(asCompanion(r.body.token.slice(1)))).toBeUndefined()
  const again = await read(claimCompanion('10.1.0.2', { code, name: 'Again' }, T0 + 2000))
  expect([again.status, again.body.reason]).toEqual([401, 'bad-code'])
  expect(listCompanions().find((x) => x.id === c.id)).toEqual({ id: c.id, name: 'Legato on abhash-laptop', app: 'Legato for Windows', scopes: ['overview', 'chat', 'answer', 'send'], contractVersion: 1, pairedAt: T0 + 1000, lastSeen: T0 + 1000 })
  expect(revokeCompanion(c.id)).toBe(true)
  expect(companionFor(asCompanion(r.body.token))).toBeUndefined()
  expect(revokeCompanion(c.id)).toBe(false)
})

test('an expired code is refused, and eight failures a minute stop an address', async () => {
  const { code } = newCompanionCode(T0)
  expect((await read(claimCompanion('10.1.0.3', { code }, T0 + COMPANION_CODE_TTL))).status).toBe(401)
  const t = T0 + 10 * 60_000
  for (let i = 0; i < 7; i++) expect((await read(claimCompanion('10.1.0.4', { code: 'AAAAAA' }, t))).status).toBe(401)
  const good = newCompanionCode(t).code
  expect((await read(claimCompanion('10.1.0.4', { code: 'AAAAAA' }, t))).status).toBe(401)
  const limited = await read(claimCompanion('10.1.0.4', { code: good }, t))
  expect([limited.status, limited.body.reason]).toEqual([429, 'rate-limit'])
  expect((await read(claimCompanion('10.1.0.5', { code: good, name: 'x' }, t))).status).toBe(200)
})

test('a code with a letter outside ASCII is a wrong code, not an error', async () => {
  newCompanionCode(T0)
  const r = await read(claimCompanion('10.1.0.9', { code: 'ÄBCDEF' }, T0))
  expect([r.status, r.body.reason]).toEqual([401, 'bad-code'])
})

test('the contract header, or ?contract= on a WebSocket, must name version 1', async () => {
  expect(contractRefusal(asCompanion('x', '1'))).toBeUndefined()
  expect(contractRefusal(asCompanion('x', ' 1 '))).toBeUndefined()
  expect(contractRefusal(asCompanion('x'), '1')).toBeUndefined()
  const missing = await read(contractRefusal(asCompanion('x'))!)
  expect(missing).toEqual({ status: 426, body: { error: 'Send the X-Inyon-Contract header. This hub supports companion contract 1.', reason: 'contract', supported: [1] } })
  const two = await read(contractRefusal(asCompanion('x', '2'))!)
  expect([two.status, two.body.error]).toEqual([426, "This hub doesn't support companion contract 2. It supports 1."])
})

test('a companion may send only ping and the subscriptions its scopes allow', () => {
  for (const ok of [{ t: 'ping' }, { t: 'sub.overview' }, { t: 'sub.chat', host: 'box', pane: '%1' }, { t: 'unsub.chat', host: 'box', pane: '%1' }]) expect(inboundRefusal(JSON.stringify(ok), SCOPES)).toBeUndefined()
  for (const bad of [
    { t: 'term.open', id: '1', host: 'box', pane: '%1', cols: 80, rows: 24 },
    { t: 'term.in', id: '1', d: 'ls\r' },
    { t: 'draft', host: 'box', pane: '%1', text: 'x' },
    { t: 'chat.more', host: 'box', pane: '%1', before: 1 },
    { t: 'constructor' },
  ])
    expect(inboundRefusal(JSON.stringify(bad), SCOPES)).toStartWith('Not for companion apps: ')
  expect(inboundRefusal('not json', SCOPES)).toBe('Not for companion apps: an unreadable frame')
  expect(inboundRefusal(JSON.stringify({ t: 'sub.chat' }), ['overview'])).toBeDefined()
})

test('a companion gets no history, live text, drafts or terminal data, and its prompts carry their key', () => {
  const screen = {
    working: false,
    width: 80,
    draft: 'half a thought',
    prompt: { body: ['Bash command', 'rm -rf build', 'Do you want to proceed?'], options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: 'No', selected: false }], multi: false },
  } as ScreenState
  const v = companionFrame({ t: 'chat.screen', key: 'box:%1', screen }, SCOPES) as any
  expect(v.screen.prompt.key).toBe('Bashcommandrm-rfbuildDoyouwanttoproceed?1.Yes2.No')
  expect('draft' in v.screen).toBe(false)
  expect(companionFrame({ t: 'chat.screen', key: 'box:%1', screen }, ['overview'])).toBeUndefined()
  for (const m of [
    { t: 'term.data', id: '1', d: 'secret' },
    { t: 'chat.append', key: 'box:%1', items: [] },
    { t: 'chat.live', key: 'box:%1', items: [] },
    { t: 'chat.progress', key: 'box:%1', done: 1, total: 2 },
    { t: 'chat.draft', key: 'box:%1', text: 'x', source: 'app', at: 1 },
  ] as ServerMsg[])
    expect(companionFrame(m, SCOPES)).toBeUndefined()
  expect(companionFrame({ t: 'pong' }, [])).toEqual({ t: 'pong' })
  const notice: ServerMsg = { t: 'notify', host: 'box', pane: '%1', kind: 'waiting', title: 't', body: 'b' }
  expect(companionFrame(notice, SCOPES)).toBe(notice)
  expect(companionFrame(notice, ['chat'])).toBeUndefined()
})

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/protocol/ServerMsg/${name}.json`, import.meta.url), 'utf8')) as ServerMsg

test('a chat reaches a companion without its drafts, queue, send texts, links or paths', () => {
  const info = companionFrame(fixture('chat-info'), SCOPES) as any
  expect(Object.keys(info.info).sort()).toEqual(['agent', 'hostId', 'mode', 'model', 'paneId', 'running', 'sends', 'status', 'title', 'turn'])
  for (const s of info.info.sends) expect(Object.keys(s).sort()).toEqual(['at', 'id', 'state'])
  const reset = companionFrame({ ...(fixture('chat-info') as any), t: 'chat.reset', items: [{ kind: 'user', text: 'secret' }], hasMore: false }, SCOPES) as any
  expect(reset).toEqual(info)
  const queued = fixture('chat-screen-antigravity-queued') as Extract<ServerMsg, { t: 'chat.screen' }>
  const screen = { ...queued.screen, draft: 'half a thought', remote: 'https://claude.ai/code/session_x', background: '1 shell' }
  const v = companionFrame({ ...queued, screen }, SCOPES) as any
  expect(Object.keys(v.screen).sort()).toEqual(['activity', 'effort', 'inputVisible', 'mode', 'model', 'width', 'working'])
  expect(JSON.stringify(v)).not.toContain('half a thought')
})

test('the overview reaches a companion with what labels a session, and no paths, ids or numbers', () => {
  const v = companionFrame(fixture('overview'), SCOPES) as any
  const keys = new Map<string, Set<string>>()
  const add = (level: string, o: object) => Object.keys(o).forEach((k) => (keys.get(level) ?? keys.set(level, new Set()).get(level)!).add(k))
  for (const h of v.hosts) {
    add('host', h)
    add('config', h.config)
    for (const s of h.sessions) {
      add('session', s)
      for (const w of s.windows) {
        add('window', w)
        for (const p of w.panes) {
          add('pane', p)
          if (p.agent) add('agent', p.agent)
        }
      }
    }
  }
  const got = Object.fromEntries([...keys].map(([k, s]) => [k, [...s].sort()]))
  expect(got).toEqual({
    host: ['config', 'sessions', 'status'],
    config: ['id', 'kind', 'name'],
    session: ['id', 'name', 'windows'],
    window: ['active', 'id', 'index', 'name', 'panes'],
    pane: ['active', 'agent', 'dead', 'id', 'index', 'label', 'title'],
    agent: ['activity', 'kind', 'mode', 'options', 'state', 'waitingFor'],
  })
  for (const secret of ['transcriptPath', 'sessionId', '"pid"', '"cwd"', 'identityFile', 'tokenHash']) expect(JSON.stringify(v)).not.toContain(secret)
})

test('a companion types printable text only, and no line of it opens a command or a shell', () => {
  for (const bad of ['\u0015!id', 'x\n\u001b[201~\u0015!id\r', '\u0003', 'tidy up\u007f', 'hi\u009b201~']) expect(textRefusal(bad)?.status).toBe(400)
  for (const cmd of ['ok\n/model x', 'fine\r\n  !rm -rf build', '\u00a0/clear']) expect(textRefusal(cmd)?.status).toBe(403)
  expect(textRefusal('Run the tests again.\n\tThen tell me what failed, 100% / 2 or so!')).toBeUndefined()
})

test('a paste never carries its own end marker, for any caller', () => {
  expect(pasteText('x\r\n\u001b[201~\u0015!id\r')).toBe('x\n\u0015!id\n')
  expect(pasteText('a\u001b[20\u001b[201~1~b\u009b200~c')).toBe('abc')
})

test('a send that failed is named by what the hub said', () => {
  expect(sendReason('The agent is waiting for an answer to a question first')).toBe('prompt-open')
  expect(sendReason('No agent is running in this pane')).toBe('no-agent')
  expect(sendReason('OpenCode input is not visible. Open the terminal to check before sending.')).toBe('busy')
  expect(sendReason('Change Antigravity settings when it finishes working')).toBe('busy')
  expect(sendReason("Claude didn't record the message, so it may not have reached it")).toBe('not-landed')
})

test('removing a companion closes its connections only', async () => {
  const a = (await read(claimCompanion('10.1.0.6', { code: newCompanionCode(T0).code, name: 'A' }, T0))).body.token
  const b = (await read(claimCompanion('10.1.0.6', { code: newCompanionCode(T0).code, name: 'B' }, T0))).body.token
  const ca = companionFor(asCompanion(a), T0)!
  const cb = companionFor(asCompanion(b), T0)!
  const closed: string[] = []
  holdCompanionSocket(ca.id, { close: (code, why) => closed.push(`a ${code} ${why}`) })
  holdCompanionSocket(cb.id, { close: (code, why) => closed.push(`b ${code} ${why}`) })
  expect(revokeCompanion(ca.id)).toBe(true)
  expect(closed).toEqual(['a 4001 Companion removed'])
  expect(revokeCompanion(cb.id)).toBe(true)
})

test('contract 1.1: a hub serving HTTPS itself sends its certificate with the code and the claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inyon-tls-'))
  expect(Bun.spawnSync(['sh', '-c', 'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout k.pem -out c.pem -days 2 -subj /CN=hub'], { cwd: dir }).exitCode).toBe(0)
  const sha = createHash('sha256').update(Buffer.from(readFileSync(join(dir, 'c.pem'), 'utf8').replace(/-----[^-]+-----|\s/g, ''), 'base64')).digest('hex')
  Object.assign(process.env, { TLS_CERT: join(dir, 'c.pem'), TLS_KEY: join(dir, 'k.pem') })
  try {
    const c = newCompanionCode(T0)
    expect(c.tlsFingerprint).toBe(sha)
    const r = await read(claimCompanion('10.1.0.9', { code: c.code, name: 'Legato' }, T0))
    expect(r.body).toMatchObject({ contractVersion: 1, tlsFingerprint: sha })
  } finally {
    delete process.env.TLS_CERT
    delete process.env.TLS_KEY
    rmSync(dir, { recursive: true, force: true })
  }
})

// last: it leaves the shared count full for the rest of the file's clock
test('wrong codes from many addresses slow new addresses down, and an address that signed in carries on', async () => {
  const t = T0 + 20 * 60_000
  for (let i = 0; i < 30; i++) expect((await read(claimCompanion(`10.2.0.${i}`, { code: 'AAAAAA' }, t))).status).toBe(401)
  const good = newCompanionCode(t).code
  // the shared cap is reached: one try from a new address every few seconds
  expect((await read(claimCompanion('10.2.1.1', { code: 'AAAAAA' }, t))).status).toBe(401)
  expect((await read(claimCompanion('10.2.1.2', { code: good }, t))).body.reason).toBe('rate-limit')
  // the owner's own computer, where the password was typed, isn't held up
  rememberAddress('10.2.1.3')
  expect((await read(claimCompanion('10.2.1.3', { code: good, name: 'Legato' }, t))).status).toBe(200)
  const next = newCompanionCode(t).code
  expect((await read(claimCompanion('10.2.1.2', { code: next, name: 'Legato' }, t + SLOW_LANE_MS))).status).toBe(200)
})
