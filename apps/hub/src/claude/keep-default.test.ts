import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host, setHostBackends, type HostBackend } from '../hosts/host.ts'
import { processBackend } from '../hosts/process-backend.ts'
import { keepClaudeDefaults, restoreKeys, setKey, topMembers } from './keep-default.ts'

const root = mkdtempSync(join(tmpdir(), 'inyon-keep-'))
const savedDir = process.env.CLAUDE_CONFIG_DIR
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  if (savedDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedDir
})

describe('editing one key', () => {
  const file = '{\n  "model": "opus",\n  "env": { "A": "é ✓" },\n  "hooks": {"Stop": [{"x": "}"}]}\n}\n'

  test('finds the top-level members, strings with braces and all', () => {
    expect(topMembers(file)?.members.map((m) => m.key)).toEqual(['model', 'env', 'hooks'])
    expect(topMembers('[1]')).toBeUndefined()
    expect(topMembers('{"a": 1,}')).toBeUndefined()
    expect(topMembers('{"a" 1}')).toBeUndefined()
  })

  test('sets a value and leaves every other byte alone', () => {
    expect(setKey(file, 'model', '"sonnet"')).toBe(file.replace('"opus"', '"sonnet"'))
    expect(setKey('{"a":1,"model":"x"}\r\n', 'model', '"y"')).toBe('{"a":1,"model":"y"}\r\n')
  })

  test('removes a key wherever it sits', () => {
    expect(setKey(file, 'model', undefined)).toBe('{\n  "env": { "A": "é ✓" },\n  "hooks": {"Stop": [{"x": "}"}]}\n}\n')
    expect(setKey(file, 'hooks', undefined)).toBe('{\n  "model": "opus",\n  "env": { "A": "é ✓" }\n}\n')
    expect(setKey('{\n  "model": "sonnet"\n}\n', 'model', undefined)).toBe('{}\n')
    expect(setKey(file, 'missing', undefined)).toBe(file)
  })

  test('adds a key back in front, indented like the rest', () => {
    expect(setKey('{\n  "theme": "dark"\n}', 'model', '"opus"')).toBe('{\n  "model": "opus",\n  "theme": "dark"\n}')
    expect(setKey('{}', 'model', '"opus"')).toBe('{\n  "model": "opus"\n}')
  })

  test('puts back only the keys that changed', () => {
    const before = new Map([['model', '"opus"'], ['effortLevel', undefined], ['modelSettings', undefined]])
    expect(restoreKeys('{\n  "model": "opus",\n  "theme": "dark"\n}', before)).toBeUndefined()
    const after = '{\n  "model": "sonnet",\n  "theme": "dark",\n  "modelSettings": {\n    "claude-sonnet-5-5": {\n      "effortLevel": "high"\n    }\n  }\n}\n'
    expect(restoreKeys(after, before)).toBe('{\n  "model": "opus",\n  "theme": "dark"\n}\n')
    // the same value written with other spacing is no change
    expect(restoreKeys('{"model":"opus","modelSettings":{"a":{"effortLevel":"low"}}}', new Map([['model', '"opus"'], ['modelSettings', '{ "a": { "effortLevel": "low" } }']]))).toBeUndefined()
  })
})

// Windows machines run commands in busybox-w32's sh: the same scripts, with only busybox's tools
const busybox = Bun.which('busybox')
const tools = join(root, 'busybox-bin')
if (busybox) {
  mkdirSync(tools)
  for (const t of ['sh', 'cat', 'cksum', 'md5sum', 'od', 'tr', 'cp', 'mv', 'rm']) symlinkSync(busybox, join(tools, t))
  const local = processBackend(join(root, 'cm'))
  const viaBusybox: HostBackend = {
    ...local,
    exec: (c, cmd, opts) => local.exec(c, `PATH=${tools}; ${cmd}`, opts),
  }
  setHostBackends((c) => (c.id === 'keep-busybox' ? viaBusybox : local))
}

