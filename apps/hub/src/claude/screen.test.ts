import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseScreen, unstyle } from './screen.ts'

// Real captures from Claude Code 2.1.296 at 100 columns.
const R = '─'.repeat(100)
const D = '╌'.repeat(100)
const screen = (s: string) => s.split('\n')

test('permission prompt', () => {
  const s = parseScreen(screen(`❯ Run the bash command: echo hello-tether > out.txt
  Writing hello-tether to out.txt
  ⎿  $ echo hello-tether > out.txt
${R}
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
 Write hello-tether to out.txt
${D}
 echo hello-tether > out.txt
${D}
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/claude-1001/-home-ubuntu-development-custom-tmux/7409eef9
      -d507-4808-a592-0bfabe896e3a/scratchpad/play from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No
 Esc to cancel · Tab to amend`))
  expect(s.working).toBe(false)
  const p = s.prompt!
  expect(p.options.map((o) => o.n)).toEqual([1, 2, 3, 4])
  expect(p.options[0]).toMatchObject({ label: 'Yes', selected: true })
  expect(p.options[1].label).toContain('-d507-4808')
  expect(p.body[0]).toBe('Bash command')
  expect(p.body).toContain('echo hello-tether > out.txt')
  expect(p.footer).toBe('Esc to cancel · Tab to amend')
  expect(p.multi).toBe(false)
})

test('ask user question, single select', () => {
  const s = parseScreen(screen(`❯ Yes ask them now. line one
  line two
${R}
←  ☐ Color  ☐ Fruits  ✔ Submit  →
What is your favorite color?
❯ 1. Red
     The color red
  2. Green
     The color green
  3. Blue
     The color blue
  4. Type something.
${R}
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel`))
  const p = s.prompt!
  expect(p.body).toEqual(['What is your favorite color?'])
  expect(p.options.map((o) => o.label)).toEqual(['Red', 'Green', 'Blue', 'Type something.', 'Chat about this'])
  expect(p.options[0].detail).toBe('The color red')
  expect(p.freeTextOption).toBe(4)
  expect(p.tabs?.map((t) => t.label)).toEqual(['Color', 'Fruits', 'Submit'])
  expect(p.tabs?.[0].current).toBe(true)
})

test('ask user question, multi select', () => {
  const s = parseScreen(screen(`${R}
←  ☒ Color  ☒ Fruits  ✔ Submit  →
Which fruits do you like?
❯ 1. [✔] Apple
         Apples
  2. [ ] Mango
         Mangoes
  3. [✔] Kiwi
         Kiwis
  4. [ ] Type something
     Submit
${R}
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel`))
  const p = s.prompt!
  expect(p.multi).toBe(true)
  expect(p.options.slice(0, 3).map((o) => [o.label, o.checked])).toEqual([['Apple', true], ['Mango', false], ['Kiwi', true]])
  expect(p.options[3].detail).toBeUndefined()
  expect(p.tabs?.[1].current).toBe(true)
})

test('idle with draft, mode and finished spinner', () => {
  const s = parseScreen(screen(`● I ran the command.
✻ Worked for 3s · done 2:57 AM
                                                                                  ● high · /effort
${R}
❯ half typed message
${R}
  🕷 VENOM  Opus 5.5 · high                                                                   play
  context ░░░░░░░░░░ 4%  36k / 1M               session $0.30 · 0m │ plan 5h 13% ↻07:10 · week 68%
  ⏸ manual mode on · ← 3 agents`))
  expect(s.prompt).toBeUndefined()
  expect(s.working).toBe(false)
  expect(s.draft).toBe('half typed message')
  expect(s.mode).toBe('manual')
})

