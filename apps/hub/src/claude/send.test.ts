import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test'
import { registry } from '../hosts/registry.ts'
import { sendMessageToPane } from './actions.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())

const R = '─'.repeat(100)
const unq = (s: string) => s.replace(/^'|'$/g, '').replace(/'\\''/g, "'")

/**
 * Claude's input box as far as a send can tell: a long paste shows as "[Pasted text #N]" and Enter
 * submits what's behind it, so a preview left over from an older draft looks like any other.
 */
function fakeClaude(box: { text?: string; paste?: string }[]) {
  let pastes = box.filter((b) => b.paste).length
  const sent: string[] = []
  const shown = () => box.map((b, i) => b.text ?? `[Pasted text #${i + pastes}]`).join('')
  const exec = async (cmd: string, opts: { input?: string } = {}) => {
    if (cmd.includes('@@CAP')) {
      const screen = `● Done.\n${R}\n❯ ${shown()}\n${R}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`
      return { code: 0, stdout: `@@CAP %9\n${screen}\n`, stderr: '' }
    }
    if (cmd.includes('paste-buffer')) {
      pastes++
      box.push(opts.input!.length > 800 ? { paste: opts.input } : { text: opts.input })
    } else for (const part of cmd.split(' && ')) {
      const keys = /send-keys -t \S+ (?:-l -- (.*)|(\S+))$/.exec(part)
      if (!keys) continue
      if (keys[1] !== undefined) box.push({ text: unq(keys[1]) })
      else if (keys[2] === 'C-u') box.length = 0
      else if (keys[2] === 'BSpace') box.pop()
      else if (keys[2] === 'Enter') sent.push(box.map((b) => b.text ?? b.paste).join('')), (box.length = 0)
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const pane = { id: '%9', width: 100, agent: { kind: 'claude' } }
  spyOn(registry, 'findPane').mockReturnValue({ pane } as any)
  spyOn(registry, 'host').mockReturnValue({ exec } as any)
  spyOn(registry, 'refresh').mockImplementation(() => {})
  return sent
}

afterEach(() => {
  ;(registry.findPane as any).mockRestore?.()
  ;(registry.host as any).mockRestore?.()
  ;(registry.refresh as any).mockRestore?.()
})

test('a paste preview left by an older draft is replaced, not sent', async () => {
  const message = 'Hey so I have one problem with how we load messages. ' + 'and then some more words '.repeat(60)
  // the mirror pasted the draft while it was still being dictated: a shorter start of the message
  const sent = fakeClaude([{ paste: message.slice(0, 918) }])
  await sendMessageToPane('local', '%9', message, true)
  expect(sent).toEqual([message])
}, 20_000)

test('a short message typed into an empty box goes in as typed', async () => {
  const sent = fakeClaude([])
  await sendMessageToPane('local', '%9', 'hello there', true)
  expect(sent).toEqual(['hello there'])
}, 20_000)
