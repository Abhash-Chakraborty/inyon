import { expect, test } from 'bun:test'
import { render } from '@testing-library/react'
import { AGENTS } from '@inyon/protocol'
import { AgentSpinner, backgroundText } from './status.tsx'

test('the spinner steps through its frames in CSS, so it never re-renders to animate', () => {
  const { container, rerender } = render(<AgentSpinner kind="claude" active />)
  const strip = container.querySelector('span > span') as HTMLElement
  expect(strip.children).toHaveLength(AGENTS.claude.spinner.length)
  expect(strip.style.animation).toContain(`steps(${AGENTS.claude.spinner.length})`)
  rerender(<AgentSpinner kind="claude" />)
  expect((container.querySelector('span > span') as HTMLElement).style.animation).toBe('')
})

test('background work reads as a sentence, alone or as a list', () => {
  expect(backgroundText('1 shell')).toBe('1 shell running in the background')
  expect(backgroundText('1 background task')).toBe('1 task running in the background')
  expect(backgroundText('2 agents')).toBe('2 agents running in the background')
  expect(backgroundText('1 shell, 1 agent')).toBe('1 shell and 1 agent running in the background')
  expect(backgroundText('1 shell, 2 monitors, 1 agent')).toBe('1 shell, 2 monitors and 1 agent running in the background')
})
