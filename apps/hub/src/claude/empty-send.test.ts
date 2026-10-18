import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import type { ChatItem } from '@inyon/protocol'
import { Host } from '../hosts/host.ts'
import { registry } from '../hosts/registry.ts'
import { sendMessage } from './actions.ts'
import { watchers } from './watcher.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())
afterAll(() => watchers.stop('empty-send:%9'))

test('an empty message is refused before it counts as a send', async () => {
  const config = { id: 'empty-send', name: 'Box', kind: 'local' as const }
  spyOn(registry, 'get').mockReturnValue({ host: new Host(config as any), state: { status: 'online' } } as any)
  spyOn(registry, 'host').mockReturnValue(new Host(config as any))
  spyOn(registry, 'findPane').mockReturnValue({ pane: { id: '%9', title: 'claude', agent: { kind: 'claude' } } } as any)
  await expect(sendMessage('empty-send', '%9', '   ', true, 'app-empty')).rejects.toMatchObject({ status: 400, message: 'Message is empty' })
  // nothing is followed, so the next thing the agent writes isn't taken for it
  const w = watchers.get('empty-send', '%9')
  w.items.push({ kind: 'assistant', uuid: 'reply-1', ts: '', seq: 0, msgId: 'm1', block: { type: 'text', text: 'Done.' } } satisfies ChatItem)
  expect(w.delivery('app-empty')).toBeUndefined()
})
