import { afterEach, expect, test } from 'bun:test'
import { useRef } from 'react'
import { act, fireEvent, screen } from '@testing-library/react'
import { CHAT_MIN, PANEL_MIN, clampPanel, panelBox, usePanelResize } from './PanelResize.tsx'
import { useStore } from '../../lib/store.ts'
import { renderSettled as render } from '../../test/render.tsx'

afterEach(() => act(() => useStore.getState().setSettings({ panelWidth: 0 })))

test('a width stays between the panel’s least and what the chat can give up', () => {
  expect(clampPanel(500, 1200)).toBe(500)
  expect(clampPanel(100, 1200)).toBe(PANEL_MIN)
  expect(clampPanel(5000, 1200)).toBe(1200 - CHAT_MIN)
  // a row too narrow for both: the panel keeps its least
  expect(clampPanel(600, 500)).toBe(PANEL_MIN)
  expect(clampPanel(412.6, 1200)).toBe(413)
})

test('the panel comes at its usual width until it has been dragged', () => {
  expect(panelBox(0)).toEqual({ className: 'w-[420px] 2xl:w-[480px]' })
  const box = panelBox(560)
  expect(box.className).toBe('')
  expect(box.style).toEqual({ width: 560, minWidth: PANEL_MIN, maxWidth: `calc(100% - ${CHAT_MIN}px)` })
})

function Panel() {
  const ref = useRef<HTMLElement>(null)
  const { width, Handle } = usePanelResize(ref)
  return (
    <div style={{ width: 1200 }}>
      <aside ref={ref} data-width={width}>
        {Handle}
      </aside>
    </div>
  )
}

test('the handle resizes with the arrow keys, and Home or a double click puts the usual width back', async () => {
  await render(<Panel />)
  const handle = screen.getByRole('separator', { name: 'Resize the side panel' })
  expect(handle.getAttribute('aria-orientation')).toBe('vertical')
  // left makes the panel wider (the handle is its left edge); never under its least
  fireEvent.keyDown(handle, { key: 'ArrowLeft' })
  const wider = useStore.getState().settings.panelWidth
  expect(wider).toBeGreaterThanOrEqual(PANEL_MIN)
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(useStore.getState().settings.panelWidth).toBeGreaterThanOrEqual(PANEL_MIN)
  expect(useStore.getState().settings.panelWidth).toBeLessThanOrEqual(wider)
  fireEvent.keyDown(handle, { key: 'Home' })
  expect(useStore.getState().settings.panelWidth).toBe(0)
  act(() => useStore.getState().setSettings({ panelWidth: 600 }))
  fireEvent.doubleClick(handle)
  expect(useStore.getState().settings.panelWidth).toBe(0)
})

test('a drag follows the pointer, shields the page under it, and keeps the width when it ends', async () => {
  const { container } = await render(<Panel />)
  const handle = screen.getByRole('separator')
  const aside = container.querySelector('aside')!
  // the panel's right edge at 1200, in a row 1200 wide
  aside.getBoundingClientRect = () => ({ left: 780, right: 1200, top: 0, bottom: 800, width: 420, height: 800, x: 780, y: 0, toJSON: () => ({}) })
  Object.defineProperty(aside.parentElement!, 'clientWidth', { value: 1200, configurable: true })
  handle.setPointerCapture = () => {}
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 780 })
  // over everything while it's dragged, so a blueprint's frame can't take the pointer
  expect(document.body.querySelector('.fixed.inset-0.cursor-col-resize')).not.toBeNull()
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600 })
  expect(aside.getAttribute('data-width')).toBe('600')
  // nothing is saved until the drag ends
  expect(useStore.getState().settings.panelWidth).toBe(0)
  // dragged far left: the chat keeps its least
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20 })
  expect(aside.getAttribute('data-width')).toBe(String(1200 - CHAT_MIN))
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 640 })
  fireEvent.pointerUp(handle, { pointerId: 1 })
  expect(useStore.getState().settings.panelWidth).toBe(560)
  expect(document.body.querySelector('.fixed.inset-0.cursor-col-resize')).toBeNull()
})
