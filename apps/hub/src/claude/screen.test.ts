import { describe, expect, test } from 'bun:test'
import { fixture, screenFixture } from '../fixtures.ts'
import { codexBrowsing, parseScreen, promptSummary, promptWhole, unstyle } from './screen.ts'

// Captures live in fixtures/screens/<agent>/ at the repo root; the Claude Code ones are from
// 2.1.296 at 100 columns. The builders below vary one part of a screen per test.
const R = '─'.repeat(100)
const screen = (s: string) => s.split('\n')

test('permission prompt', () => {
  const s = parseScreen(screenFixture('claude', 'permission-prompt'))
  expect(s.working).toBe(false)
  const p = s.prompt!
  expect(p.options.map((o) => o.n)).toEqual([1, 2, 3, 4])
  expect(p.options[0]).toMatchObject({ label: 'Yes', selected: true })
  expect(p.options[1].label).toContain('-d507-4808')
  expect(p.body[0]).toBe('Bash command')
  expect(p.body).toContain('echo hello-inyon > out.txt')
  expect(p.footer).toBe('Esc to cancel · Tab to amend')
  expect(p.multi).toBe(false)
})

test('ask user question, single select', () => {
  const s = parseScreen(screenFixture('claude', 'question-single'))
  const p = s.prompt!
  expect(p.body).toEqual(['What is your favorite color?'])
  expect(p.options.map((o) => o.label)).toEqual(['Red', 'Green', 'Blue', 'Type something.', 'Chat about this'])
  expect(p.options[0].detail).toBe('The color red')
  expect(p.freeTextOption).toBe(4)
  expect(p.tabs?.map((t) => t.label)).toEqual(['Color', 'Fruits', 'Submit'])
  expect(p.tabs?.[0].current).toBe(true)
})

test('ask user question, multi select', () => {
  const s = parseScreen(screenFixture('claude', 'question-multi'))
  const p = s.prompt!
  expect(p.multi).toBe(true)
  expect(p.options.slice(0, 3).map((o) => [o.label, o.checked])).toEqual([['Apple', true], ['Mango', false], ['Kiwi', true]])
  expect(p.options[3].detail).toBeUndefined()
  expect(p.tabs?.[1].current).toBe(true)
})

test('idle with draft, mode and finished spinner', () => {
  const s = parseScreen(screenFixture('claude', 'idle-draft'))
  expect(s.prompt).toBeUndefined()
  expect(s.working).toBe(false)
  expect(s.draft).toBe('half typed message')
  expect(s.mode).toBe('manual')
})

test("a numbered list in the last reply isn't a question once the session has a name", () => {
  const screen = screenFixture('claude', 'renamed-session')
  const s = parseScreen(screen, 88)
  expect(s.prompt).toBeUndefined()
  expect(s.inputVisible).toBe(true)
  expect(s.mode).toBe('auto')
  // and what you type there is still read as a draft
  expect(parseScreen(screen.map((l) => (l === '❯ ' ? '❯ 44' : l)), 88).draft).toBe('44')
})

test('working', () => {
  const s = parseScreen(screenFixture('claude', 'working'))
  expect(s.working).toBe(true)
  expect(s.activity).toBe('Undulating… (2s · thinking with high effort)')
  expect(s.mode).toBe('accept edits')
  expect(s.draft).toBeUndefined()
})

test('word-wrapped option label keeps its space', () => {
  const s = parseScreen(
    screenFixture('claude', 'permission-wrapped'),
    80,
  )
  expect(s.prompt!.options[1].label).toBe('Yes, and always allow access to /tmp/tester-1001/scratchpad/play from this project')
  expect(s.prompt!.options[1].detail).toBeUndefined()
})

