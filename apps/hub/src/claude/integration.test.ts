import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOOK_SCRIPT, STATUS_SCRIPT } from './integration.ts'
import { ACCOUNT_SH } from './integration-sh.ts'
import { claudeStatus } from '../agents/status.ts'
import { probe } from '../tmux/tmux.ts'
import type { Host } from '../hosts/host.ts'

const home = mkdtempSync(join(tmpdir(), 'inyon-int-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

/** A ~/.claude.json shaped like the real one: other accountUuid keys come before oauthAccount. */
function writeConfig(account: string) {
  const cfg = {
    numStartups: 3,
    projects: { '/x': { lastAccount: { accountUuid: 'not-this-one' } } },
    oauthAccount: { accountUuid: account, emailAddress: 'a@b.c', ccOnboardingFlags: { x: true } },
  }
  writeFileSync(join(home, '.claude.json'), JSON.stringify(cfg, null, 2))
}

function run(script: string, input: string, pane = '%9') {
  const r = Bun.spawnSync(['sh', '-c', script], { stdin: Buffer.from(input), env: { HOME: home, TMUX_PANE: pane, PATH: process.env.PATH } })
  return r.stdout.toString()
}

const payload = (session: string) =>
  JSON.stringify({
    session_id: session,
    model: { id: 'claude-opus', display_name: 'Opus' },
    context_window: { context_window_size: 1000, used_percentage: 90, current_usage: { input_tokens: 900 } },
    rate_limits: { five_hour: { used_percentage: 100, resets_at: 4102444800 }, seven_day: { used_percentage: 93, resets_at: 4102444800 } },
  })

describe('integration scripts', () => {
  test('account helper reads oauthAccount, not other accountUuid keys', () => {
    writeConfig('acct-A')
    expect(run(`${ACCOUNT_SH} "$HOME/.claude.json"`, '').trim()).toBe('acct-A')
    expect(run(`${ACCOUNT_SH} "$HOME/missing.json"`, '').trim()).toBe('-')
  })

  test('status line wrapper saves the payload and the account it was written under', () => {
    writeConfig('acct-A')
    run(STATUS_SCRIPT, payload('s1'))
    expect(JSON.parse(readFileSync(join(home, '.inyon/status/9.json'), 'utf8')).session_id).toBe('s1')
    expect(readFileSync(join(home, '.inyon/status/9.acct'), 'utf8')).toBe(`acct-A ${home}/.claude.json\n`)
  })

  test('hook stamps a compaction, and only a compaction', () => {
    run(HOOK_SCRIPT, JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }))
    expect(existsSync(join(home, '.inyon/panes/9.compact'))).toBe(false)
    run(HOOK_SCRIPT, JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'compact' }))
    expect(Number(readFileSync(join(home, '.inyon/panes/9.compact'), 'utf8'))).toBeGreaterThan(0)
  })
})

