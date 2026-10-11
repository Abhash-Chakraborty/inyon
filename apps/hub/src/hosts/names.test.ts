import { expect, test } from 'bun:test'
import { bareTitle, nameTaken, pendingName, sessionName, setSessionName } from './names.ts'

test("a rename waits for the agent, then the agent's own title is the name everywhere", () => {
  setSessionName('h', 's1', 'Abhash Website', 'Portfolio setup', 'claude')
  // until Claude has it, Tether shows the new name
  expect(sessionName('h', 's1', 'claude')).toBe('Abhash Website')
  expect(pendingName('h', 's1')?.name).toBe('Abhash Website')
  // Claude took it: its title shows from here on, so a rename from the phone or the keyboard wins too
  nameTaken('h', 's1')
  expect(sessionName('h', 's1', 'claude')).toBeUndefined()
  expect(pendingName('h', 's1')).toBeUndefined()
})

test('the automatic name puts back the title the agent made up, then forgets it', () => {
  setSessionName('h', 's2', 'Mine', 'Fix the parser', 'codex')
  nameTaken('h', 's2')
  setSessionName('h', 's2', '', undefined, 'codex')
  expect(pendingName('h', 's2')?.name).toBe('Fix the parser')
  nameTaken('h', 's2')
  expect(pendingName('h', 's2')).toBeUndefined()
  expect(sessionName('h', 's2', 'codex')).toBeUndefined()
})

test('agents without a title of their own keep the name in Tether', () => {
  setSessionName('h', 's3', 'Notes', undefined, 'gemini')
  expect(sessionName('h', 's3', 'gemini')).toBe('Notes')
  expect(pendingName('h', 's3')).toBeUndefined()
})

test("Claude's activity mark isn't part of the title", () => {
  expect(bareTitle('✳ Abhash Website')).toBe('Abhash Website')
  expect(bareTitle('⠂ Abhash Website')).toBe('Abhash Website')
  expect(bareTitle('Respond to greeting')).toBe('Respond to greeting')
  expect(bareTitle('"Quoted" name')).toBe('"Quoted" name')
})
