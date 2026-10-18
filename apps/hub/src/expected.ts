// What the TS readers make of every shared capture, written to fixtures/expected/ so the Rust port
// (crates/inyon-core) is checked against exactly this. `bun src/cli/expected.ts` rewrites the
// files; expected.test.ts fails when they no longer match, so neither side can drift.
import { readdirSync, readFileSync } from 'node:fs'
import type { AgentKind, ScreenState } from '@inyon/protocol'
import { codexBrowsing, parseScreen, promptSummary } from './claude/screen.ts'

export const FIXTURES = new URL('../../../fixtures/', import.meta.url)

/** Date.now() while the readers run, so Codex's "since" (read off its spinner) is the same every time */
export const EXPECTED_NOW = 1_792_320_000_000

/** Each capture is read as the pane's own width (undefined: the widest row) and at two fixed ones */
const WIDTHS = [undefined, 80, 120] as const

const read = (path: string) => readFileSync(new URL(path, FIXTURES), 'utf8')
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null))

function pinned<T>(f: () => T): T {
  const real = Date.now
  Date.now = () => EXPECTED_NOW
  try {
    return f()
  } finally {
    Date.now = real
  }
}

/** Every capture under fixtures/screens, as "<agent>/<name>" → its rows. */
export function captures(): Map<string, { agent: AgentKind; lines: string[] }> {
  const out = new Map<string, { agent: AgentKind; lines: string[] }>()
  for (const agent of readdirSync(new URL('screens/', FIXTURES)).sort()) {
    for (const file of readdirSync(new URL(`screens/${agent}/`, FIXTURES)).sort()) {
      if (!file.endsWith('.txt')) continue
      out.set(`${agent}/${file.slice(0, -4)}`, { agent: agent as AgentKind, lines: read(`screens/${agent}/${file}`).split('\n') })
    }
  }
  return out
}

/** What one capture reads as: the screen at each width (with the prompt's one-line summary), and Codex's rewind browser. */
export function screenExpectation(agent: AgentKind, lines: string[]) {
  return pinned(() => {
    const out: Record<string, unknown> = {}
    for (const width of WIDTHS) {
      const screen = parseScreen(lines, width, agent)
      out[width === undefined ? 'auto' : String(width)] = { screen, ...(screen.prompt ? { summary: promptSummary(screen.prompt) } : {}) }
    }
    if (agent === 'codex') out.browsing = codexBrowsing(lines) ?? null
    return json(out)
  })
}

const withoutSince = ({ since: _, ...s }: ScreenState) => s

/**
 * Samples made from a capture with one edit, as the screen tests make them: the edit is recorded
 * with the sample's source so the Rust test can make the same screen.
 */
const EDITS: { capture: string; replace: [string, string] }[] = [
  // screen.test.ts, "remote control link, … and off again"
  { capture: 'antigravity/remote-control', replace: ['? for shortcuts', '> /remote-control off\n  ⎿  Remote control off. This machine is no longer reachable.\n? for shortcuts'] },
]

/**
 * The capture and width each fixtures/protocol/ServerMsg/chat-screen-*.json sample was made from:
 * the one the TS reader turns into that sample (the turn's start time aside, which depends on the
 * clock). `capture` is null when none does.
 */
export function chatScreenSources(all = captures()) {
  type Source = { sample: string; capture: string | null; width: number | null; replace?: [string, string] }
  const out: Source[] = []
  const candidates: { name: string; agent: AgentKind; lines: string[]; replace?: [string, string] }[] = [...all].map(([name, c]) => ({ name, ...c }))
  for (const e of EDITS) {
    const c = all.get(e.capture)
    if (c) candidates.push({ name: e.capture, agent: c.agent, lines: c.lines.join('\n').replace(...e.replace).split('\n'), replace: e.replace })
  }
  for (const file of readdirSync(new URL('protocol/ServerMsg/', FIXTURES)).sort()) {
    if (!/^chat-screen-.*\.json$/.test(file)) continue
    const msg = JSON.parse(read(`protocol/ServerMsg/${file}`))
    const want = JSON.stringify(withoutSince(msg.screen))
    const agent = file.replace(/^chat-screen-/, '').split('-')[0]
    let found: Omit<Source, 'sample'> | undefined
    for (const c of candidates) {
      if (c.agent !== agent || found) continue
      for (const width of [msg.screen.width, undefined]) {
        const got = pinned(() => json(parseScreen(c.lines, width, c.agent)))
        if (JSON.stringify(withoutSince(got)) === want) {
          found = { capture: c.name, width: width ?? null, ...(c.replace && { replace: c.replace }) }
          break
        }
      }
    }
    out.push({ sample: file, ...(found ?? { capture: null, width: null }) })
  }
  return out
}

/** Every file under fixtures/expected, by its path there, with what it should hold. */
export function expectedFiles(): Map<string, unknown> {
  const all = captures()
  const files = new Map<string, unknown>()
  for (const [name, c] of all) files.set(`screens/${name}.json`, screenExpectation(c.agent, c.lines))
  files.set('chat-screen.json', chatScreenSources(all))
  return files
}

export const format = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
