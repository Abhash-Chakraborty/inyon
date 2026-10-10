import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseScreen } from '../claude/screen.ts'

// real OpenCode 1.18.35 captures (tmux capture-pane -p -e), wide ones with the sidebar
const screen = (name: string, width: number) =>
  parseScreen(readFileSync(new URL(`../claude/fixtures/${name}.txt`, import.meta.url), 'utf8').split('\n'), width, 'opencode')

describe('OpenCode screen', () => {
  test('draft, agent and model from the input box, sidebar cut off', () => {
    const s = screen('opencode-draft-wide', 160)
    expect(s.inputVisible).toBe(true)
    expect(s.working).toBe(false)
    expect(s.draft).toBe('hello from the draft')
    expect(s.mode).toBe('build')
    expect(s.model).toBe('Big Pickle OpenCode Zen')
    expect(s.prompt).toBeUndefined()
  })

  test('narrow window, no sidebar', () => {
    const s = screen('opencode-draft-narrow', 110)
    expect(s.draft).toBe('second draft line')
    expect(s.mode).toBe('build')
  })

  test('working while the status line offers esc interrupt', () => {
    const s = screen('opencode-working', 160)
    expect(s.working).toBe(true)
    expect(s.activity).toBe('Working')
    expect(s.draft).toBeUndefined()
  })

  test('permission request becomes three buttons', () => {
    const s = screen('opencode-permission', 160)
    expect(s.prompt?.options.map((o) => o.label)).toEqual(['Allow once', 'Allow always', 'Reject'])
    expect(s.prompt?.body.join('\n')).toContain('Access external directory /etc')
    expect(s.prompt?.body.join('\n')).toContain('- /etc/*')
    expect(s.prompt?.navigate).toBe(true)
  })

  test("the agent's question with descriptions and a free-text choice", () => {
    const s = screen('opencode-question', 160)
    expect(s.prompt?.body).toEqual(['Do you want tabs or spaces?'])
    expect(s.prompt?.options.map((o) => [o.n, o.label])).toEqual([[1, 'Tabs'], [2, 'Spaces'], [3, 'Type your own answer']])
    expect(s.prompt?.options[0].detail).toBe('Use tab characters for indentation')
    expect(s.prompt?.freeTextOption).toBe(3)
  })

  test('a menu over the box (/models) hides the input but keeps the footer', () => {
    const s = screen('opencode-models-dialog', 110)
    expect(s.inputVisible).toBe(false)
    expect(s.prompt).toBeUndefined()
    expect(s.model).toBe('Big Pickle OpenCode Zen')
  })

  test('the slash popup above the box is not part of the draft', () => {
    const s = screen('opencode-slash-popup', 110)
    expect(s.draft).toBe('/undo')
    expect(s.inputVisible).toBe(true)
  })

  test('home screen (no conversation yet): the box is centred under the logo', () => {
    const s = screen('opencode-home', 120)
    expect(s.inputVisible).toBe(true)
    expect(s.working).toBe(false)
    expect(s.mode).toBe('build')
    expect(s.model).toBe('Big Pickle OpenCode Zen')
    expect(s.draft).toBeUndefined()
  })

  test('home screen with the model menu over the box', () => {
    const s = screen('opencode-home-models', 94)
    expect(s.inputVisible).toBe(false)
    expect(s.prompt).toBeUndefined()
  })
})