test('menu without numbers (remote control)', () => {
  const s = parseScreen(
    screenFixture('claude', 'remote-control-menu'),
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
    screenFixture('claude', 'login-url'),
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
    screenFixture('claude', 'login-method'),
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
    const cap = screenFixture('codex', 'trust')
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

  const codex = (name: string) => parseScreen(screenFixture('codex', name), 120, 'codex')

  test('Codex command approval (real capture, Codex 0.162)', () => {
    const s = codex('approval')
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
    const s = codex('queued')
    expect(s.working).toBe(true)
    expect(s.activity).toBe('Working')
    expect(s.queue).toEqual(['second message queued'])
    expect(s.draft).toBe('draft text here')
    expect(s.model).toBe('GPT-6-Luna')
    expect(s.effort).toBe('high')
  })

  test('the dimmed suggestion in an empty Codex composer is not a draft', () => {
    expect(codex('working-empty').draft).toBeUndefined()
  })

  test('a Codex settings picker is a menu, not the composer (50 columns)', () => {
    const s = parseScreen(screenFixture('codex', 'effort-narrow'), 50, 'codex')
    expect(s.model).toBeUndefined()
    expect(s.draft).toBeUndefined()
    expect(s.prompt?.body).toEqual(['Select Reasoning Level for GPT-6.1-Sol'])
    expect(s.prompt?.options.map((o) => o.label)).toEqual(['Low (default)', 'Medium', 'High', 'Extra high', 'More reasoning…'])
    expect(s.prompt?.options[0].current).toBe(true)
  })

  test('Codex idle with a background terminal', () => {
    const s = codex('bg-idle')
    expect(s.working).toBe(false)
    expect(s.background).toBe('1 background terminal')
  })

  test('a Codex footer that lists nothing in the background says so', () => {
    expect(codex('question-pending').background).toBeNull()
    expect(codex('working-empty').background).toBe('1 background terminal')
    // a menu replaces the footer, so there is nothing to read
    expect(codex('approval').background).toBeUndefined()
  })

  // Real captures from Codex 0.162.1 at 120 columns (its app-server 0.163.0), paths shortened.

  test('the time Codex has worked so far is read off the working line', () => {
    const s = codex('question-pending')
    expect(s.working).toBe(true)
    // "Working (39s • esc to interrupt)": 39 s ago, to the second
    expect(Date.now() - s.since!).toBeGreaterThanOrEqual(38_500)
    expect(Date.now() - s.since!).toBeLessThan(41_000)
    expect(s.since! % 1000).toBe(0)
  })

  test('a question Codex asked mid-turn waits under the working line', () => {
    const s = codex('question-pending')
    expect(s.working).toBe(true)
    expect(s.questions).toBe(1)
    expect(s.queue).toBeUndefined()
    expect(s.prompt).toBeUndefined()
  })

  test('the opened question (shift+←) is a menu of its options', () => {
    const s = codex('question')
    expect(s.model).toBeUndefined()
    const p = s.prompt!
    expect(p.body).toEqual(['Colour'])
    expect(p.options).toEqual([
      { n: 1, label: 'Red', detail: undefined, selected: true },
      { n: 2, label: 'Blue', detail: undefined, selected: false },
      { n: 3, label: 'Other', detail: undefined, selected: false },
    ])
    expect(p.footer).toBe('enter submit   ^] skip   shift+→ main prompt')
    expect(p.navigate).toBe(true)
  })

  test('the plan-mode question once a plan is written', () => {
    const s = codex('plan-implement')
    const p = s.prompt!
    expect(p.body).toEqual(['Implement this plan?'])
    expect(p.options.map((o) => [o.label, o.detail])).toEqual([
      ['Yes, implement this plan', 'Switch to Default and start coding'],
      ['Yes, clear context and implement', 'Start a fresh thread (current context: 2% used)'],
      ['No, stay in Plan mode', 'Continue planning with the model'],
    ])
    expect(p.options[0].selected).toBe(true)
    expect(p.footer).toBe('enter select · esc back')
  })

  test('a command approval, with its reason, in a read-only workspace', () => {
    const s = codex('command-approval')
    const p = s.prompt!
    expect(p.body[0]).toBe('Would you like to run the following command?')
    expect(p.body).toContain('Reason: May I create hello.txt in the workspace containing the word hi?')
    expect(p.body).toContain("$ printf 'hi\\n' > hello.txt")
    expect(p.options.map((o) => o.label)).toEqual(['Yes, proceed', "Yes, and don't ask again for commands that start with `printf 'hi\\n' > hello.txt`", 'No, and tell Codex what to do differently'])
    // the alert and the overview say what would run
    expect(promptSummary(p)).toBe("Run printf 'hi\\n' > hello.txt")
    // the line is the whole question: quick answers are offered
    expect(promptWhole(p)).toBe(true)
  })

  test('a file change approval names the file', () => {
    const s = codex('patch-approval')
    const p = s.prompt!
    expect(p.body[0]).toBe('Would you like to make the following edits?')
    expect(p.body).toContain('Description: Apply proposed file edits')
    expect(p.options.map((o) => o.label)).toEqual(['Yes, proceed', "Yes, and don't ask again for these files", 'No, and tell Codex what to do differently'])
    expect(p.options[0].selected).toBe(true)
    // the path was wrapped by the terminal ("…/notes2" and ".txt"); the file is still named
    expect(promptSummary(p)).toBe('Edit notes2.txt?')
    // the line leaves out what an answer agrees to: no quick answers
    expect(promptWhole(p)).toBe(false)
  })

  test('the review presets', () => {
    const p = codex('review').prompt!
    expect(p.body).toEqual(['Select a review preset'])
    expect(p.options.map((o) => o.label)).toEqual(['Review against a base branch', 'Review uncommitted changes', 'Review a commit', 'Custom review instructions'])
    expect(p.options[0].detail).toBe('(PR Style)')
  })

  test('the model list marks the model in use, and the reasoning step marks the default', () => {
    const models = codex('model').prompt!
    expect(models.body).toEqual(['Select Model and Effort'])
    expect(models.options.map((o) => [o.label, o.current ?? false])).toEqual([['GPT-6-Luna', true], ['GPT-5.6-Terra', false], ['GPT-5.6-Luna', false]])
    expect(models.options[0].detail).toBe('Fast and affordable model for easier tasks.')
    const levels = codex('reasoning').prompt!
    expect(levels.body).toEqual(['Select Reasoning Level for GPT-6-Luna'])
    expect(levels.options.map((o) => o.label)).toEqual(['Low', 'Medium (default)', 'High', 'Extra high', 'More reasoning…'])
    expect(levels.options[1].selected).toBe(true)
    expect(levels.footer).toBe('enter default · s session · esc back')
  })

  test('the permission presets, each with what it allows', () => {
    const p = codex('permissions').prompt!
    expect(p.body).toEqual(['Update Model Permissions'])
    expect(p.options.map((o) => o.label)).toEqual(['Ask for approval', 'Approve for me', 'Full Access', 'Read Only'])
    expect(p.options[0].detail).toBe('Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace')
    expect(p.options[3].detail).toBe('Read workspace files, with approval required for edits or internet access')
  })

  test('browsing the transcript to rewind: the highlighted message is known', () => {
    const cap = screenFixture('codex', 'rewind')
    expect(codexBrowsing(cap)).toEqual({ selected: '> Colour', screen: cap.join('\n') })
    // not browsing: the composer is there as usual
    expect(codexBrowsing(screenFixture('codex', 'working-empty'))).toBeUndefined()
    const s = parseScreen(cap, 120, 'codex')
    expect(s.prompt).toBeUndefined()
  })

  test('a numbered list in a reply is not a prompt', () => {
    const s = parseScreen(screenFixture('codex', 'reply-numbered-list'), 80, 'codex')
    expect(s.prompt).toBeUndefined()
  })
})

describe('Antigravity CLI (real captures, agy 1.3.3 at 150 columns)', () => {
  const cap = (name: string) => screenFixture('antigravity', name)
  const agy = (lines: string[]) => parseScreen(lines, 150, 'antigravity')

  test('idle', () => {
    expect(agy(cap('idle'))).toEqual({ working: false, width: 150, model: 'Gemini 3.8 Flash', effort: 'high', mode: 'default', inputVisible: true })
  })

  test('working: the spinner above the box, not the footer', () => {
    const s = agy(cap('working'))
    expect(s.working).toBe(true)
    expect(s.activity).toBe('Generating')
    expect(s.prompt).toBeUndefined()
    expect(s.draft).toBeUndefined()
  })

  test('a typed draft', () => {
    expect(agy(cap('draft')).draft).toBe('fix the bug in main.go please')
  })

  test('model and effort from the footer', () => {
    const s = agy(cap('approval'))
    expect([s.model, s.effort]).toEqual(['Gemini 3.8 Flash', 'high'])
    expect(agy(cap('plan')).model).toBe('Gemini 3.8 Flash')
  })

  test('mode from the footer', () => {
    expect(agy(cap('accept-edits')).mode).toBe('accept-edits')
    expect(agy(cap('plan')).mode).toBe('plan')
    // the grey "Plan mode: … (shift+tab to cycle)" hint in the empty box is not a draft
    expect(agy(cap('accept-edits')).draft).toBeUndefined()
    expect(agy(cap('plan')).draft).toBeUndefined()
    expect(agy(cap('idle')).mode).toBe('default')
  })

  test('the slash picker under the box is not a prompt', () => {
    const s = agy(cap('slash'))
    expect(s.prompt).toBeUndefined()
    expect(s.working).toBe(false)
    expect(s.draft).toBe('/')
  })

  test('command approval', () => {
    const p = agy(cap('approval')).prompt!
    expect(p.options.map((o) => [o.n, o.selected])).toEqual([[1, true], [2, false], [3, false], [4, false]])
    expect(p.options[0].label).toBe('Yes, run command')
    expect(p.options[3].label).toBe('No, cancel')
    expect(p.navigate).toBe(true)
    expect(p.body).toEqual(['Run this command?', '╌', 'date +%Y', '╌'])
  })

  test('approval whose long options wrap to column 0 in a narrow pane', () => {
    const p = parseScreen(cap('approval-wrapped'), 115, 'antigravity').prompt!
    expect(p.options.map((o) => o.n)).toEqual([1, 2, 3, 4])
    expect(p.options[2].label).toContain("-maxdepth 3 -not -path '*/.*' -not -path")
    expect(p.options[2].label).toEndWith('(Persist to settings.json)')
    expect(p.body[2]).toStartWith('find apps packages deploy')
  })

  test('folder trust', () => {
    const p = agy(cap('trust')).prompt!
    expect(p.options).toEqual([
      { n: 1, label: 'Yes, I trust this folder', selected: true },
      { n: 2, label: 'No, exit', selected: false },
    ])
    expect(p.navigate).toBe(true)
    expect(p.body).toContain('Do you trust the contents of this project?')
  })

  test('queued messages while working', () => {
    const s = agy(cap('queued'))
    expect(s.working).toBe(true)
    expect(s.activity).toBe('Generating')
    expect(s.queue).toEqual(['Then say done.'])
  })

  test('wrapped queued message under a background task', () => {
    const s = agy(cap('queued-task'))
    expect(s.working).toBe(true)
    expect(s.activity).toBe('Running command')
    expect(s.queue).toEqual(['Then say done, and list every file in this folder with its size, newest first, so I can see what changed.'])
    expect(s.model).toBe('Gemini 3.8 Flash')
    expect(s.effort).toBe('medium')
    expect(s.background).toBe('1 background task')
  })

  test('a folded thought is not a queued message', () => {
    const s = agy(cap('folded-thought'))
    expect(s.working).toBe(false)
    expect(s.queue).toBeUndefined()
  })

  test('rewind picker: one option per message, its age as detail', () => {
    const p = agy(cap('rewind')).prompt!
    expect(p.body).toEqual(['Rewind Conversation'])
    expect(p.navigate).toBe(true)
    expect(p.options[0]).toEqual({ n: 1, label: 'Then say done.', detail: '19m ago', selected: false })
    expect(p.options.at(-1)).toMatchObject({ label: '(current)', selected: true })
    expect(p.options.some((o) => /items\]/.test(o.label))).toBe(false)
  })

  test('model picker: models only, without the search field or the effort slider', () => {
    const p = agy(cap('model-menu')).prompt!
    expect(p.body).toEqual(['Switch Model'])
    expect(p.options[0]).toEqual({ n: 1, label: 'Gemini 3.8 Flash', detail: 'current', selected: true })
    expect(p.options.map((o) => o.label)).not.toContain('Search:')
    expect(p.options.some((o) => /Effort/.test(o.label))).toBe(false)
    expect(p.options).toHaveLength(7)
  })

  test('resume picker: table rows, not the heading or the search line', () => {
    const p = agy(cap('resume')).prompt!
    expect(p.body).toEqual(['Conversations'])
    expect(p.options[0]).toEqual({ n: 1, label: '[CURRENT] Inyon QA run', detail: '27 steps · 8m ago', selected: true })
    expect(p.options[1]).toMatchObject({ label: 'Simple Greeting', detail: 'custom-tmux · 47 steps · 23m ago' })
    expect(p.options).toHaveLength(5)
  })

  test('remote control link, rejoined where the pane wrapped it, and off again', () => {
    const on = fixture('screens/antigravity/remote-control.txt')
    expect(parseScreen(screen(on), 60, 'antigravity').remote).toBe('https://antigravity.google.com/r/77637f21-f314-468d-9258-23b644a606f9-v2?p=c%2F5a9bbba1')
    const off = on.replace('? for shortcuts', '> /remote-control off\n  ⎿  Remote control off. This machine is no longer reachable.\n? for shortcuts')
    expect(parseScreen(screen(off), 60, 'antigravity').remote).toBeNull()
    expect(agy(cap('idle')).remote).toBeUndefined()
  })

  test('approval options wrapped at a narrow width', () => {
    const p = parseScreen(screenFixture('antigravity', 'approval-narrow'), 60, 'antigravity').prompt!
    expect(p.options.map((o) => o.label)).toEqual(['Yes, run command', "Yes, and always allow in this conversation for commands that start with 'rm'", 'No, cancel'])
  })
})

