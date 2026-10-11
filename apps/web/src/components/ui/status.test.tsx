import { expect, test } from 'bun:test'
import { render } from '@testing-library/react'
import { AGENTS } from '@tether/protocol'
import { AgentSpinner } from './status.tsx'

test('the spinner steps through its frames in CSS, so it never re-renders to animate', () => {
  const { container, rerender } = render(<AgentSpinner kind="claude" active />)
  const strip = container.querySelector('span > span') as HTMLElement
  expect(strip.children).toHaveLength(AGENTS.claude.spinner.length)
  expect(strip.style.animation).toContain(`steps(${AGENTS.claude.spinner.length})`)
  rerender(<AgentSpinner kind="claude" />)
  expect((container.querySelector('span > span') as HTMLElement).style.animation).toBe('')
})
