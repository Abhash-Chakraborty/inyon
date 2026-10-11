import { expect, test } from 'bun:test'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LaptopSheet, SETUP_COMMANDS } from './LaptopSheet.tsx'
import { renderSettled as render } from '../test/render.tsx'

test('says how to get the helper onto a laptop or server, for Mac/Linux and for Windows', async () => {
  const user = userEvent.setup()
  await render(<LaptopSheet open onClose={() => {}} />)
  expect(screen.getByText(SETUP_COMMANDS.unix.command)).toBeTruthy()
  expect(screen.getByText(/on a server, your SSH session/)).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Add a computer' })).toBeTruthy()
  await user.click(screen.getByRole('tab', { name: 'Windows' }))
  expect(screen.getByText(SETUP_COMMANDS.windows.command)).toBeTruthy()
  expect(screen.getByText(/In PowerShell, run/)).toBeTruthy()
  expect(SETUP_COMMANDS.unix.command).toMatch(/^curl -fsSL https:\/\/github\.com\/.+\/releases\/latest\/download\/get\.sh \| sh$/)
  expect(SETUP_COMMANDS.windows.command).toMatch(/^irm https:\/\/github\.com\/.+\/releases\/latest\/download\/get\.ps1 \| iex$/)
})