// Active status rows may be separated from the composer by tips and live tool output.
// Quiet commands still have these rows; lack of new output is not completion.
describe('quiet foreground work', () => {
  test('Codex spinner above delegation tip remains working', () => {
    const lines = screenFixture('codex', 'working-tip')
    expect(parseScreen(lines, 100, 'codex')).toMatchObject({ working: true, activity: 'Working' })
    lines.splice(0, 2, '• done', '  Worked for 2m 07s')
    expect(parseScreen(lines, 100, 'codex').working).toBe(false)
  })

  test('Claude spinner survives long wrapped tool hints', () => {
    const lines = screenFixture('claude', 'working-tool-hints')
    expect(parseScreen(lines).working).toBe(true)
    lines[0] = '● Command finished'
    expect(parseScreen(lines)).toMatchObject({ working: false, background: '1 shell' })
  })

  test('Antigravity spinner survives live command output', () => {
    const lines = screenFixture('antigravity', 'working-command-output')
    expect(parseScreen(lines, 100, 'antigravity')).toMatchObject({ working: true, activity: 'Running command' })
    lines[0] = 'Command finished'
    expect(parseScreen(lines, 100, 'antigravity').working).toBe(false)
  })

  test('Codex does not reuse a prior turn spinner', () => {
    expect(parseScreen(screenFixture('codex', 'finished-after-spinner'), 100, 'codex').working).toBe(false)
  })
})

