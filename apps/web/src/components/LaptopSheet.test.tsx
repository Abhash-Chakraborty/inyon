import { afterEach, expect, test } from 'bun:test'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LaptopSheet, SETUP_COMMANDS } from './LaptopSheet.tsx'
import { renderSettled as render } from '../test/render.tsx'
import { useStore } from '../lib/store.ts'

/** The Android app's scanner, answering with whatever the user did on it. */
function phone(scanQr: () => Promise<unknown>, clipboard = '') {
  ;(window as any).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: { TetherDevice: { scanQr, readClipboardText: async () => ({ text: clipboard }) } },
  }
}

afterEach(() => {
  delete (window as any).Capacitor
  useStore.setState({ toasts: [] })
})

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

test('"Paste link instead" on the scanner fills in the copied link', async () => {
  const user = userEvent.setup()
  phone(async () => ({ paste: true }), ' tether://pair?m=abc \n')
  await render(<LaptopSheet open onClose={() => {}} />)
  await user.click(screen.getByRole('button', { name: /Scan the code/ }))
  expect((screen.getByPlaceholderText('tether://pair?m=…') as HTMLInputElement).value).toBe('tether://pair?m=abc')
  expect(useStore.getState().toasts).toEqual([])
})

test('no camera access points to the paste field instead', async () => {
  const user = userEvent.setup()
  phone(async () => ({ denied: true }))
  await render(<LaptopSheet open onClose={() => {}} />)
  await user.click(screen.getByRole('button', { name: /Scan the code/ }))
  expect(useStore.getState().toasts.map((t) => t.title)).toEqual(['No camera access'])
  expect(document.activeElement).toBe(screen.getByPlaceholderText('tether://pair?m=…'))
})

test('closing the scanner does nothing', async () => {
  const user = userEvent.setup()
  phone(async () => ({ cancelled: true }))
  await render(<LaptopSheet open onClose={() => {}} />)
  await user.click(screen.getByRole('button', { name: /Scan the code/ }))
  expect(useStore.getState().toasts).toEqual([])
})
