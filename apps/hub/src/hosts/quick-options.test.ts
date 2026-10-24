import { expect, test } from 'bun:test'
import { screenFixture } from '../fixtures.ts'
import { parseScreen } from '../claude/screen.ts'
import { quickOptions } from './registry.ts'

// Quick answers only for a question the overview's one line holds whole: never a heredoc you can't
// see, which a notification's Yes would approve.
test('quick answers come only with a whole question', () => {
  const claude = (name: string) => parseScreen(screenFixture('claude', name), 100, 'claude').prompt!
  expect(quickOptions(claude('powershell-prompt'))).toEqual([{ n: 1, label: 'Yes' }, { n: 2, label: "Yes, and don't ask again for: npm test *" }, { n: 3, label: 'No' }])
  expect(quickOptions(claude('bash-gutter'))).toBeUndefined()
})