describe.each([['sh', 'keep-test'], ...(busybox ? [['busybox', 'keep-busybox']] : [])])('keeping the default on the machine (%s)', (_shell, id) => {
  const host = new Host({ id, name: 'keep', kind: 'local' } as any)
  let dir = ''
  let n = 0
  beforeEach(() => {
    dir = join(root, `cfg-${id}-${n++}`)
    mkdirSync(dir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = dir
  })
  const settings = () => join(dir, 'settings.json')
  const fast = { windowMs: 2500, graceMs: 300, pollMs: 50 }

  /** What Claude Code does on /model sonnet: rewrites the whole file with its own formatting. */
  const claudeWrites = (obj: any) => writeFileSync(settings(), JSON.stringify(obj, null, 2))

  test('puts the model back after Claude Code saves the switch, keeping the rest byte for byte', async () => {
    const original = '{\r\n    "model": "opus",\r\n    "statusLine": {"type": "command", "command": "~/.inyon/statusline.sh"},\r\n    "note": "héllo ✓ 日本"\r\n}\r\n'
    writeFileSync(settings(), original)
    chmodSync(settings(), 0o644)
    const { done } = await keepClaudeDefaults(host, fast)
    writeFileSync(settings(), original.replace('"opus"', '"sonnet"'))
    await done
    expect(readFileSync(settings(), 'utf8')).toBe(original)
    expect(statSync(settings()).mode & 0o777).toBe(0o644)
    expect(existsSync(settings() + '.inyon-tmp')).toBe(false)
  })

  test('removes a key that was not set before, effort included', async () => {
    writeFileSync(settings(), '{\n  "theme": "dark"\n}\n')
    const { done } = await keepClaudeDefaults(host, fast)
    claudeWrites({ theme: 'dark', model: 'sonnet', modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'high' } } })
    await done
    expect(JSON.parse(readFileSync(settings(), 'utf8'))).toEqual({ theme: 'dark' })
  })

  test('a settings file Claude Code creates loses only those keys', async () => {
    const { done } = await keepClaudeDefaults(host, fast)
    claudeWrites({ model: 'sonnet' })
    await done
    expect(JSON.parse(readFileSync(settings(), 'utf8'))).toEqual({})
  })

  test('a later write by Claude Code is caught too, and a second switch keeps the first values', async () => {
    writeFileSync(settings(), '{"model":"opus"}')
    const { done } = await keepClaudeDefaults(host, { ...fast, graceMs: 1500 })
    claudeWrites({ model: 'sonnet' })
    await Bun.sleep(400)
    expect(JSON.parse(readFileSync(settings(), 'utf8')).model).toBe('opus')
    await keepClaudeDefaults(host, fast)
    claudeWrites({ model: 'haiku', effortLevel: 'low' })
    await done
    expect(JSON.parse(readFileSync(settings(), 'utf8'))).toEqual({ model: 'opus' })
  })

  test('writes through a symlinked settings.json', async () => {
    const real = join(dir, 'dotfiles-settings.json')
    writeFileSync(real, '{"model": "opus"}\n')
    symlinkSync(real, settings())
    const { done } = await keepClaudeDefaults(host, fast)
    writeFileSync(real, '{"model": "sonnet"}\n')
    await done
    expect(lstatSync(settings()).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe('{"model": "opus"}\n')
  })

  test('leaves a file it cannot read as JSON alone', async () => {
    writeFileSync(settings(), '{"model": "opus", // comment\n}')
    const { done } = await keepClaudeDefaults(host, fast)
    await done
    expect(readFileSync(settings(), 'utf8')).toBe('{"model": "opus", // comment\n}')
  })

  test('nothing changes when the pick was for this session only', async () => {
    writeFileSync(settings(), '{"model": "opus"}')
    const before = statSync(settings()).mtimeMs
    const { done } = await keepClaudeDefaults(host, { ...fast, windowMs: 400 })
    await done
    expect(readFileSync(settings(), 'utf8')).toBe('{"model": "opus"}')
    expect(statSync(settings()).mtimeMs).toBe(before)
  })
})
