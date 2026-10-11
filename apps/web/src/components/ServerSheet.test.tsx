import { describe, expect, test } from 'bun:test'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { HostConfig } from '@tether/protocol'
import { ServerSheet } from './ServerSheet.tsx'
import { api } from '../test/fakes.ts'
import { fresh } from '../test/fixtures.ts'
import { flush, renderSettled as render } from '../test/render.tsx'

const work: HostConfig = { id: 's1', name: 'Work', kind: 'ssh', target: 'me@10.0.0.1', port: 2222, auth: 'phone-key', hostKey: 'SHA256:abc' }
const home: HostConfig = { id: 's2', name: 'Home', kind: 'ssh', target: 'pi@192.168.1.2', auth: 'password', hostKey: 'SHA256:def' }
const noop = () => {}
const field = (placeholder: string) => screen.getByPlaceholderText(placeholder) as HTMLInputElement

describe('ServerSheet keeps what you type while live data flows', () => {
  test('renaming survives the store rebuilding the server on every refresh', async () => {
    const user = userEvent.setup()
    const { rerender } = await render(<ServerSheet open onClose={noop} edit={work} />)
    const name = field('Work server')
    expect(name.value).toBe('Work')
    await user.clear(name)
    await user.type(name, 'Pro')
    // a status poll: an equal server, every object new
    rerender(<ServerSheet open onClose={noop} edit={fresh(work)} />)
    rerender(<ServerSheet open onClose={noop} edit={{ ...fresh(work), name: 'Work (renamed elsewhere)' }} />)
    await user.type(name, 'd box')
    expect(name.value).toBe('Prod box')
  })

  test('the address and port fields keep their edits too', async () => {
    const user = userEvent.setup()
    const { rerender } = await render(<ServerSheet open onClose={noop} edit={work} />)
    const target = field('you@100.64.0.5')
    const port = field('22')
    await user.clear(target)
    await user.type(target, 'me@')
    await user.clear(port)
    await user.type(port, '2')
    rerender(<ServerSheet open onClose={noop} edit={fresh(work)} />)
    await user.type(target, '10.0.0.9')
    await user.type(port, '2x2')
    expect(target.value).toBe('me@10.0.0.9')
    expect(port.value).toBe('222')
  })

  test('adding a server: a refresh does not clear the form', async () => {
    const user = userEvent.setup()
    const { rerender } = await render(<ServerSheet open onClose={noop} />)
    await user.type(field('Work server'), 'New')
    rerender(<ServerSheet open onClose={noop} edit={undefined} />)
    await user.type(field('Work server'), ' one')
    expect(field('Work server').value).toBe('New one')
  })

  test("reopening shows the server's current values", async () => {
    const user = userEvent.setup()
    const { rerender } = await render(<ServerSheet open onClose={noop} edit={work} />)
    await user.type(field('Work server'), ' typed then cancelled')
    rerender(<ServerSheet open={false} onClose={noop} edit={work} />)
    rerender(<ServerSheet open onClose={noop} edit={{ ...work, name: 'Work 2', port: 2200 }} />)
    await flush()
    expect(field('Work server').value).toBe('Work 2')
    expect(field('22').value).toBe('2200')
  })

  test('switching to another server shows its values', async () => {
    const user = userEvent.setup()
    const { rerender } = await render(<ServerSheet open onClose={noop} edit={work} />)
    await user.type(field('Work server'), 'xx')
    rerender(<ServerSheet open onClose={noop} edit={home} />)
    await flush()
    expect(field('Work server').value).toBe('Home')
    expect(field('you@100.64.0.5').value).toBe('pi@192.168.1.2')
    expect(field('22').value).toBe('')
  })

  test('saving sends what was typed, keeping the trusted key', async () => {
    const user = userEvent.setup()
    const onClose = () => {}
    const { rerender } = await render(<ServerSheet open onClose={onClose} edit={work} />)
    await user.clear(field('Work server'))
    await user.type(field('Work server'), 'Prod')
    rerender(<ServerSheet open onClose={onClose} edit={fresh(work)} />)
    fireEvent.submit(document.getElementById('server-form')!)
    await flush()
    expect(api.editServer.mock.calls[0]).toEqual(['s1', { name: 'Prod', target: 'me@10.0.0.1', port: 2222, hostKey: 'SHA256:abc', auth: 'phone-key', password: undefined, privateKey: undefined, passphrase: undefined }])
  })
})

test("says why the phone-key command is missing instead of just hiding it", async () => {
  const { spyOn } = await import('bun:test')
  const { api: real } = await import('../lib/api.ts')
  const key = spyOn(real, 'phoneKey').mockRejectedValue(new Error('keystore locked'))
  await render(<ServerSheet open onClose={noop} />)
  await flush()
  expect(screen.getByText(/Couldn't read this phone's key \(keystore locked\)/)).toBeTruthy()
  key.mockRestore()
})
