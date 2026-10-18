// Captured screens and transcripts for parser tests, in the repo's top-level fixtures/ folder
// (the Rust tests read the same files).
import { readFileSync } from 'node:fs'

/** A fixture's text, by its path under fixtures/ ("screens/codex/queued.txt"). */
export const fixture = (path: string) => readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), 'utf8')

/** A captured screen as the rows tmux printed: screens/<agent>/<name>.txt */
export const screenFixture = (agent: string, name: string) => fixture(`screens/${agent}/${name}.txt`).split('\n')
