import { shq, type Host } from '../hosts/host.ts'

/**
 * The keys Inyon presses in OpenCode's terminal, as OpenCode 1.19 binds them unless the config
 * says otherwise (`keybinds` in opencode.json, user or project). A machine with its own bindings
 * would otherwise get Tab typed into a box where Tab means something else.
 */
export const DEFAULT_KEYS = {
  leader: 'ctrl+x',
  agent_cycle: 'tab',
  agent_cycle_reverse: 'shift+tab',
  variant_cycle: 'ctrl+t',
  model_list: '<leader>m',
  session_interrupt: 'escape',
}
export type KeyName = Exclude<keyof typeof DEFAULT_KEYS, 'leader'>
export type OpenCodeKeys = Record<KeyName, string[]>

const NAMED: Record<string, string> = {
  tab: 'Tab', escape: 'Escape', esc: 'Escape', return: 'Enter', enter: 'Enter', space: 'Space', backspace: 'BSpace',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
}

/**
 * One binding as OpenCode writes it ("ctrl+t", "shift+tab", "<leader>m", "f2"; alternatives
 * separated by commas) as the keys `tmux send-keys` takes, or undefined when none of its
 * alternatives can be sent that way (super, shift with most keys).
 */
export function tmuxKeys(binding: string, leader = DEFAULT_KEYS.leader): string[] | undefined {
  for (const alt of binding.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (alt === 'none') continue
    if (alt.startsWith('<leader>')) {
      const first = tmuxKeys(leader)
      const rest = tmuxKeys(alt.slice('<leader>'.length), leader)
      if (first && rest) return [...first, ...rest]
      continue
    }
    const parts = alt.split('+')
    const key = parts.pop()!
    const mods = new Set(parts)
    if (mods.has('super') || mods.has('cmd') || mods.has('meta')) continue
    let name: string | undefined
    if (NAMED[key]) name = NAMED[key]
    else if (/^f([1-9]|1[0-2])$/.test(key)) name = key.toUpperCase()
    else if (/^[a-z0-9]$/.test(key)) name = key
    if (!name) continue
    if (mods.has('shift')) {
      if (name === 'Tab') name = 'BTab'
      else if (/^[a-z]$/.test(name)) name = name.toUpperCase()
      else continue
    }
    const ctrl = mods.has('ctrl') || mods.has('control')
    const alt_ = mods.has('alt') || mods.has('option')
    if ((ctrl || alt_) && !/^[a-zA-Z0-9]$/.test(name)) continue
    return [`${ctrl ? 'C-' : ''}${alt_ ? 'M-' : ''}${name}`]
  }
  return undefined
}

/** `keybinds` from the files OpenCode reads (user, then the project's), later ones winning. */
export function mergeKeybinds(files: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const text of files) {
    const config = parseJsonc(text)
    const binds = config && typeof config === 'object' ? (config as any).keybinds : undefined
    if (!binds || typeof binds !== 'object') continue
    for (const [k, v] of Object.entries(binds)) if (typeof v === 'string') out[k] = v
  }
  return out
}

/** JSON with comments and trailing commas, as opencode.jsonc allows; undefined when it doesn't parse. */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else {
      out += ch
      i++
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return undefined
  }
}

/** The keys to press for each action, from the bindings (defaults filled in). */
export function keysFrom(binds: Record<string, string>): OpenCodeKeys {
  const leader = binds.leader ?? DEFAULT_KEYS.leader
  const out = {} as OpenCodeKeys
  for (const name of Object.keys(DEFAULT_KEYS) as (keyof typeof DEFAULT_KEYS)[]) {
    if (name === 'leader') continue
    out[name] = tmuxKeys(binds[name] ?? DEFAULT_KEYS[name], leader) ?? tmuxKeys(DEFAULT_KEYS[name])!
  }
  return out
}

const cache = new Map<string, { at: number; keys: Promise<OpenCodeKeys> }>()

/** OpenCode's key bindings on a machine, for a session in `cwd`; read again after a minute. */
export function opencodeKeys(host: Pick<Host, 'id' | 'exec'>, cwd?: string): Promise<OpenCodeKeys> {
  const key = `${host.id}\0${cwd ?? ''}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.keys
  const files = ['"${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"', '"${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.jsonc"']
  if (cwd) files.push(`${shq(cwd)}/opencode.json`, `${shq(cwd)}/opencode.jsonc`, `${shq(cwd)}/.opencode/opencode.json`, `${shq(cwd)}/.opencode/opencode.jsonc`)
  const keys = host
    .exec(`for f in ${files.join(' ')}; do [ -f "$f" ] && { echo "@@FILE"; cat "$f"; echo; }; done; true`, { timeoutMs: 10_000 })
    .then((r) => keysFrom(mergeKeybinds(r.stdout.split('@@FILE\n').slice(1))))
    .catch(() => keysFrom({}))
  cache.set(key, { at: Date.now(), keys })
  if (cache.size > 200) for (const [k, v] of cache) if (Date.now() - v.at > 60_000) cache.delete(k)
  return keys
}
