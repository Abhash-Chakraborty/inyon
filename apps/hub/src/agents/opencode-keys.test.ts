import { describe, expect, test } from 'bun:test'
import { DEFAULT_KEYS, keysFrom, mergeKeybinds, opencodeKeys, parseJsonc, tmuxKeys } from './opencode-keys.ts'

describe("OpenCode's key bindings", () => {
  test("OpenCode's key names become tmux's", () => {
    expect(tmuxKeys('tab')).toEqual(['Tab'])
    expect(tmuxKeys('shift+tab')).toEqual(['BTab'])
    expect(tmuxKeys('ctrl+t')).toEqual(['C-t'])
    expect(tmuxKeys('escape')).toEqual(['Escape'])
    expect(tmuxKeys('<leader>m')).toEqual(['C-x', 'm'])
    expect(tmuxKeys('<leader>m', 'ctrl+a')).toEqual(['C-a', 'm'])
    expect(tmuxKeys('f2')).toEqual(['F2'])
    expect(tmuxKeys('ctrl+alt+g')).toEqual(['C-M-g'])
    expect(tmuxKeys('shift+a')).toEqual(['A'])
    // the first alternative tmux can send
    expect(tmuxKeys('super+k,ctrl+k')).toEqual(['C-k'])
    expect(tmuxKeys('none')).toBeUndefined()
    expect(tmuxKeys('super+k')).toBeUndefined()
    expect(tmuxKeys('shift+escape')).toBeUndefined()
  })

  test('the defaults are what OpenCode 1.19 ships with', () => {
    const keys = keysFrom({})
    expect(keys).toEqual({ agent_cycle: ['Tab'], agent_cycle_reverse: ['BTab'], variant_cycle: ['C-t'], model_list: ['C-x', 'm'], session_interrupt: ['Escape'] })
    expect(DEFAULT_KEYS.leader).toBe('ctrl+x')
  })

  test('a config rebinding a key (or the leader) changes what is pressed; one tmux cannot send falls back', () => {
    const keys = keysFrom({ leader: 'ctrl+a', agent_cycle: 'f2', variant_cycle: 'super+v', session_interrupt: 'ctrl+c,escape' })
    expect(keys.agent_cycle).toEqual(['F2'])
    expect(keys.model_list).toEqual(['C-a', 'm'])
    expect(keys.variant_cycle).toEqual(['C-t'])
    expect(keys.session_interrupt).toEqual(['C-c'])
  })

  test('opencode.jsonc with comments and trailing commas, user then project', () => {
    expect(parseJsonc('{ // leader\n "keybinds": { "leader": "ctrl+a", /* block */ "agent_cycle": "f2", }, "url": "http://x//y" }')).toEqual({ keybinds: { leader: 'ctrl+a', agent_cycle: 'f2' }, url: 'http://x//y' })
    expect(parseJsonc('not json')).toBeUndefined()
    expect(mergeKeybinds(['{"keybinds":{"leader":"ctrl+a","agent_cycle":"f2"}}', '{"keybinds":{"agent_cycle":"f3"}}', '{"theme":"x"}'])).toEqual({ leader: 'ctrl+a', agent_cycle: 'f3' })
  })

  test("reads the user's and the project's files on the machine, and keeps the answer a minute", async () => {
    const cmds: string[] = []
    const host = { id: 'keys-' + Math.random(), exec: async (cmd: string) => { cmds.push(cmd); return { code: 0, stdout: '@@FILE\n{"keybinds":{"agent_cycle":"f2"}}\n@@FILE\n{"keybinds":{"variant_cycle":"f3"}}\n', stderr: '' } } }
    const keys = await opencodeKeys(host, '/work/a b')
    expect(keys.agent_cycle).toEqual(['F2'])
    expect(keys.variant_cycle).toEqual(['F3'])
    expect(keys.model_list).toEqual(['C-x', 'm'])
    expect(cmds[0]).toContain('opencode/opencode.jsonc')
    expect(cmds[0]).toContain(`'/work/a b'/.opencode/opencode.json`)
    await opencodeKeys(host, '/work/a b')
    expect(cmds.length).toBe(1)
    // a machine that can't be asked gets the defaults
    const down = { id: 'keys-down-' + Math.random(), exec: async () => { throw new Error('gone') } }
    expect((await opencodeKeys(down)).agent_cycle).toEqual(['Tab'])
  })
})
