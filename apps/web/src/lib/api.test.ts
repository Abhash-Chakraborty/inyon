import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { realApi as api, realApiModule } from '../test/fakes.ts'

// The real request code (the rest of the suite gets a fake api), against a fake fetch.
const { ApiError, paneSlug, paneFromSlug } = realApiModule
const realFetch = globalThis.fetch
let reply: () => Response
const fetchMock = mock(async (_req: Request) => reply())
const ok = (body: unknown = {}) => () => new Response(JSON.stringify(body), { status: 200 })

beforeEach(() => {
  fetchMock.mockClear()
  reply = ok()
  globalThis.fetch = fetchMock as any
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const sent = () => fetchMock.mock.calls[0][0]
const json = async () => JSON.parse(await sent().text())
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure') }, (e) => e as InstanceType<typeof ApiError>)

describe('requests', () => {
  test('a GET goes to the hub with the session cookie and no body', async () => {
    reply = ok({ authed: true })
    expect(await api.session()).toEqual({ authed: true })
    const req = sent()
    expect(req.method).toBe('GET')
    expect(req.url).toBe('http://localhost:5173/api/session')
    expect(req.credentials).toBe('same-origin')
    expect(req.headers.get('content-type')).toBeNull()
  })

  test('a body goes as JSON', async () => {
    await api.login('hunter22')
    expect(sent().method).toBe('POST')
    expect(sent().headers.get('content-type')).toBe('application/json')
    expect(await json()).toEqual({ password: 'hunter22' })
  })

  test('pane paths drop the % and encode the machine id', async () => {
    await api.send('my box', '%12', 'hello', 'r1')
    expect(sent().url).toBe('http://localhost:5173/api/hosts/my%20box/panes/12/send')
    expect(await json()).toEqual({ text: 'hello', requestId: 'r1' })
  })

  test('renaming sends the new name with PUT', async () => {
    await api.rename('box', '%3', 'Login fix')
    expect([sent().method, sent().url]).toEqual(['PUT', 'http://localhost:5173/api/hosts/box/panes/3/name'])
    expect(await json()).toEqual({ name: 'Login fix' })
  })

  test('editing a server PATCHes only what changed', async () => {
    await api.editServer('srv/1', { name: 'Work' })
    expect([sent().method, sent().url]).toEqual(['PATCH', 'http://localhost:5173/api/hosts/srv%2F1'])
    expect(await json()).toEqual({ name: 'Work' })
  })

  test('query strings are encoded', async () => {
    await api.readConfig('box', '/home/me/.claude/settings.json?x=1&y')
    const url = new URL(sent().url)
    expect(url.pathname).toBe('/api/hosts/box/config')
    expect(url.searchParams.get('path')).toBe('/home/me/.claude/settings.json?x=1&y')
  })

  test('pairing tells the machine where the hub is', async () => {
    await api.pair('Laptop')
    expect(await json()).toEqual({ name: 'Laptop', origin: 'http://localhost:5173' })
  })

  test('a success without JSON resolves to an empty object', async () => {
    reply = () => new Response('', { status: 204 })
    expect(await api.interrupt('box', '%1')).toEqual({})
  })
})

describe('errors', () => {
  test("the hub's message and status come through", async () => {
    reply = () => new Response(JSON.stringify({ error: 'No such pane' }), { status: 404 })
    const err = await failure(api.interrupt('box', '%1'))
    expect(err).toBeInstanceOf(ApiError)
    expect([err.status, err.message]).toEqual([404, 'No such pane'])
  })

  test('without one, a generic message with the status', async () => {
    reply = () => new Response('<html>Bad gateway</html>', { status: 502 })
    const err = await failure(api.interrupt('box', '%1'))
    expect(err.message).toBe('Request failed (502)')
  })

  test('a 401 signs the app out, except for a wrong password at login', async () => {
    const out = mock(() => {})
    window.addEventListener('inyon:signed-out', out)
    try {
      reply = () => new Response('{}', { status: 401 })
      await api.configs('box').catch(() => {})
      expect(out).toHaveBeenCalledTimes(1)
      await api.login('wrong').catch(() => {})
      expect(out).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('inyon:signed-out', out)
    }
  })

  test('logout never throws', async () => {
    reply = () => new Response('{}', { status: 500 })
    expect(await api.logout()).toBeUndefined()
  })
})

describe('upload', () => {
  /** Just enough XMLHttpRequest to answer one upload. */
  class FakeXHR {
    static last: FakeXHR
    static answer = { status: 200, body: '' }
    upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {}
    onload?: () => void
    onerror?: () => void
    status = 0
    responseText = ''
    url = ''
    form?: FormData
    open(_method: string, url: string) {
      this.url = url
    }
    send(form: FormData) {
      FakeXHR.last = this
      this.form = form
      queueMicrotask(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 })
        this.status = FakeXHR.answer.status
        this.responseText = FakeXHR.answer.body
        if (this.status) this.onload?.()
        else this.onerror?.()
      })
    }
  }
  const realXHR = globalThis.XMLHttpRequest
  beforeEach(() => void (globalThis.XMLHttpRequest = FakeXHR as any))
  afterEach(() => void (globalThis.XMLHttpRequest = realXHR))
  const file = () => new File(['hi'], 'a.txt', { type: 'text/plain' })

  test('reports progress and resolves to the saved file', async () => {
    const saved = { name: 'a.txt', path: '/up/a.txt', size: 2, type: 'text/plain' }
    FakeXHR.answer = { status: 200, body: JSON.stringify({ files: [saved] }) }
    const progress: number[] = []
    expect(await api.upload('box', '%4', file(), (f) => progress.push(f))).toEqual(saved)
    expect(progress).toEqual([0.5])
    expect(FakeXHR.last.url).toBe('/api/hosts/box/uploads')
    expect(FakeXHR.last.form!.get('pane')).toBe('4')
  })

  test('fails with the hub message, or a network error', async () => {
    FakeXHR.answer = { status: 413, body: JSON.stringify({ error: 'Too large' }) }
    expect(await api.upload('box', undefined, file()).catch((e) => [e.status, e.message])).toEqual([413, 'Too large'])
    FakeXHR.answer = { status: 200, body: '{"files":[]}' }
    expect(await api.upload('box', undefined, file()).catch((e) => e.message)).toBe('Upload failed (200)')
    FakeXHR.answer = { status: 0, body: '' }
    expect(await api.upload('box', undefined, file()).catch((e) => e.message)).toBe('Network error during upload')
  })
})

test('pane slugs', () => {
  expect(paneSlug('%12')).toBe('12')
  expect(paneFromSlug('12')).toBe('%12')
  expect(paneFromSlug('%12')).toBe('%12')
})
