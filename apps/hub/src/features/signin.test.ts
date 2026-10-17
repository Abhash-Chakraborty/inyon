import { parseOpenCodeAuthMenu, parseOpenCodeAuthInput, signInWindows, startSignIn, stopSignIn } from './signin.ts'
import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { parseSignIn } from './signin.ts'
import { registry } from '../hosts/registry.ts'
import { LOGIN_PREFIX } from '../tmux/tmux.ts'

// bun keeps a spy in place for every test file after this one
afterAll(() => mock.restore())

test('OpenCode API key prompt exposes a secret input without a login URL', () => {
  expect(parseOpenCodeAuthInput(['◇ Login method', '│ Manually enter API Key', '◆ Enter your API key', '│ _'])).toEqual({ label: 'Enter your API key', secret: true })
  expect(parseOpenCodeAuthInput(['◆ Login method'])).toBeUndefined()
  expect(parseOpenCodeAuthInput(['◇ Enter your API key', '│ Done'])).toBeUndefined()
})

test('device code sign-in screen', () => {
  const s = parseSignIn(`
Welcome to Codex

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   K7QD-9XWPM

`)
  expect(s.links).toEqual(['https://auth.openai.com/codex/device'])
  expect(s.code).toBe('K7QD-9XWPM')
  expect(s.exit).toBeUndefined()
  expect(s.lines[0]).toBe('Welcome to Codex')
})

test('finished sign-in, with a long link joined by capture -J', () => {
  const s = parseSignIn(`Browser didn't open? Use the url below to sign in (c to copy)

https://claude.ai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=XYZ.

Paste code here if prompted >
Login successful.

[inyon-exit 0]
`)
  expect(s.links).toEqual(['https://claude.ai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=XYZ'])
  expect(s.code).toBeUndefined()
  expect(s.exit).toBe(0)
  expect(s.lines.at(-1)).toBe('Login successful.')
})

test('agy draws its sign-in link across lines of its own; they are joined back', () => {
  const s = parseSignIn(` Open the URL below in your browser:
 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=12345.apps.googleusercontent.com&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopq
 rstuvwxyz&code_challenge_method=S256&state=abc
 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 After authenticating, copy the code displayed in the browser and paste it below:
 authorization code...`)
  expect(s.links).toEqual(['https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=12345.apps.googleusercontent.com&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz&code_challenge_method=S256&state=abc'])
})


test('OpenCode Clack provider radio list supports navigation and ignores search/footer rows', () => {
  const menu = parseOpenCodeAuthMenu(['┌ Add credential', '◆ Select provider', '│ Search: _', '│ ● OpenCode Zen (recommended)', '│ ○ OpenAI', '│ ○ GitHub Copilot', '│ ...', '│ ↑/↓ to select • Enter: confirm • Type: to search'])
  expect(menu?.navigate).toBe(true)
  expect(menu?.options).toEqual([{ n: 1, label: 'OpenCode Zen (recommended)', selected: true }, { n: 2, label: 'OpenAI', selected: false }, { n: 3, label: 'GitHub Copilot', selected: false }])
  expect(menu?.body).toEqual(['Select provider'])
})
test('OpenCode next login-method prompt replaces the completed provider choice', () => {
  const menu = parseOpenCodeAuthMenu(['◇ Select provider', '│ OpenAI', '◆ Login method', '│ ○ ChatGPT Pro/Plus (browser)', '│ ● ChatGPT Pro/Plus (headless)', '│ ○ Manually enter API Key'])
  expect(menu?.body).toEqual(['Login method'])
  expect(menu?.options.find((o) => o.selected)?.n).toBe(2)
  expect(parseOpenCodeAuthMenu(['◇ Login method', '│ API Key', '◆ Enter API Key', '│ _'])).toBeUndefined()
  expect(parseOpenCodeAuthMenu(['◇ Finished', '│ ○ Earlier option'])).toBeUndefined()
})

test('connecting a provider runs OpenCode\'s own login for that provider, and its "Error:" counts as a failure even at exit 0', async () => {
  const ran: string[] = []
  const host = { exec: async (cmd: string) => { ran.push(cmd); return { code: 0, stdout: '%9\n', stderr: '' } } }
  spyOn(registry, 'host').mockReturnValue(host as any)
  spyOn(registry, 'get').mockReturnValue({ state: { os: 'Linux' } } as any)
  expect(await startSignIn('h', 'opencode', { provider: 'anthropic' })).toEqual({ pane: '%9' })
  // quoted once for sh -c and once for tmux, so the provider id sits between escaped quotes
  expect(ran[0]).toMatch(/opencode auth login -p \S*anthropic\S*; s=\$\?/)
  expect(ran[0]).toContain('inyon-login-opencode-')
  await expect(startSignIn('h', 'opencode', { provider: 'bad id' })).rejects.toThrow('Unknown provider')
  expect(signInWindows('opencode', 'groq')).toStartWith("opencode auth login -p 'groq'; ")
  expect(signInWindows('opencode')).toStartWith('opencode auth login; ')
  const failed = parseSignIn('┌  Add credential\nError: Unknown provider "nope"\n\n[inyon-exit 0]\n')
  expect(failed.exit).toBe(1)
  expect(failed.error).toBe('Unknown provider "nope"')
  const done = parseSignIn('┌  Add credential\n│\n◇  Enter your API key\n│  ▪▪▪▪\n│\n└  Done\n\n[inyon-exit 0]\n')
  expect(done.exit).toBe(0)
  expect(done.error).toBeUndefined()
})

test('stopping a sign-in ends that session by its exact name, even if its pane has just gone', async () => {
  const name = `${LOGIN_PREFIX}claude-k7q4`
  const ran: string[] = []
  const host = {
    exec: async (cmd: string) => {
      ran.push(cmd)
      // the pane is there for the ownership check, and gone by the time anything asks again
      const first = ran.filter((c) => c.includes('display')).length === 1
      return { code: 0, stdout: cmd.includes('display') && first ? `${name}\n` : '', stderr: '' }
    },
  }
  spyOn(registry, 'host').mockReturnValue(host as any)
  spyOn(registry, 'refresh').mockImplementation(() => {})
  await stopSignIn('h', '%7')
  const kill = ran.find((c) => c.includes('kill-session'))!
  expect(kill).toContain(`'=${name}'`)
  // never an empty target, which tmux reads as the most recent session
  expect(kill).not.toContain('$(')
})
