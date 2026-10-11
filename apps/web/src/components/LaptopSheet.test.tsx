import { expect, spyOn, test } from 'bun:test'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LaptopSheet, SETUP_COMMANDS } from './LaptopSheet.tsx'
import { renderSettled as render } from '../test/render.tsx'
import { api } from '../lib/api.ts'

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

test('typing the ID and code pairs as soon as the last digit is in', async () => {
  const user = userEvent.setup()
  const pairLaptop = spyOn(api, 'pairLaptop').mockResolvedValue({ id: 'box' } as any)
  let closed = false
  await render(<LaptopSheet open onClose={() => (closed = true)} />)
  // copied off a terminal: lower case, an O for a zero
  await user.type(screen.getByRole('textbox', { name: 'ID' }), 'k7q4mxot')
  expect((screen.getByRole('textbox', { name: 'ID' }) as HTMLInputElement).value).toBe('K7Q4-MX0T')
  // the code box takes over once the ID is complete
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Code' }))
  await user.keyboard('493 81')
  expect(pairLaptop).not.toHaveBeenCalled()
  await user.keyboard('2')
  expect(pairLaptop).toHaveBeenCalledWith('K7Q4MX0T 493812')
  await new Promise((r) => setTimeout(r, 0))
  expect(closed).toBe(true)
  pairLaptop.mockRestore()
})

test('an ID and code pasted together fill both boxes', async () => {
  const user = userEvent.setup()
  const pairLaptop = spyOn(api, 'pairLaptop').mockResolvedValue({ id: 'box' } as any)
  await render(<LaptopSheet open onClose={() => {}} />)
  await user.click(screen.getByRole('textbox', { name: 'ID' }))
  await user.paste('K7Q4-MX2T  493 812')
  expect(pairLaptop).toHaveBeenCalledWith('K7Q4MX2T 493812')
  pairLaptop.mockRestore()
})