test('Codex reads a composer longer than fourteen terminal rows', () => {
  const rows = screenFixture('codex', 'long-draft')
  const s = parseScreen(rows, 100, 'codex')
  expect(s.inputVisible).toBe(true)
  expect(s.draft).toContain('long draft')
  expect(s.draft?.match(/continued text/g)).toHaveLength(20)
})

test('Codex shell composer keeps the exclamation command prefix', () => {
  const s = parseScreen(screenFixture('codex', 'shell-composer'), 100, 'codex')
  expect(s.inputVisible).toBe(true)
  expect(s.draft).toBe('! printf hello')
})

test("Codex's question to trust new hooks is buttons, without its banner", () => {
  const s = parseScreen(screenFixture('codex', 'hooks-review'), 120, 'codex')
  expect(s.prompt?.body).toEqual(['Hooks need review', '2 hooks are new or changed.', 'Hooks can run outside the sandbox after you trust them.'])
  expect(s.prompt?.options.map((o) => o.label)).toEqual(['Review hooks', 'Trust all and continue', "Continue without trusting (hooks won't run)"])
})

test('a message from another session waiting to be let through is a question with buttons', () => {
  const s = parseScreen(screenFixture('claude', 'held-peer-message'), 150)
  expect(s.prompt?.navigate).toBe(true)
  expect(s.prompt?.options.map((o) => [o.label, o.detail, o.selected])).toEqual([
    ['Deny', 'drop it and tell the sender it was declined', true],
    ['Deliver this message to Claude', undefined, false],
  ])
  expect(s.prompt?.body[0]).toBe('Held message from another session')
  expect(s.prompt?.body).toContain('Test message from the Inyon development session: please reply with only')
  expect(s.prompt?.body.filter((l) => l === '╌').length).toBe(2)
})