describe('psmux (Windows)', () => {
  // psmux numbers panes per session, so two sessions both run in %1; the hub calls them %<session>.<pane>
  function runPsmux(script: string, input: string, answer: string) {
    const bin = mkdtempSync(join(tmpdir(), 'inyon-psmux-'))
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\n[ "$*" = "display -p -t checkout #{session_id}" ] && printf '${answer}'\n`, { mode: 0o755 })
    Bun.spawnSync(['sh', '-c', script], { stdin: Buffer.from(input), env: { HOME: home, TMUX_PANE: '%1', PSMUX_SESSION: 'checkout', PATH: `${bin}:${process.env.PATH}` } })
    rmSync(bin, { recursive: true, force: true })
  }

  test('the status line and hook name the pane as the hub does, so two sessions keep their own files', () => {
    writeConfig('acct-A')
    runPsmux(STATUS_SCRIPT, payload('s-psmux'), '$36\\r\\n')
    expect(JSON.parse(readFileSync(join(home, '.inyon/status/36.1.json'), 'utf8')).session_id).toBe('s-psmux')
    runPsmux(HOOK_SCRIPT, JSON.stringify({ session_id: 's-psmux', hook_event_name: 'Stop' }), '$36\\n')
    expect(JSON.parse(readFileSync(join(home, '.inyon/panes/36.1.json'), 'utf8')).pane).toBe('%36.1')
  })

  test('without an answer from psmux, the pane keeps its own name', () => {
    runPsmux(STATUS_SCRIPT, payload('s-plain'), '')
    expect(JSON.parse(readFileSync(join(home, '.inyon/status/1.json'), 'utf8')).session_id).toBe('s-plain')
  })

  test('the probe reads those files back under the same name', async () => {
    const out = ['@@STATUS', `36.1 1700000000 - - ${payload('s-psmux')}`, '@@COMPACT', '36.1 1700000001', '@@END'].join('\n')
    const fake = { config: { id: 'win', name: 'win', kind: 'local' }, exec: async () => ({ stdout: out, stderr: '', code: 0 }) } as unknown as Host
    const r = await probe(fake)
    expect(r.statusPanes.get('%36.1')?.data.session_id).toBe('s-psmux')
    expect(r.compactPanes.get('%36.1')).toBe(1700000001)
  })
})

describe('claudeStatus', () => {
  const base = (over: Partial<{ ts: number; account: string; accountNow: string; session: string }> = {}) => ({
    integration: 'installed' as const,
    statusPanes: new Map([['%9', { ts: over.ts ?? 1000, data: JSON.parse(payload(over.session ?? 's1')), account: over.account ?? 'A', accountNow: over.accountNow ?? 'A' }]]),
    compactPanes: new Map<string, number>(),
  })

  test('fresh snapshot passes through', () => {
    const st = claudeStatus(base(), '%9', 900, 's1')!
    expect(st.fiveHour?.pct).toBe(100)
    expect(st.contextPct).toBe(90)
    expect(st.stale).toBeUndefined()
  })

  test('leftover file is ignored once the integration is gone from settings', () => {
    expect(claudeStatus({ ...base(), integration: 'removed' }, '%9', 900, 's1')).toBeUndefined()
  })

  test('snapshot from another session or an earlier process is ignored', () => {
    expect(claudeStatus(base(), '%9', 900, 's2')).toBeUndefined()
    expect(claudeStatus(base(), '%9', 2000, 's1')).toBeUndefined()
  })

  test('limits are dropped after switching account', () => {
    const st = claudeStatus(base({ accountNow: 'B' }), '%9', 900, 's1')!
    expect(st.fiveHour).toBeUndefined()
    expect(st.sevenDay).toBeUndefined()
    expect(st.contextPct).toBe(90)
    expect(st.stale?.limits).toBe('account')
  })

  test('context is dropped when the snapshot predates a compaction', () => {
    const pr = base()
    pr.compactPanes.set('%9', 1500)
    const st = claudeStatus(pr, '%9', 900, 's1')!
    expect(st.contextPct).toBeUndefined()
    expect(st.contextUsed).toBeUndefined()
    expect(st.fiveHour?.pct).toBe(100)
    expect(st.stale?.context).toBe('compacted')
    // a snapshot written after the compaction is current again
    pr.statusPanes.get('%9')!.ts = 1600
    expect(claudeStatus(pr, '%9', 900, 's1')!.contextPct).toBe(90)
  })
})

describe('resumeCommand', () => {
  test('keeps launch flags, drops the old session and any prompt', async () => {
    const { resumeCommand } = await import('./actions.ts')
    const id = '7409eef9-d507-4808-a592-0bfabe896e3a'
    expect(resumeCommand('claude', id, 'claude --dangerously-skip-permissions')).toBe(`claude --resume ${id} '--dangerously-skip-permissions'`)
    expect(resumeCommand('claude', id, '/home/u/.local/bin/claude --resume 11111111-2222-3333-4444-555555555555 --model opus fix it'))
      .toBe(`claude --resume ${id} '--model' 'opus'`)
    expect(resumeCommand('claude', id, 'claude -c --permission-mode plan')).toBe(`claude --resume ${id} '--permission-mode' 'plan'`)
    expect(resumeCommand('codex', id, 'node /usr/lib/node_modules/@openai/codex/bin/codex.js -m gpt-5 --yolo')).toBe(`codex resume ${id} '-m' 'gpt-5' '--yolo'`)
    expect(resumeCommand('antigravity', id, '/home/u/.local/bin/agy --conversation 11111111-2222-3333-4444-555555555555 --mode plan -p hi --dangerously-skip-permissions'))
      .toBe(`agy --conversation ${id} '--mode' 'plan' '--dangerously-skip-permissions'`)
    expect(resumeCommand('antigravity', undefined, 'agy -c --effort low')).toBe(`agy '--effort' 'low'`)
  })
})

/** A host whose shell sees only the temp HOME, so install/uninstall can never reach the real one. */
const sandboxHost = {
  exec: async (cmd: string, opts: { input?: string } = {}) => {
    const r = Bun.spawnSync(['sh', '-c', cmd], { stdin: opts.input === undefined ? undefined : Buffer.from(opts.input), env: { HOME: home, PATH: process.env.PATH! } })
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
} as any

describe('installIntegration', () => {
  test('a status line synced from Windows does not replace the one that runs here', async () => {
    const { installIntegration } = await import('./integration.ts')
    const settings = (cmd: string) => {
      Bun.spawnSync(['mkdir', '-p', join(home, '.claude')])
      writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ statusLine: { type: 'command', command: cmd } }))
    }
    const orig = () => readFileSync(join(home, '.inyon/statusline.orig'), 'utf8').trim()
    settings('~/.claude/statusline.sh')
    await installIntegration(sandboxHost)
    expect(orig()).toBe('~/.claude/statusline.sh')
    settings('node C:/Users/me/.claude/statusline.js')
    await installIntegration(sandboxHost)
    expect(orig()).toBe('~/.claude/statusline.sh')
    expect(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).statusLine.command).toBe('~/.inyon/statusline.sh')
    settings('~/bin/new-bar.sh')
    await installIntegration(sandboxHost)
    expect(orig()).toBe('~/bin/new-bar.sh')
  })

  test('a saved status line that leads back to the wrapper runs once instead of starting itself forever', async () => {
    const { installIntegration, AGY_STATUS_SCRIPT } = await import('./integration.ts')
    await installIntegration(sandboxHost)
    Bun.spawnSync(['ln', '-sfn', join(home, '.inyon'), join(home, '.tether')])
    writeFileSync(join(home, '.inyon/agy-statusline.sh'), AGY_STATUS_SCRIPT)
    for (const [script, saved] of [['statusline.sh', '~/.tether/statusline.sh'], ['agy-statusline.sh', '~/.inyon/agy-statusline.sh']]) {
      writeFileSync(join(home, `.inyon/${script.replace('.sh', '.orig')}`), `${saved}\necho drawn\n`)
      const p = Bun.spawn(['sh', join(home, '.inyon', script)], { stdin: Buffer.from(payload('s1')), stdout: 'pipe', env: { HOME: home, PATH: process.env.PATH!, TMUX_PANE: '%9' } })
      const timer = setTimeout(() => p.kill('SIGKILL'), 3000)
      expect(await p.exited).toBe(0)
      clearTimeout(timer)
      expect((await new Response(p.stdout).text()).trim()).toBe('drawn')
    }
    // healing the integration puts back the status line from before Inyon, or none
    const backup = join(home, '.claude/settings.json.inyon-backup')
    writeFileSync(backup, JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/.claude/statusline.sh' } }))
    writeFileSync(join(home, '.inyon/statusline.orig'), '~/.inyon/statusline.sh\n')
    await installIntegration(sandboxHost)
    expect(readFileSync(join(home, '.inyon/statusline.orig'), 'utf8')).toBe('bash ~/.claude/statusline.sh\n')
    writeFileSync(backup, JSON.stringify({ statusLine: { type: 'command', command: 'node C:/Users/me/.claude/statusline.js' } }))
    writeFileSync(join(home, '.inyon/statusline.orig'), '~/.tether/statusline.sh\n')
    await installIntegration(sandboxHost)
    expect(readFileSync(join(home, '.inyon/statusline.orig'), 'utf8')).toBe('')
    rmSync(backup)
  })

  test('installing again, or upgrading from Tether, keeps your own status line', async () => {
    const { installIntegration } = await import('./integration.ts')
    const settingsFile = join(home, '.claude/settings.json')
    const orig = join(home, '.inyon/statusline.orig')
    for (const wrapper of ['~/.inyon/statusline.sh', '~/.tether/statusline.sh']) {
      writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: 'command', command: wrapper, padding: 0 } }))
      writeFileSync(orig, 'bash ~/.claude/statusline.sh\n')
      await installIntegration(sandboxHost)
      expect(readFileSync(orig, 'utf8')).toBe('bash ~/.claude/statusline.sh\n')
      expect(JSON.parse(readFileSync(settingsFile, 'utf8')).statusLine).toEqual({ type: 'command', command: '~/.inyon/statusline.sh', padding: 0 })
    }
    // and it is what the wrapper draws
    writeFileSync(orig, 'echo my bar\n')
    const r = Bun.spawnSync(['sh', join(home, '.inyon/statusline.sh')], { stdin: Buffer.from(payload('s1')), env: { HOME: home, PATH: process.env.PATH!, TMUX_PANE: '%9' } })
    expect(r.stdout.toString().trim()).toBe('my bar')
  })
})

describe('privacy', () => {
  const mode = (p: string) => statSync(join(home, p)).mode & 0o777

  test('what the hook and status line save is readable by you only, whatever your umask', () => {
    rmSync(join(home, '.inyon'), { recursive: true, force: true })
    run(`umask 022\n${HOOK_SCRIPT}`, JSON.stringify({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'secret plan' }))
    expect(mode('.inyon')).toBe(0o700)
    expect(mode('.inyon/panes')).toBe(0o700)
    expect(mode('.inyon/events.jsonl')).toBe(0o600)
    expect(mode('.inyon/panes/9.json')).toBe(0o600)
    run(`umask 022\n${STATUS_SCRIPT}`, payload('s1'))
    expect(mode('.inyon/status')).toBe(0o700)
    expect(mode('.inyon/status/9.json')).toBe(0o600)
    // your own status line still runs with your umask
    writeFileSync(join(home, '.inyon/statusline.orig'), `touch "$HOME/mine"\n`)
    run(`umask 022\n${STATUS_SCRIPT}`, payload('s1'))
    expect(mode('mine')).toBe(0o644)
  })

  test('turning the integration on (or healing it) closes up a ~/.inyon left open', async () => {
    const { installIntegration } = await import('./integration.ts')
    Bun.spawnSync(['chmod', '755', join(home, '.inyon')])
    Bun.spawnSync(['chmod', '644', join(home, '.inyon/events.jsonl')])
    await installIntegration(sandboxHost)
    expect(mode('.inyon')).toBe(0o700)
    expect(mode('.inyon/events.jsonl')).toBe(0o600)
    expect(mode('.inyon/hook.sh')).toBe(0o700)
  })
})

describe('reconnectStatusLine', () => {
  test('adds the status line to project settings, keeps it out of git, and removes it on uninstall', async () => {
    const { reconnectStatusLine, uninstallIntegration } = await import('./integration.ts')
    const host = sandboxHost
    {
      const proj = join(home, 'proj')
      Bun.spawnSync(['git', 'init', '-q', proj], { env: { HOME: home, PATH: process.env.PATH! } })
      Bun.spawnSync(['mkdir', '-p', join(proj, '.claude')])
      writeFileSync(join(proj, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }))

      await reconnectStatusLine(host, proj)
      await reconnectStatusLine(host, proj) // idempotent
      const s = JSON.parse(readFileSync(join(proj, '.claude/settings.local.json'), 'utf8'))
      expect(s.statusLine.command).toBe('~/.inyon/statusline.sh')
      expect(s.permissions.allow).toEqual(['Bash(ls)'])
      expect(readFileSync(join(proj, '.git/info/exclude'), 'utf8').match(/settings\.local\.json/g)?.length).toBe(1)
      expect(Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: proj, env: { HOME: home, PATH: process.env.PATH! } }).stdout.toString()).toBe('')

      Bun.spawnSync(['mkdir', '-p', join(home, 'other/.claude')])
      writeFileSync(join(home, 'other/.claude/settings.local.json'), JSON.stringify({ statusLine: { type: 'command', command: 'mine.sh' } }))
      await expect(reconnectStatusLine(host, join(home, 'other'))).rejects.toThrow('own status line')

      await uninstallIntegration(host)
      const after = JSON.parse(readFileSync(join(proj, '.claude/settings.local.json'), 'utf8'))
      expect(after.statusLine).toBeUndefined()
      expect(after.permissions.allow).toEqual(['Bash(ls)'])
    }
  })
})

describe('Antigravity status line', () => {
  test('installs into agy settings with a backup, chains your own, and uninstall restores it', async () => {
    const { installIntegration, uninstallIntegration, AGY_STATUS_SCRIPT } = await import('./integration.ts')
    const dir = join(home, '.gemini/antigravity-cli')
    const file = join(dir, 'settings.json')
    const read = () => JSON.parse(readFileSync(file, 'utf8'))
    Bun.spawnSync(['mkdir', '-p', dir])
    writeFileSync(file, JSON.stringify({ model: 'Gemini 3.8 Flash (High)', trustedWorkspaces: ['/w'] }))

    // no status line of its own: keep agy's default one under ours
    await installIntegration(sandboxHost)
    expect(read().statusLine).toEqual({ type: 'command', command: '~/.inyon/agy-statusline.sh', stack_with_default: true })
    expect(read().trustedWorkspaces).toEqual(['/w'])
    expect(existsSync(`${file}.inyon-backup`)).toBe(true)
    expect(readFileSync(join(home, '.inyon/agy-statusline.sh'), 'utf8')).toBe(AGY_STATUS_SCRIPT)
    await installIntegration(sandboxHost) // idempotent
    expect(read().statusLine.command).toBe('~/.inyon/agy-statusline.sh')
    await uninstallIntegration(sandboxHost)
    expect(read().statusLine).toBeUndefined()
    expect(read().model).toBe('Gemini 3.8 Flash (High)')
    expect(existsSync(join(home, '.inyon/agy-statusline.sh'))).toBe(false)

    // your own status line keeps running behind the wrapper, and comes back on uninstall
    writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'echo mine', padding: 1 } }))
    await installIntegration(sandboxHost)
    expect(read().statusLine).toEqual({ type: 'command', command: '~/.inyon/agy-statusline.sh', padding: 1 })
    const run = Bun.spawnSync(['sh', join(home, '.inyon/agy-statusline.sh')], {
      stdin: Buffer.from('{"conversation_id":"c1",\n"agent_state":"idle"}'),
      env: { HOME: home, PATH: process.env.PATH!, TMUX_PANE: '%42' },
    })
    expect(run.stdout.toString().trim()).toBe('mine')
    expect(readFileSync(join(home, '.inyon/agy-status/42.json'), 'utf8')).toBe('{"conversation_id":"c1","agent_state":"idle"}')
    await uninstallIntegration(sandboxHost)
    expect(read().statusLine).toEqual({ type: 'command', command: 'echo mine', padding: 1 })
  })
})

test('a restart keeps a flag value with spaces in it whole, read from the real argument list', async () => {
  const { argv, resumeCommand } = await import('./actions.ts')
  const { Host } = await import('../hosts/host.ts')
  const id = '7409eef9-d507-4808-a592-0bfabe896e3a'
  // a stand-in agent started with a settings file in a folder with a space
  const proc = Bun.spawn(['sh', '-c', 'sleep 30', 'claude', '--settings', '/work/my project/settings.json', '--model', 'sonnet'])
  try {
    const host = new Host({ id: 'local', name: 'local', kind: 'local' } as any)
    // just after the spawn the process can still show the parent's arguments
    let args = await argv(host, proc.pid)
    for (let i = 0; i < 20 && args && !args.includes('--settings'); i++) await Bun.sleep(50).then(async () => (args = await argv(host, proc.pid)))
    if (process.platform === 'linux') {
      expect(resumeCommand('claude', id, args!)).toBe(`claude --resume ${id} '--settings' '/work/my project/settings.json' '--model' 'sonnet'`)
    } else expect(args).toBeUndefined()
  } finally {
    proc.kill()
  }
})

describe('moving an install from before the rename to Inyon', () => {
  test('the folder moves, the old settings count as outdated, and installing again rewrites them once', async () => {
    const { installIntegration } = await import('./integration.ts')
    const { MOVE_OLD_FOLDER_SH } = await import('./integration-sh.ts')
    const { HOOK_STATE_SH } = await import('../tmux/tmux.ts')
    const old = mkdtempSync(join(tmpdir(), 'inyon-move-'))
    const sh = (cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { env: { HOME: old, PATH: process.env.PATH! } }).stdout.toString().trim()
    const host = {
      exec: async (cmd: string, opts: { input?: string } = {}) => {
        const r = Bun.spawnSync(['sh', '-c', cmd], { stdin: opts.input === undefined ? undefined : Buffer.from(opts.input), env: { HOME: old, PATH: process.env.PATH! } })
        return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
      },
    } as any
    try {
      // what Tether 0.6 left: its folder, and settings that name it next to your own hook and status line
      sh('mkdir -p "$HOME/.tether/panes" "$HOME/.claude" && printf "#!/bin/sh\\n" > "$HOME/.tether/hook.sh" && cp "$HOME/.tether/hook.sh" "$HOME/.tether/statusline.sh" && chmod 700 "$HOME/.tether/hook.sh" "$HOME/.tether/statusline.sh" && echo "~/bin/mybar.sh" > "$HOME/.tether/statusline.orig" && echo "{}" > "$HOME/.tether/events.jsonl"')
      const mine = { type: 'command', command: '~/bin/notify.sh' }
      writeFileSync(join(old, '.claude/settings.json'), JSON.stringify({
        statusLine: { type: 'command', command: '~/.tether/statusline.sh' },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: '~/.tether/hook.sh' }] }, { hooks: [mine] }] },
      }))

      sh('mkdir -p "$HOME/.gemini/antigravity-cli" && echo "~/bin/agybar.sh" > "$HOME/.tether/agy-statusline.orig"')
      writeFileSync(join(old, '.gemini/antigravity-cli/settings.json'), JSON.stringify({ statusLine: { type: 'command', command: '~/.tether/agy-statusline.sh' } }))

      sh(MOVE_OLD_FOLDER_SH)
      expect(readFileSync(join(old, '.inyon/events.jsonl'), 'utf8')).toBe('{}\n')
      // the old path still works for whatever points at it
      expect(sh('[ -L "$HOME/.tether" ] && cat "$HOME/.tether/statusline.orig"')).toBe('~/bin/mybar.sh')
      expect(sh(HOOK_STATE_SH)).toBe('outdated')
      // running it again changes nothing
      sh(MOVE_OLD_FOLDER_SH)
      expect(sh('readlink "$HOME/.tether"')).toBe(join(old, '.inyon'))

      await installIntegration(host)
      const settings = JSON.parse(readFileSync(join(old, '.claude/settings.json'), 'utf8'))
      expect(settings.statusLine.command).toBe('~/.inyon/statusline.sh')
      // your status line is still the one it runs, not the old wrapper
      expect(readFileSync(join(old, '.inyon/statusline.orig'), 'utf8').trim()).toBe('~/bin/mybar.sh')
      const stop = settings.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command))
      expect(stop.filter((c: string) => c.includes('hook.sh'))).toEqual(['~/.inyon/hook.sh'])
      expect(stop).toContain('~/bin/notify.sh')
      expect(JSON.stringify(settings)).not.toContain('.tether/')
      expect(JSON.parse(readFileSync(join(old, '.gemini/antigravity-cli/settings.json'), 'utf8')).statusLine.command).toBe('~/.inyon/agy-statusline.sh')
      expect(readFileSync(join(old, '.inyon/agy-statusline.orig'), 'utf8').trim()).toBe('~/bin/agybar.sh')
      expect(sh(HOOK_STATE_SH)).toBe('installed')
    } finally {
      rmSync(old, { recursive: true, force: true })
    }
  })
})

test('scripts from a newer Inyon count as installed, so an older app leaves them alone', async () => {
  const { MARKER_VERSION } = await import('./integration-sh.ts')
  const { HOOK_STATE_SH } = await import('../tmux/tmux.ts')
  const h = mkdtempSync(join(tmpdir(), 'inyon-version-'))
  const sh = (cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { env: { HOME: h, PATH: process.env.PATH! } }).stdout.toString().trim()
  const scripts = (v: number) =>
    sh(`mkdir -p "$HOME/.inyon" "$HOME/.claude" && for f in hook statusline; do printf '#!/bin/sh\\n# inyon-integration ${v}\\n' > "$HOME/.inyon/$f.sh"; chmod 700 "$HOME/.inyon/$f.sh"; done`)
  try {
    scripts(MARKER_VERSION)
    writeFileSync(join(h, '.claude/settings.json'), JSON.stringify({ statusLine: { command: '~/.inyon/statusline.sh' }, hooks: { Stop: [{ hooks: [{ command: '~/.inyon/hook.sh' }] }] } }))
    expect(sh(HOOK_STATE_SH)).toBe('installed')
    scripts(MARKER_VERSION + 1)
    expect(sh(HOOK_STATE_SH)).toBe('installed')
    scripts(MARKER_VERSION - 1)
    expect(sh(HOOK_STATE_SH)).toBe('outdated')
    // version 10 is newer than 9, not older because "1" sorts before "9"
    scripts(MARKER_VERSION + 4)
    expect(sh(HOOK_STATE_SH)).toBe('installed')
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('StopFailure is only registered for a Claude Code that has it', async () => {
  const { knowsStopFailure } = await import('./integration.ts')
  expect(knowsStopFailure('2.1.309 (Claude Code)\n')).toBe(true)
  expect(knowsStopFailure('2.1.78 (Claude Code)')).toBe(true)
  expect(knowsStopFailure('3.0.0')).toBe(true)
  // before 2.1.101 an unknown event made Claude Code ignore the whole file
  expect(knowsStopFailure('2.1.77 (Claude Code)')).toBe(false)
  expect(knowsStopFailure('1.0.120 (Claude Code)')).toBe(false)
  expect(knowsStopFailure('')).toBe(false)
})
