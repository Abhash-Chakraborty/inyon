import { expect, test } from 'bun:test'
import { fireEvent, screen } from '@testing-library/react'
import { promptKey, type ScreenPrompt } from '@inyon/protocol'
import { PromptCard } from './PromptCard.tsx'
import { api } from '../../test/fakes.ts'
import { renderSettled as render } from '../../test/render.tsx'

test('an answer says which question it was for, so a late tap never lands on the next one', async () => {
  const prompt: ScreenPrompt = {
    body: ['Do you want to make this edit to auth.ts?'],
    options: [
      { n: 1, label: 'Yes', selected: true },
      { n: 2, label: "Yes, and don't ask again", selected: false },
      { n: 3, label: 'No', selected: false },
    ],
    multi: false,
  }
  await render(<PromptCard prompt={prompt} host="box" pane="%3" />)
  fireEvent.click(screen.getByRole('button', { name: /^1\s*Yes$/ }))
  expect(api.answer.mock.calls.at(-1)).toEqual(['box', '%3', 1, undefined, promptKey(prompt)])
})