// Claude Code on Windows (psmux), 14 Oct 2026: a "│ " gutter down the command, and lines under it
// that are separate sentences, not one wrapped paragraph
test('command prompt with a gutter keeps its lines and loses the gutter', () => {
  const s = parseScreen(
    screenFixture('claude', 'bash-gutter'),
    100,
  )
  const p = s.prompt!
  expect(p.body).toEqual([
    'Bash command',
    'Append empty-cart test and run the suite',
    '╌',
    "cat >> test/cart.test.js <<'EOF'",
    '',
    "test('empty cart costs nothing', () => {",
    '  assert.equal(subtotal([]), 0)',
    '})',
    'EOF',
    '╌',
    'Contains brace with quote character (expansion obfuscation)',
    'Ask rule Bash overrides auto mode for this command.',
    '/permissions to let auto mode decide',
    'Do you want to proceed?',
  ])
  expect(p.wholeLines).toBe(true)
  expect(p.options.map((o) => o.label)).toEqual(['Yes', 'No'])
  expect(promptSummary(p)).toBe("Append empty-cart test and run the suite: cat >> test/cart.test.js <<'EOF'")
  // the line leaves out what an answer agrees to: no quick answers
  expect(promptWhole(p)).toBe(false)
})

test('a PowerShell prompt reads as what the command is for', () => {
  const s = parseScreen(
    screenFixture('claude', 'powershell-prompt'),
    100,
  )
  expect(s.prompt!.body.slice(3)).toEqual(['npm test', '╌', 'This command requires approval', 'Do you want to proceed?'])
  expect(promptSummary(s.prompt!)).toBe('Re-run the test suite: npm test')
  expect(promptWhole(s.prompt!)).toBe(true)
})

