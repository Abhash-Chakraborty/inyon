import { describe, expect, test } from 'bun:test'
import { screenFixture } from '../fixtures.ts'
import { parseScreen } from '../claude/screen.ts'
import { currentTab } from './opencode-screen.ts'

// real OpenCode 1.19.3 captures (tmux capture-pane -p -e), wide ones with the sidebar
const screen = (name: string, width: number) => parseScreen(screenFixture('opencode', name), width, 'opencode')

describe('OpenCode screen', () => {
  test('draft, agent, model and variant from the input box, sidebar cut off', () => {
    const s = screen('draft-wide', 160)
    expect(s.inputVisible).toBe(true)
    expect(s.working).toBe(false)
    expect(s.draft).toBe('hello from the draft')
    expect(s.mode).toBe('plan')
    expect(s.model).toBe('DeepSeek V4.1 Flash Free OpenCode')
    expect(s.effort).toBe('max')
    expect(s.prompt).toBeUndefined()
  })

  test('narrow window, no sidebar; the context percentage comes off the wrapped status row', () => {
    const s = screen('draft-narrow', 110)
    expect(s.draft).toBe('second draft line')
    expect(s.mode).toBe('build')
    expect(s.effort).toBe('max')
    expect(s.contextPct).toBe(8)
    expect(s.contextUsed).toBeUndefined()
  })

  test('the sidebar gives the context tokens, the percentage and the cost', () => {
    const s = screen('idle-wide', 160)
    expect(s.inputVisible).toBe(true)
    expect(s.draft).toBeUndefined()
    expect(s.contextUsed).toBe(36898)
    expect(s.contextPct).toBe(18)
    expect(s.costUsd).toBe(0)
  })

  test('working while the status line offers esc interrupt', () => {
    const s = screen('working', 160)
    expect(s.working).toBe(true)
    expect(s.activity).toBe('Working')
    expect(s.draft).toBeUndefined()
    expect(s.contextPct).toBe(18)
  })

  test("what /undo leaves in the box isn't a draft", () => {
    const s = screen('reverted', 160)
    expect(s.inputVisible).toBe(true)
    expect(s.draft).toBeUndefined()
    expect(s.model).toBe('DeepSeek V4.1 Flash Free OpenCode')
  })

  test('permission request becomes three buttons', () => {
    const s = screen('permission', 110)
    expect(s.prompt?.options.map((o) => o.label)).toEqual(['Allow once', 'Allow always', 'Reject'])
    expect(s.prompt?.body.join('\n')).toContain('Access external directory /etc')
    expect(s.prompt?.body.join('\n')).toContain('- /etc/*')
    expect(s.prompt?.navigate).toBe(true)
    expect(s.model).toBeUndefined()
  })

  test('"Allow always" asks once more', () => {
    const s = screen('permission-always', 110)
    expect(s.prompt?.options.map((o) => o.label)).toEqual(['Confirm', 'Cancel'])
    expect(s.prompt?.body[0]).toBe('Always allow this until OpenCode restarts?')
  })

  test("the agent's question with descriptions and a free-text choice", () => {
    const s = screen('question', 110)
    expect(s.prompt?.body).toEqual(['Do you prefer tabs or spaces?'])
    expect(s.prompt?.options.map((o) => [o.n, o.label])).toEqual([[1, 'Tabs'], [2, 'Spaces'], [3, 'Type your own answer']])
    expect(s.prompt?.options[0].detail).toBe('Use tab characters for indentation')
    expect(s.prompt?.freeTextOption).toBe(3)
    expect(s.prompt?.multi).toBe(false)
    expect(s.prompt?.confirm).toBeUndefined()
    expect(s.prompt?.tabs).toBeUndefined()
  })

  test('a multi-select question: checkboxes, a tab strip and a Confirm step', () => {
    const s = screen('question-multi', 110)
    expect(s.prompt?.body).toEqual(['Which colours do you like? (select all that apply)'])
    expect(s.prompt?.multi).toBe(true)
    expect(s.prompt?.options.map((o) => [o.label, o.checked])).toEqual([['Red', false], ['Green', false], ['Blue', false], ['Type your own answer', false]])
    expect(s.prompt?.tabs).toEqual([{ label: 'Colour preference', done: false, current: true }, { label: 'Confirm', done: false, current: false }])
    expect(s.prompt?.confirm).toBe('Confirm')
    const checked = screen('question-multi-checked', 110)
    expect(checked.prompt?.options.map((o) => o.checked)).toEqual([false, true, true, false])
  })

  test('the Confirm tab reviews the answers and Enter sends them', () => {
    const s = screen('question-review', 110)
    expect(s.prompt?.body).toEqual(['Review', 'Colour preference: Green, Blue'])
    expect(s.prompt?.options).toEqual([])
    expect(s.prompt?.confirm).toBe('Submit')
    expect(s.prompt?.tabs?.map((t) => [t.label, t.current, t.done])).toEqual([['Colour preference', false, true], ['Confirm', true, false]])
  })

  test('two questions at once: the first tab is open, and its answer confirms and moves on', () => {
    const s = screen('question-two', 160)
    expect(s.prompt?.tabs?.map((t) => [t.label, t.current])).toEqual([['Indentation', true], ['Colours', false], ['Confirm', false]])
    expect(s.prompt?.body).toEqual(['Do you prefer tabs or spaces?'])
    expect(s.prompt?.options.map((o) => o.label)).toEqual(['Tabs', 'Spaces', 'Type your own answer'])
    expect(s.prompt?.multi).toBe(false)
    expect(s.prompt?.confirm).toBeUndefined()
  })

  test('a menu over the box (the model list) hides the input but keeps the footer', () => {
    const s = screen('models-dialog', 160)
    expect(s.inputVisible).toBe(false)
    expect(s.prompt).toBeUndefined()
    expect(s.model).toBe('DeepSeek V4.1 Flash Free OpenCode')
  })

  test('the variant menu after picking a model is a menu too', () => {
    const s = screen('select-variant', 120)
    expect(s.inputVisible).toBe(false)
    expect(s.prompt).toBeUndefined()
  })

  test('the slash popup above the box is not part of the draft', () => {
    const s = screen('slash-popup', 120)
    expect(s.draft).toBe('/und')
    expect(s.inputVisible).toBe(true)
    expect(s.effort).toBe('high')
  })

  test('home screen (no conversation yet): the box is centred under the logo', () => {
    const s = screen('home', 110)
    expect(s.inputVisible).toBe(true)
    expect(s.working).toBe(false)
    expect(s.mode).toBe('build')
    expect(s.model).toBe('DeepSeek V4.1 Flash Free OpenCode')
    expect(s.effort).toBe('max')
    expect(s.draft).toBeUndefined()
    expect(s.contextPct).toBeUndefined()
  })

  test('home screen with the model menu over the box', () => {
    const s = screen('home-models', 120)
    expect(s.inputVisible).toBe(false)
    expect(s.prompt).toBeUndefined()
  })

  test('the open tab is the one on its own background; without colours nothing is picked', () => {
    const row = '\x1b[48;2;1;22;39m  \x1b[48;2;11;37;58m┃  \x1b[48;2;199;146;234m One\x1b[48;2;11;37;58m   Two   Confirm'
    expect(currentTab(row, ['One', 'Two', 'Confirm'])).toBe(0)
    expect(currentTab(row.replace('48;2;199;146;234', '48;2;11;37;58'), ['One', 'Two', 'Confirm'])).toBe(-1)
    expect(currentTab('┃  One   Two   Confirm', ['One', 'Two', 'Confirm'])).toBe(-1)
    expect(currentTab(undefined, ['One'])).toBe(-1)
  })
})
