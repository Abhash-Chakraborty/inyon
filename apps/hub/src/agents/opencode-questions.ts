import { CONFIRM_OPTION, type PromptOption, type ScreenPrompt } from '@inyon/protocol'

/** One question of OpenCode's question tool, as its `/question` route lists them. */
export interface OpenCodeQuestion {
  question: string
  header: string
  options: { label: string; description?: string }[]
  multiple?: boolean
  /** a typed answer is allowed (the default) */
  custom?: boolean
}

const FREE_TEXT = 'Type your own answer'

/**
 * A question request from OpenCode's API, answered one question at a time the way its terminal
 * does: a single choice moves on to the next question, checkboxes are toggled and sent with
 * Confirm, and the last answer sends them all (`answers`, one list of labels per question).
 */
export class OpenCodeQuestionFlow {
  index = 0
  readonly answers: string[][] = []
  private readonly checked: Set<number>[]
  private readonly typed: (string | undefined)[]

  constructor(readonly id: string, readonly questions: OpenCodeQuestion[]) {
    if (!questions.length) throw new Error('OpenCode asked nothing')
    this.checked = questions.map(() => new Set())
    this.typed = questions.map(() => undefined)
  }

  get done() {
    return this.index >= this.questions.length
  }

  /** The open question as a prompt the app can show. */
  prompt(): ScreenPrompt {
    const q = this.questions[Math.min(this.index, this.questions.length - 1)]
    const multi = !!q.multiple
    const options: PromptOption[] = q.options.map((o, i) => ({
      n: i + 1,
      label: o.label,
      detail: o.description && o.description !== o.label ? o.description : undefined,
      selected: i === 0,
      ...(multi ? { checked: this.checked[this.index]?.has(i + 1) ?? false } : {}),
    }))
    if (q.custom !== false) options.push({ n: options.length + 1, label: FREE_TEXT, selected: false, ...(multi ? { checked: this.typed[this.index] !== undefined } : {}) })
    const more = this.index < this.questions.length - 1
    return {
      body: [q.question],
      options,
      multi,
      api: true,
      freeTextOption: q.custom !== false ? options.length : undefined,
      tabs: this.questions.length > 1 ? this.questions.map((x, i) => ({ label: x.header, done: i < this.index, current: i === this.index })) : undefined,
      ...(multi ? { confirm: more ? 'Next' : 'Confirm' } : {}),
    }
  }

  /**
   * Applies a tap: an option number (toggled when the question takes several), the free-text
   * option with what was typed, or CONFIRM_OPTION to send the toggled choices. True once the
   * last question is answered and `answers` is ready to send.
   */
  answer(option: number, text?: string): boolean {
    if (this.done) throw new Error('These questions were answered already')
    const q = this.questions[this.index]
    const free = q.custom !== false ? q.options.length + 1 : -1
    const chosen = (n: number) => (n === free ? text?.trim() : q.options[n - 1]?.label)
    if (option === CONFIRM_OPTION) {
      if (!q.multiple) throw new Error('This question takes one answer')
      const picked = [...this.checked[this.index]].sort((a, b) => a - b).map((n) => q.options[n - 1].label)
      const typedText = this.typed[this.index]
      if (typedText) picked.push(typedText)
      if (!picked.length) throw new Error('Pick at least one answer')
      return this.advance(picked)
    }
    if (option !== free && !q.options[option - 1]) throw new Error('That choice is not in the question')
    if (option === free && !text?.trim()) throw new Error('Type an answer first')
    if (!q.multiple) return this.advance([chosen(option)!])
    if (option === free) this.typed[this.index] = this.typed[this.index] === text?.trim() ? undefined : text?.trim()
    else if (this.checked[this.index].has(option)) this.checked[this.index].delete(option)
    else this.checked[this.index].add(option)
    return false
  }

  private advance(answer: string[]) {
    this.answers[this.index] = answer
    this.index++
    return this.done
  }
}