test('lines Claude wrapped are joined, real line breaks stay', () => {
  const s = parseScreen(
    screenFixture('claude', 'switch-model'),
    80,
  )
  expect(s.prompt!.body).toEqual([
    'Switch model?',
    'Your next response will be slower and use more tokens',
    'This conversation is cached for the current model. Switching to Sonnet 5.5 means the full history gets re-read on your next message.',
  ])
  expect(promptSummary(s.prompt!)).toBe('Switch model?')
  expect(promptWhole(s.prompt!)).toBe(true)
})

test('an alert for a command names what it is for, not the tip', () => {
  const s = parseScreen(screenFixture('claude', 'permission-tip'))
  expect(promptSummary(s.prompt!)).toBe('Write hello-inyon to out.txt: echo hello-inyon > out.txt')
  expect(promptWhole(s.prompt!)).toBe(true)
})

test('an edit prompt names the file, not the first line of the diff', () => {
  const s = parseScreen(
    screenFixture('claude', 'edit-prompt'),
  )
  expect(promptSummary(s.prompt!)).toBe('Edit file: test\\cart.test.js')
  expect(promptWhole(s.prompt!)).toBe(false)
})

describe('ultracode in Claude Code 2.1.299', () => {
  // captured with `claude --effort ultracode`: the box's top rule carries the label, and the
  // effort line above the box names it too
  const box = (rule: string, above = '') => screen(`❯ /clear
${above}
${rule}
❯
${R}
  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_CODE_FORCE_…
  ⏵⏵ auto mode on (shift+tab to cycle)`)
  const labelled = `${'─'.repeat(98)} ultracode ─`

  test('on: the rule says so, and the effort line names the level', () => {
    const s = parseScreen(box(labelled, '               ◉ xhigh · ultracode · /effort · current: 2.1.299 · lates… ✔ Update installed · Restart to up…'), 110)
    expect(s).toMatchObject({ inputVisible: true, ultracode: true, effort: 'xhigh', mode: 'auto', working: false })
    expect(s.draft).toBeUndefined()
    // the label alone is enough (the effort line comes and goes)
    const bare = parseScreen(box(labelled, '                                    0 tokens · current: 2.1.299 · lates… ✔ Update installed · Restart to up…'), 110)
    expect(bare.ultracode).toBe(true)
    expect(bare.effort).toBeUndefined()
  })

  test('off: a bare rule, with or without the effort line; a renamed session is not ultracode', () => {
    expect(parseScreen(box(R, '                           ◉ xhigh · /effort · current: 2.1.299 · lates… ✔ Update installed · Restart to up…'), 110)).toMatchObject({ ultracode: false, effort: 'xhigh' })
    expect(parseScreen(box(R), 110)).toMatchObject({ ultracode: false })
    expect(parseScreen(box(`${'─'.repeat(90)} Abhash Website ─`), 110)).toMatchObject({ ultracode: false, inputVisible: true })
  })

  test('unknown while a dialog covers the box', () => {
    expect(parseScreen(screenFixture('claude', 'effort-dialog'), 100).ultracode).toBeUndefined()
  })
})

