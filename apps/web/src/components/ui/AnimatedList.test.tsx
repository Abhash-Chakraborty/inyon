import { expect, test } from 'bun:test'
import { act, render } from '@testing-library/react'
import { AnimatedList, LEAVE_MS } from './AnimatedList.tsx'

const items = (...keys: string[]) => keys.map((key) => ({ key, node: <span>{key}</span> }))
const sleep = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))

test('a new item arrives rising; one that was there does not', () => {
  const { container, rerender } = render(<AnimatedList items={items('a')} />)
  expect(container.querySelector('[data-key="a"]')!.className).toContain('animate-slide-up')
  rerender(<AnimatedList items={items('a', 'b')} />)
  expect(container.querySelector('[data-key="a"]')!.className).not.toContain('animate-slide-up')
  expect(container.querySelector('[data-key="b"]')!.className).toContain('animate-slide-up')
})

test('an item that goes fades first, then leaves', async () => {
  const { container, rerender } = render(<AnimatedList items={items('a', 'b')} />)
  rerender(<AnimatedList items={items('b')} />)
  const a = container.querySelector('[data-key="a"]')!
  expect(a.className).toContain('leave')
  expect(a.textContent).toBe('a')
  await sleep(LEAVE_MS + 20)
  expect(container.querySelector('[data-key="a"]')).toBeNull()
  expect(container.querySelector('[data-key="b"]')).not.toBeNull()
})

test('an item that comes straight back is not shown twice', async () => {
  const { container, rerender } = render(<AnimatedList items={items('a', 'b')} />)
  rerender(<AnimatedList items={items('b')} />)
  rerender(<AnimatedList items={items('a', 'b')} />)
  expect(container.querySelectorAll('[data-key="a"]')).toHaveLength(1)
  expect(container.querySelector('[data-key="a"]')!.className).not.toContain('leave')
  await sleep(LEAVE_MS + 20)
  expect(container.querySelectorAll('[data-key="a"]')).toHaveLength(1)
})
