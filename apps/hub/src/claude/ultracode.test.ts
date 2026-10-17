import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test'
import { registry } from '../hosts/registry.ts'
import { setUltracode } from './actions.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())

const R = '─'.repeat(100)
const unq = (s: string) => s.replace(/^'|'$/g, '').replace(/'\\''/g, "'")

/**
 * A Claude pane as far as the switch can tell: its box, the "ultracode" label on the box's rule
 * while the switch is on, and what Claude prints under `/effort ultracode` when it can't.
 */
function fakeClaude(start: { on: boolean; refuse?: string }) {
  const pane = { on: start.on, box: '', said: '' }
  const sent: string[] = []
  const exec = async (cmd: string) => {
    if (cmd.includes('@@CAP')) {
      const rule = pane.on ? `${R.slice(0, 88)} ultracode ─` : R
      const answer = pane.said ? `❯ /effort ultracode on\n  ⎿  ${pane.said}\n` : ''
      const screen = `● Done.\n${answer}${rule}\n❯ ${pane.box}\n${R}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`
      return { code: 0, stdout: `@@CAP %9\n${screen}\n`, stderr: '' }
    }
    for (const part of cmd.split(' && ')) {
      const keys = /send-keys -t \S+ (?:-l -- (.*)|(\S+))$/.exec(part)
      if (!keys) continue
      if (keys[1] !== undefined) pane.box += unq(keys[1])
      else if (keys[2] === 'C-u') pane.box = ''
      else if (keys[2] === 'BSpace') pane.box = pane.box.slice(0, -1)
      else if (keys[2] === 'Enter') {
        sent.push(pane.box)
        const m = pane.box.match(/^\/effort ultracode (on|off)$/)
        if (m && start.refuse) pane.said = start.refuse
        else if (m) pane.on = m[1] === 'on'
        pane.box = ''
      }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  spyOn(registry, 'findPane').mockReturnValue({ pane: { id: '%9', width: 100, agent: { kind: 'claude' } } } as any)
  spyOn(registry, 'host').mockReturnValue({ exec } as any)
  spyOn(registry, 'refresh').mockImplementation(() => {})
  return sent
}

afterEach(() => {
  ;(registry.findPane as any).mockRestore?.()
  ;(registry.host as any).mockRestore?.()
  ;(registry.refresh as any).mockRestore?.()
})

test('turning it on types the command, and the label on the box confirms it', async () => {
  const sent = fakeClaude({ on: false })
  await setUltracode('local', '%9', true)
  expect(sent).toEqual(['/effort ultracode on'])
}, 20_000)

test('turning it off the same way', async () => {
  const sent = fakeClaude({ on: true })
  await setUltracode('local', '%9', false)
  expect(sent).toEqual(['/effort ultracode off'])
}, 20_000)

test('already as wanted: nothing is typed', async () => {
  const sent = fakeClaude({ on: true })
  await setUltracode('local', '%9', true)
  expect(sent).toEqual([])
})

test("when Claude can't, its own answer is the error", async () => {
  fakeClaude({ on: false, refuse: 'Ultracode needs dynamic workflows enabled (see /config). Valid options are: on, off' })
  await expect(setUltracode('local', '%9', true)).rejects.toThrow('Ultracode needs dynamic workflows enabled (see /config)')
}, 20_000)

test('not a Claude pane: refused before anything is typed', async () => {
  spyOn(registry, 'findPane').mockReturnValue({ pane: { id: '%9', width: 100, agent: { kind: 'codex' } } } as any)
  spyOn(registry, 'host').mockReturnValue({ exec: async () => ({ code: 0, stdout: '', stderr: '' }) } as any)
  await expect(setUltracode('local', '%9', true)).rejects.toThrow('Claude Code')
})