describe('background agents in the Claude footer', () => {
  // the ← is the hint to expand the agent list; the two rows under it are that list, opened
  const footer = (status: string, ...rows: string[]) => screen(`● Started the agent in the background.
${R}
❯
${R}
  ${status}${rows.map((r) => `\n  ${r}`).join('')}`)
  const agents = ['● main', '◯ general-purpose  Sleep briefly for a footer test                                                      6s · ↓ 37.9k tokens']

  test('a shell and an agent, with bypass mode', () => {
    const s = parseScreen(footer('⏵⏵ bypass permissions on · 1 shell · ← 1 agent', ...agents), 100)
    expect(s).toMatchObject({ working: false, inputVisible: true, mode: 'bypass permissions', background: '1 shell, 1 agent' })
    expect(s.draft).toBeUndefined()
    expect(s.prompt).toBeUndefined()
  })

  test('agents alone, without the mode segment', () => {
    expect(parseScreen(footer('← 1 agent'), 100).background).toBe('1 agent')
    expect(parseScreen(footer('1 shell · 1 agent'), 100).background).toBe('1 shell, 1 agent')
    expect(parseScreen(footer('← 2 agents', ...agents, '◯ Explore  Find the parser  12s · ↓ 4.1k tokens'), 100)).toMatchObject({ working: false, background: '2 agents' })
  })

  test('the agent list rows are not read as a footer', () => {
    const s = parseScreen(footer('⏵ plan mode on · ← 1 agent', '● main', '◯ general-purpose  Start 2 shells, then ⏵⏵ bypass permissions on  6s · ↓ 1.2k tokens'), 100)
    expect(s).toMatchObject({ mode: 'plan', background: '1 agent' })
  })

  test('nothing in the background once the footer is bare, which is not the same as no footer', () => {
    expect(parseScreen(footer('⏵⏵ bypass permissions on'), 100).background).toBeNull()
    // a picker over the input box: the footer can't be read, so nothing is known
    expect(parseScreen(screenFixture('claude', 'effort-dialog'), 100).background).toBeUndefined()
  })

  test('every kind of background work Claude Code 2.1.299 names', () => {
    expect(parseScreen(footer('⏵⏵ bypass permissions on · 1 local agent'), 100).background).toBe('1 local agent')
    expect(parseScreen(footer('⏵⏵ auto mode on (shift+tab to cycle) · 1 background dynamic workflow'), 100).background).toBe('1 background dynamic workflow')
    expect(parseScreen(footer('1 MCP task · 1 Artifact comment monitor · 1 cloud session'), 100).background).toBe('1 MCP task, 1 Artifact comment monitor, 1 cloud session')
    expect(parseScreen(footer('⏵⏵ bypass permissions on · 1 shell · /tasks to see subagents · ← 1 agent'), 100).background).toBe('1 shell, 1 agent')
    expect(parseScreen(footer('3 background tasks'), 100).background).toBe('3 background tasks')
  })
})
