import { expect, test } from 'bun:test'
import { useState } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Select } from './Select.tsx'
import { renderSettled as render } from '../../test/render.tsx'

const OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
]

function Pick({ onEscapeOutside }: { onEscapeOutside?: () => void }) {
  const [v, setV] = useState('')
  return (
    <div onKeyDown={(e) => e.key === 'Escape' && onEscapeOutside?.()}>
      <Select title="Model" value={v} onChange={setV} options={OPTIONS} />
      <output>{v || 'none'}</output>
    </div>
  )
}

test('draws its own list instead of the system picker, and picks with a tap', async () => {
  const user = userEvent.setup()
  await render(<Pick />)
  expect(document.querySelector('select')).toBeNull()
  await user.click(screen.getByRole('combobox', { name: 'Model' }))
  expect(screen.getByRole('listbox')).toBeTruthy()
  await user.click(screen.getByRole('option', { name: 'Opus' }))
  // the phone sheet slides away before it reports the choice
  await new Promise((r) => setTimeout(r, 250))
  expect(screen.getByText('opus')).toBeTruthy()
  expect(screen.queryByRole('listbox')).toBeNull()
})

test('works from the keyboard: arrows move, Enter picks, Escape closes only the list', async () => {
  const user = userEvent.setup()
  let outside = 0
  window.addEventListener('keydown', (e) => e.key === 'Escape' && outside++)
  await render(<Pick />)
  const box = screen.getByRole('combobox', { name: 'Model' })
  box.focus()
  await user.keyboard('{ArrowDown}')
  expect(screen.getByRole('listbox')).toBeTruthy()
  await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
  expect(screen.getByText('haiku')).toBeTruthy()
  await user.keyboard('{ArrowDown}')
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('listbox')).toBeNull()
  // a sheet underneath listens for Escape on window too; it must not close with the list
  expect(outside).toBe(0)
})
