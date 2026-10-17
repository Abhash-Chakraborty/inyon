import { expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { PendingBubble, QueuedBubble, UserMessage, uploadName, WorkingIndicator } from './Messages.tsx'
import { buildRows } from '../../lib/chat.ts'
import { item } from '../../test/fixtures.ts'

test("an upload's chip shows the name it was picked with", () => {
  expect(uploadName('/home/me/.inyon/uploads/2026-10-13/d09c14d4-62c/184807-76855d-inyon-test.txt')).toBe('inyon-test.txt')
  // uploads from before the id was added
  expect(uploadName('/home/me/.inyon/uploads/2026-01-02/x/101010-photo.jpg')).toBe('photo.jpg')
  // a name that only looks like the prefix keeps the rest
  expect(uploadName('/home/me/.inyon/uploads/2026-10-13/x/184807-76855d-123456-notes.md')).toBe('123456-notes.md')
})

test('a message keeps its box when it goes from sent, or queued, to confirmed', () => {
  const padding = (el: Element) => el.className.split(' ').filter((c) => /^p[xy]-/.test(c)).sort()
  const [row] = buildRows([item.user('run the tests')])
  if (row.type !== 'user') throw new Error('not a user row')
  const confirmed = render(<UserMessage row={row} />)
  const expected = padding(screen.getByText('run the tests').closest('.bg-bubble')!)
  confirmed.unmount()
  render(<PendingBubble p={{ id: 'p1', text: 'run the tests', status: 'sent', at: 0 }} onRetry={() => {}} onDismiss={() => {}} />)
  expect(padding(screen.getByText('run the tests').closest('.bg-bubble')!)).toEqual(expected)
  render(<QueuedBubble text="then lint" agent="claude" />)
  expect(padding(screen.getByText('then lint').closest('.border-dashed')!)).toEqual(expected)
})

test('the working line fades in', () => {
  const { container } = render(<WorkingIndicator activity="Pondering…" />)
  expect(container.firstElementChild!.className).toContain('animate-fade-in')
})