test("a numbered list in the last reply isn't a question once the session has a name", () => {
  const screen = [
    '  Four things didn\'t survive the move:',
    '  1. Commit signing. On Windows, 1Password signed your commits; here, nothing is set up.',
    '  2. Convex login. The command-line tool isn\'t signed in here.',
    '  3. Packages. I can run pnpm install.',
    '  4. Bun is installed but not on your PATH.',
    '  Shall I go ahead with 1, 3 and 4?',
    '✻ Baked for 2m 3s · done 4:29 AM',
    '❯ /rename Abhash Website',
    '  ⎿  Session renamed to: Abhash Website',
    '──────────────────────────────────────────────────────────────────────── Abhash Website ─',
    '❯ ',
    '────────────────────────────────────────────────────────────────────────────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ]
  const s = parseScreen(screen, 88)
  expect(s.prompt).toBeUndefined()
  expect(s.inputVisible).toBe(true)
  expect(s.mode).toBe('auto')
  // and what you type there is still read as a draft
  expect(parseScreen(screen.map((l) => (l === '❯ ' ? '❯ 44' : l)), 88).draft).toBe('44')
})

test('working', () => {
  const s = parseScreen(screen(`     Do nothing else.
✽ Undulating… (2s · thinking with high effort)
  ⎿  Tip: Name your conversations with /rename to find them easily in /resume later
${R}
❯
${R}
  ⏵⏵ accept edits on`))
  expect(s.working).toBe(true)
  expect(s.activity).toBe('Undulating… (2s · thinking with high effort)')
  expect(s.mode).toBe('accept edits')
  expect(s.draft).toBeUndefined()
})

test('word-wrapped option label keeps its space', () => {
  const s = parseScreen(
    screen(`${'─'.repeat(80)}
 Bash command
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/claude-1001/scratchpad/play from this
      project
   3. No
 Esc to cancel · Tab to amend`),
    80,
  )
  expect(s.prompt!.options[1].label).toBe('Yes, and always allow access to /tmp/claude-1001/scratchpad/play from this project')
  expect(s.prompt!.options[1].detail).toBeUndefined()
})

test('menu without numbers (remote control)', () => {
  const s = parseScreen(
    screen(`❯ /remote-control
  /remote-control is active · Continue here
${'▔'.repeat(100)}
   Remote Control
   This session is available in the Claude mobile app and at https://claude.ai/code/session_x.
     Disconnect this session
     Show QR code   Scan with your phone to open this session
   ❯ Continue
   Enter to select · Esc to continue`),
    100,
  )
  const p = s.prompt!
  expect(p.navigate).toBe(true)
  expect(p.options.map((o) => o.label)).toEqual(['Disconnect this session', 'Show QR code', 'Continue'])
  expect(p.options[1].detail).toBe('Scan with your phone to open this session')
  expect(p.options[2].selected).toBe(true)
  expect(p.body[0]).toBe('Remote Control')
})

test('login url dialog with code input', () => {
  const url1 = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&resp'
  const url2 = 'onse_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3A'
  const url3 = 'create_api_key&state=UwbdOhIwrMI5ooVjgLIvz5ysBPXoVHjRtqWSBhTnQO4'
  const s = parseScreen(
    screen(`${'▔'.repeat(100)}
   Login
   Browser didn't open? Use the url below to sign in (c to copy)
${url1}
${url2}
${url3}
   Hold Shift (Option in iTerm2, Fn in Terminal.app) while selecting to use your terminal's
   native copy
   Paste code here if prompted >
   Esc to cancel`),
    100,
  )
  const p = s.prompt!
  expect(p.input?.label).toBe('Paste code here if prompted')
  expect(p.links).toEqual([url1 + url2 + url3])
  expect(p.body[0]).toBe('Login')
  expect(p.body.join(' ')).not.toContain('https://')
})

test('login method menu under a ▔ dialog top', () => {
  const s = parseScreen(
    screen(` ▝▝   ▝▝   /…/play2
${'▔'.repeat(80)} ● high · /effort ▔
   Login
   Select login method:
   ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise
     2. Anthropic Console account · API usage billing
     3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, Google Vertex AI
   Esc to cancel`),
    100,
  )
  expect(s.prompt!.body).toEqual(['Login', 'Select login method:'])
  expect(s.prompt!.options).toHaveLength(3)
})

describe('prompt suggestions (dimmed placeholder)', () => {
  const E = '\x1b'
  const rule = `${E}[37m${'─'.repeat(60)}${E}[39m`
  const box = (input: string) => [rule, input, rule, `  ${E}[91m⏵⏵ bypass permissions on${E}[39m`]

  test('a suggestion is not a draft', () => {
    // Claude: first char inverted as the cursor, the rest dimmed
    const s = parseScreen(box(`${E}[39m❯ ${E}[7mr${E}[27m${E}[2mun the tests and fix what fails${E}[22m`), 60)
    expect(s.draft).toBeUndefined()
    expect(s.mode).toBe('bypass permissions')
  })

  test('typed text is a draft, with the cursor at the end or inside it', () => {
    expect(parseScreen(box(`❯ fix the login bug${E}[7m ${E}[27m`), 60).draft).toBe('fix the login bug')
    expect(parseScreen(box(`❯ fix ${E}[7mt${E}[27mhe bug`), 60).draft).toBe('fix the bug')
    expect(parseScreen(box(`❯ ${E}[7mx${E}[27m`), 60).draft).toBe('x')
  })

  test('unstyle drops colours and links but keeps the text', () => {
    expect(unstyle(`${E}[38;2;100;100;100mgrey${E}[0m ${E}]8;;https://x.y${E}\\link${E}]8;;${E}\\`)).toEqual({ text: 'grey link', ghost: false })
  })
})

describe('other agents', () => {
  test('Codex folder trust menu (real capture, Codex 0.159, 156 columns)', () => {
    const cap = readFileSync(new URL('./fixtures/codex-trust.txt', import.meta.url), 'utf8').split('\n')
    const s = parseScreen(cap, 156, 'codex')
    const p = s.prompt!
    expect(p.options).toEqual([
      { n: 1, label: 'Trust and continue', selected: true, checked: undefined },
      { n: 2, label: 'Back to Agent Command Center', selected: false, checked: undefined },
    ])
    expect(p.navigate).toBe(true)
    expect(p.body[0]).toBe('Folder access')
    expect(p.body.some((l) => l.startsWith('Trust this folder?'))).toBe(true)
    expect(p.footer).toBe('enter continue · esc back')
  })

  const codex = (name: string) => parseScreen(readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8').split('\n'), 120, 'codex')

  test('Codex command approval (real capture, Codex 0.162)', () => {
    const s = codex('codex-approval')
    expect(s.working).toBe(false)
    const p = s.prompt!
    expect(p.options.map((o) => o.label)).toEqual([
      'Yes, proceed',
      "Yes, and don't ask again for commands that start with `curl -sI https://example.com`",
      'No, and tell Codex what to do differently',
    ])
    expect(p.navigate).toBe(true)
    expect(p.body).toContain('$ curl -sI https://example.com | head -1')
    expect(p.links).toBeUndefined()
  })

  test('Codex working with a queued message and a draft', () => {
    const s = codex('codex-queued')
    expect(s.working).toBe(true)
    expect(s.activity).toBe('Working')
    expect(s.queue).toEqual(['second message queued'])
    expect(s.draft).toBe('draft text here')
    expect(s.model).toBe('GPT-6-Luna')
    expect(s.effort).toBe('high')
  })

  test('the dimmed suggestion in an empty Codex composer is not a draft', () => {
    expect(codex('codex-working-empty').draft).toBeUndefined()
  })

  test('a Codex settings picker is a menu, not the composer (50 columns)', () => {
    const s = parseScreen(readFileSync(new URL('./fixtures/codex-effort-narrow.txt', import.meta.url), 'utf8').split('\n'), 50, 'codex')
    expect(s.model).toBeUndefined()
    expect(s.draft).toBeUndefined()
    expect(s.prompt?.body).toEqual(['Select Reasoning Level for GPT-6.1-Sol'])
    expect(s.prompt?.options.map((o) => o.label)).toEqual(['Low (default)', 'Medium', 'High', 'Extra high', 'More reasoning…'])
    expect(s.prompt?.options[0].current).toBe(true)
  })

  test('Codex idle with a background terminal', () => {
    const s = codex('codex-bg-idle')
    expect(s.working).toBe(false)
    expect(s.background).toBe('1 background terminal')
  })

  test('a numbered list in a reply is not a prompt', () => {
    const s = parseScreen(screen(`• Two ways to do it:
  1. Patch the parser
  2. Rewrite it

› Ask Codex to do anything`), 80, 'codex')
    expect(s.prompt).toBeUndefined()
  })
})

describe('Antigravity CLI (real captures, agy 1.3.3 at 150 columns)', () => {
  const cap = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8').split('\n')
  const agy = (lines: string[]) => parseScreen(lines, 150, 'antigravity')

  test('idle', () => {
    expect(agy(cap('agy-idle'))).toEqual({ working: false, width: 150, model: 'Gemini 3.8 Flash', effort: 'high', mode: 'default', inputVisible: true })
  })

  test('working: the spinner above the box, not the footer', () => {
    const s = agy(cap('agy-working'))
    expect(s.working).toBe(true)
    expect(s.activity).toBe('Generating')
    expect(s.prompt).toBeUndefined()
    expect(s.draft).toBeUndefined()
  })

  test('a typed draft', () => {
    expect(agy(cap('agy-draft')).draft).toBe('fix the bug in main.go please')
  })

  test('model and effort from the footer', () => {
    const s = agy(cap('agy-approval'))
    expect([s.model, s.effort]).toEqual(['Gemini 3.8 Flash', 'high'])
    expect(agy(cap('agy-plan')).model).toBe('Gemini 3.8 Flash')
  })

  test('mode from the footer', () => {
    expect(agy(cap('agy-accept-edits')).mode).toBe('accept-edits')
    expect(agy(cap('agy-plan')).mode).toBe('plan')
    // the grey "Plan mode: … (shift+tab to cycle)" hint in the empty box is not a draft
    expect(agy(cap('agy-accept-edits')).draft).toBeUndefined()
    expect(agy(cap('agy-plan')).draft).toBeUndefined()
    expect(agy(cap('agy-idle')).mode).toBe('default')
  })

  test('the slash picker under the box is not a prompt', () => {
    const s = agy(cap('agy-slash'))
    expect(s.prompt).toBeUndefined()
    expect(s.working).toBe(false)
    expect(s.draft).toBe('/')
  })

  test('command approval', () => {
    const p = agy(cap('agy-approval')).prompt!
    expect(p.options.map((o) => [o.n, o.selected])).toEqual([[1, true], [2, false], [3, false], [4, false]])
    expect(p.options[0].label).toBe('Yes, run command')
    expect(p.options[3].label).toBe('No, cancel')
    expect(p.navigate).toBe(true)
    expect(p.body).toEqual(['Run this command?', '╌', 'date +%Y', '╌'])
  })

  test('approval whose long options wrap to column 0 in a narrow pane', () => {
    const p = parseScreen(cap('agy-approval-wrapped'), 115, 'antigravity').prompt!
    expect(p.options.map((o) => o.n)).toEqual([1, 2, 3, 4])
    expect(p.options[2].label).toContain("-maxdepth 3 -not -path '*/.*' -not -path")
    expect(p.options[2].label).toEndWith('(Persist to settings.json)')
    expect(p.body[2]).toStartWith('find apps packages deploy')
  })

  test('folder trust', () => {
    const p = agy(cap('agy-trust')).prompt!
    expect(p.options).toEqual([
      { n: 1, label: 'Yes, I trust this folder', selected: true },
      { n: 2, label: 'No, exit', selected: false },
    ])
    expect(p.navigate).toBe(true)
    expect(p.body).toContain('Do you trust the contents of this project?')
  })

  test('queued messages while working', () => {
    const s = agy(cap('agy-queued'))
    expect(s.working).toBe(true)
    expect(s.activity).toBe('Generating')
    expect(s.queue).toEqual(['Then say done.'])
  })

  test('wrapped queued message under a background task', () => {
    const s = agy(cap('agy-queued-task'))
    expect(s.working).toBe(true)
    expect(s.activity).toBe('Running command')
    expect(s.queue).toEqual(['Then say done, and list every file in this folder with its size, newest first, so I can see what changed.'])
    expect(s.model).toBe('Gemini 3.8 Flash')
    expect(s.effort).toBe('medium')
    expect(s.background).toBe('1 background task')
  })

  test('a folded thought is not a queued message', () => {
    const s = agy(cap('agy-folded-thought'))
    expect(s.working).toBe(false)
    expect(s.queue).toBeUndefined()
  })

  test('rewind picker: one option per message, its age as detail', () => {
    const p = agy(cap('agy-rewind')).prompt!
    expect(p.body).toEqual(['Rewind Conversation'])
    expect(p.navigate).toBe(true)
    expect(p.options[0]).toEqual({ n: 1, label: 'Then say done.', detail: '19m ago', selected: false })
    expect(p.options.at(-1)).toMatchObject({ label: '(current)', selected: true })
    expect(p.options.some((o) => /items\]/.test(o.label))).toBe(false)
  })

  test('model picker: models only, without the search field or the effort slider', () => {
    const p = agy(cap('agy-model-menu')).prompt!
    expect(p.body).toEqual(['Switch Model'])
    expect(p.options[0]).toEqual({ n: 1, label: 'Gemini 3.8 Flash', detail: 'current', selected: true })
    expect(p.options.map((o) => o.label)).not.toContain('Search:')
    expect(p.options.some((o) => /Effort/.test(o.label))).toBe(false)
    expect(p.options).toHaveLength(7)
  })

  test('resume picker: table rows, not the heading or the search line', () => {
    const p = agy(cap('agy-resume')).prompt!
    expect(p.body).toEqual(['Conversations'])
    expect(p.options[0]).toEqual({ n: 1, label: '[CURRENT] Tether QA run', detail: '27 steps · 8m ago', selected: true })
    expect(p.options[1]).toMatchObject({ label: 'Simple Greeting', detail: 'custom-tmux · 47 steps · 23m ago' })
    expect(p.options).toHaveLength(5)
  })

  test('remote control link, rejoined where the pane wrapped it, and off again', () => {
    const on = `> /remote-control
  ⎿  Remote control on for this session.
     Hostname: box-blazing-void
     Open https://antigravity.google.com/r/77637f21-f314-468d-9258-23b644a606f9-v2?p=c%2F5a
9bbba1 on another device to
     continue this conversation.
${'─'.repeat(60)}
>
${'─'.repeat(60)}
? for shortcuts            Gemini 3.8 Flash · high`
    expect(parseScreen(screen(on), 60, 'antigravity').remote).toBe('https://antigravity.google.com/r/77637f21-f314-468d-9258-23b644a606f9-v2?p=c%2F5a9bbba1')
    const off = on.replace('? for shortcuts', '> /remote-control off\n  ⎿  Remote control off. This machine is no longer reachable.\n? for shortcuts')
    expect(parseScreen(screen(off), 60, 'antigravity').remote).toBeNull()
    expect(agy(cap('agy-idle')).remote).toBeUndefined()
  })

  test('approval options wrapped at a narrow width', () => {
    const p = parseScreen(screen(`Requesting permission for:
   rm -rf build

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for
     commands that start with 'rm'
  3. No, cancel

  ↑/↓ Navigate · tab Amend`), 60, 'antigravity').prompt!
    expect(p.options.map((o) => o.label)).toEqual(['Yes, run command', "Yes, and always allow in this conversation for commands that start with 'rm'", 'No, cancel'])
  })
})

// Active status rows may be separated from the composer by tips and live tool output.
// Quiet commands still have these rows; lack of new output is not completion.
describe('quiet foreground work', () => {
  test('Codex spinner above delegation tip remains working', () => {
    const lines = screen(`• Working (2m 06s • esc to interrupt)
  └ Tip: Use /subagents to switch between this session’s subagents.

› Ask Codex to do anything

  GPT-6.1-Sol default · ~/project
  ← for agents · ? for shortcuts`)
    expect(parseScreen(lines, 100, 'codex')).toMatchObject({ working: true, activity: 'Working' })
    lines.splice(0, 2, '• done', '  Worked for 2m 07s')
    expect(parseScreen(lines, 100, 'codex').working).toBe(false)
  })

  test('Claude spinner survives long wrapped tool hints', () => {
    const lines = screen(`✢ Perambulating… (1m · ↓ 100 tokens)
${Array(12).fill('  ⎿  Tip: command is still running').join('\n')}
${R}
❯
${R}
  ⏵⏵ bypass permissions on · 1 shell`)
    expect(parseScreen(lines).working).toBe(true)
    lines[0] = '● Command finished'
    expect(parseScreen(lines)).toMatchObject({ working: false, background: '1 shell' })
  })

  test('Antigravity spinner survives live command output', () => {
    const lines = screen(`⣽ Running command...
  ⎿  waiting for sleep to finish
${Array(20).fill('    quiet command output').join('\n')}
${R}
>
${R}
? for shortcuts            Gemini 3.8 Flash · high`)
    expect(parseScreen(lines, 100, 'antigravity')).toMatchObject({ working: true, activity: 'Running command' })
    lines[0] = 'Command finished'
    expect(parseScreen(lines, 100, 'antigravity').working).toBe(false)
  })

  test('Codex does not reuse a prior turn spinner', () => {
    expect(parseScreen(screen(`• Working (1s • esc to interrupt)
• done

›

  GPT-6.1-Sol default · ~/project
  ← for agents · ? for shortcuts`), 100, 'codex').working).toBe(false)
  })
})

test('Codex reads a composer longer than fourteen terminal rows', () => {
  const rows = ['› long draft', ...Array(20).fill('  continued text'), '', '  GPT-6-Luna default · /tmp/project']
  const s = parseScreen(rows, 100, 'codex')
  expect(s.inputVisible).toBe(true)
  expect(s.draft).toContain('long draft')
  expect(s.draft?.match(/continued text/g)).toHaveLength(20)
})

test('Codex shell composer keeps the exclamation command prefix', () => {
  const s = parseScreen(['! printf hello', '', '  GPT-6-Luna default · /tmp/project', '  Shell mode'], 100, 'codex')
  expect(s.inputVisible).toBe(true)
  expect(s.draft).toBe('! printf hello')
})

test("Codex's question to trust new hooks is buttons, without its banner", () => {
  const s = parseScreen([
    '  >_ OpenAI Codex (v0.162.1)', '     ~/development/custom-tmux', '',
    '  Hooks need review', '  2 hooks are new or changed.', '  Hooks can run outside the sandbox after you trust them.', '',
    '› 1. Review hooks', '  2. Trust all and continue', "  3. Continue without trusting (hooks won't run)", '',
    '  enter confirm · esc skip',
  ], 120, 'codex')
  expect(s.prompt?.body).toEqual(['Hooks need review', '2 hooks are new or changed.', 'Hooks can run outside the sandbox after you trust them.'])
  expect(s.prompt?.options.map((o) => o.label)).toEqual(['Review hooks', 'Trust all and continue', "Continue without trusting (hooks won't run)"])
})
