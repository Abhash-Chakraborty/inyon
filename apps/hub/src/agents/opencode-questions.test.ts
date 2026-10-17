import { describe, expect, test } from 'bun:test'
import { CONFIRM_OPTION } from '@inyon/protocol'
import { OpenCodeQuestionFlow } from './opencode-questions.ts'

const tabs = { question: 'Do you prefer tabs or spaces?', header: 'Indentation', options: [{ label: 'Tabs', description: 'Indent with tab characters' }, { label: 'Spaces', description: 'Indent with spaces' }] }
const colours = { question: 'Which colours do you like?', header: 'Colours', options: [{ label: 'Red', description: 'Red' }, { label: 'Green', description: 'Green' }, { label: 'Blue', description: 'Blue' }], multiple: true }

describe("OpenCode's questions through its API", () => {
  test('one question: the options, a free-text choice, and a pick that ends it', () => {
    const flow = new OpenCodeQuestionFlow('que_1', [tabs])
    const p = flow.prompt()
    expect(p.body).toEqual(['Do you prefer tabs or spaces?'])
    expect(p.options.map((o) => [o.n, o.label, o.detail])).toEqual([[1, 'Tabs', 'Indent with tab characters'], [2, 'Spaces', 'Indent with spaces'], [3, 'Type your own answer', undefined]])
    expect(p.freeTextOption).toBe(3)
    expect(p.tabs).toBeUndefined()
    expect(p.multi).toBe(false)
    expect(p.api).toBe(true)
    expect(flow.answer(2)).toBe(true)
    expect(flow.answers).toEqual([['Spaces']])
    expect(flow.done).toBe(true)
    expect(() => flow.answer(1)).toThrow('answered already')
  })

  test('a typed answer, and no free text when the question forbids it', () => {
    const flow = new OpenCodeQuestionFlow('que_1', [tabs])
    expect(() => flow.answer(3)).toThrow('Type an answer first')
    expect(flow.answer(3, '  two spaces ')).toBe(true)
    expect(flow.answers).toEqual([['two spaces']])
    const strict = new OpenCodeQuestionFlow('que_2', [{ ...tabs, custom: false }])
    expect(strict.prompt().freeTextOption).toBeUndefined()
    expect(() => strict.answer(3)).toThrow('not in the question')
  })

  test('checkboxes toggle and Confirm sends them; the tab strip follows along', () => {
    const flow = new OpenCodeQuestionFlow('que_1', [tabs, colours])
    expect(flow.prompt().tabs).toEqual([{ label: 'Indentation', done: false, current: true }, { label: 'Colours', done: false, current: false }])
    expect(flow.answer(1)).toBe(false)
    let p = flow.prompt()
    expect(p.tabs).toEqual([{ label: 'Indentation', done: true, current: false }, { label: 'Colours', done: false, current: true }])
    expect(p.multi).toBe(true)
    expect(p.confirm).toBe('Confirm')
    expect(p.options.map((o) => o.checked)).toEqual([false, false, false, false])
    expect(() => flow.answer(CONFIRM_OPTION)).toThrow('Pick at least one')
    flow.answer(1)
    flow.answer(3)
    flow.answer(1)
    flow.answer(2)
    p = flow.prompt()
    expect(p.options.map((o) => [o.label, o.checked])).toEqual([['Red', false], ['Green', true], ['Blue', true], ['Type your own answer', false]])
    expect(flow.answer(CONFIRM_OPTION)).toBe(true)
    expect(flow.answers).toEqual([['Tabs'], ['Green', 'Blue']])
  })

  test('a checkbox question that is not the last says Next, and a typed answer joins the ticks', () => {
    const flow = new OpenCodeQuestionFlow('que_1', [colours, tabs])
    expect(flow.prompt().confirm).toBe('Next')
    flow.answer(4, 'Teal')
    flow.answer(1)
    expect(flow.prompt().options[3].checked).toBe(true)
    expect(flow.answer(CONFIRM_OPTION)).toBe(false)
    expect(flow.answers[0]).toEqual(['Red', 'Teal'])
    expect(() => flow.answer(CONFIRM_OPTION)).toThrow('one answer')
    expect(flow.answer(2)).toBe(true)
    expect(flow.answers).toEqual([['Red', 'Teal'], ['Spaces']])
  })

  test('a request with no questions is refused', () => {
    expect(() => new OpenCodeQuestionFlow('que_0', [])).toThrow()
  })
})
