import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { promptKey } from '@inyon/protocol'
import { registry } from '../hosts/registry.ts'
import { answer } from './actions.ts'
import { parseScreen } from './screen.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())

const screenFor = (body: string) => [body, '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']

test('an answer meant for a question already answered elsewhere never lands on the next one', async () => {
  const seen = screenFor('Allow reading README.md?')
  const now = screenFor('Allow replacing the deployment configuration?')
  const keys: string[] = []
  const exec = async (cmd: string) => {
    if (cmd.includes('capture-pane')) return { code: 0, stdout: '@@CAP %7\n' + now.join('\n'), stderr: '' }
    if (cmd.includes('send-keys')) keys.push(cmd)
    return { code: 0, stdout: '', stderr: '' }
  }
  spyOn(registry, 'host').mockReturnValue({ exec } as any)
  spyOn(registry, 'findPane').mockReturnValue({ pane: { id: '%7', width: 120, agent: { kind: 'claude' } } } as any)
  spyOn(registry, 'refresh').mockImplementation(() => {})

  // the card showed the README question; the screen now asks about the deployment config
  await expect(answer('box', '%7', 1, undefined, promptKey(parseScreen(seen, 120).prompt!))).rejects.toThrow('another one is waiting')
  expect(keys).toEqual([])
  // answering the question that's actually there works
  await answer('box', '%7', 1, undefined, promptKey(parseScreen(now, 120).prompt!))
  expect(keys).toHaveLength(1)
  expect(keys[0]).toEndWith(' 1')
})
