import { expect, test } from 'bun:test'
import { backgroundAfter } from './registry.ts'

const was = { pid: 7, background: '1 shell, 1 agent' }

test('what the footer says wins, and a bare footer clears it', () => {
  expect(backgroundAfter('2 agents', was, 7)).toBe('2 agents')
  expect(backgroundAfter(null, was, 7)).toBeUndefined()
})

test('a hidden footer (a picker or dialog over the box) keeps what it last said', () => {
  expect(backgroundAfter(undefined, was, 7)).toBe('1 shell, 1 agent')
  expect(backgroundAfter(undefined, { pid: 7 }, 7)).toBeUndefined()
})

test('another process in the pane starts clean', () => {
  expect(backgroundAfter(undefined, was, 8)).toBeUndefined()
  expect(backgroundAfter(undefined, undefined, 7)).toBeUndefined()
})
