import { expect, test } from 'bun:test'
import { GeminiDoc } from './gemini.ts'
import { newMeta } from '../claude/transcript.ts'

test("a $patch whose lists aren't lists is skipped, and the session reads on", () => {
  const doc = new GeminiDoc()
  doc.apply({ id: 'u1', type: 'user', content: 'hi' })
  doc.apply({ id: 'g1', type: 'gemini', content: 'one', toolCalls: [{ id: 'c1', name: 'run_shell_command', args: { command: 'ls' } }] })
  for (const updates of [{ id: 'u1', content: 'x' }, 7, 'u1', null]) doc.apply({ $patch: { updates } })
  doc.apply({ $patch: { updates: [null, { id: 'g1', toolCalls: { id: 'c1', result: 'no' } }], removeIds: 'u1' } })
  doc.apply({ $patch: { id: 'g1', content: 'two', toolCalls: [null, { id: 'c1', result: [{ text: 'a.ts' }] }] } })
  expect(doc.items(newMeta())).toMatchObject([
    { kind: 'user', uuid: 'u1', text: 'hi' },
    { kind: 'assistant', uuid: 'g1:x', block: { type: 'text', text: 'two' } },
    { kind: 'assistant', uuid: 'g1:c1', block: { type: 'tool_use', id: 'c1', name: 'Bash' } },
    { kind: 'tool_result', uuid: 'g1:c1:r', toolUseId: 'c1', text: 'a.ts' },
  ])
})
