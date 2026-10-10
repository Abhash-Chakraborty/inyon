import { copilotAuthScript } from './copilot-rpc-sh.ts'

import { AGENTS, AGENT_KINDS, type AgentKind } from '@tether/protocol'

const file = (f: string) => f.replace(/^~/, '"$HOME"')

/**
 * A shell test that succeeds when the agent has a saved sign-in on the machine. Only checks that
 * files exist (or name a key); nothing is read out. Kept free of other hub imports so the probe
 * can use it.
 */
export function signedInTest(kind: AgentKind): string {
  if (kind === 'copilot') {
    const quoted = "'" + copilotAuthScript.replace(/'/g, "'\\''") + "'"
    return `node -e ${quoted} >/dev/null 2>&1`
  }
  if (kind === 'claude') {
    // ~/.claude.json exists from the first run; it only names an account once someone signed in (macOS keeps the token in the Keychain)
    const d = '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"'
    const cfg = '"${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"'
    return `{ [ -s ${d}/.credentials.json ] || grep -q '"oauthAccount"' ${cfg} 2>/dev/null; }`
  }
  // a saved Google sign-in, or API-key mode ("modelProvider": "gemini" plus GEMINI_API_KEY in its environment)
  if (kind === 'antigravity') return `{ [ -s ${file(AGENTS.antigravity.authFiles[0])} ] || grep -qs '"modelProvider"' "$HOME/.gemini/antigravity-cli/settings.json"; }`
  if (kind === 'gemini') return `{ ${AGENTS.gemini.authFiles.map((f) => `[ -s ${file(f)} ]`).join(' || ')} || grep -qs GEMINI_API_KEY "$HOME/.gemini/.env"; }`
  // OpenCode's free Zen models need no sign-in: once it has run (its database exists) it can work
  if (kind === 'opencode') return `{ [ -e ${file(AGENTS.opencode.authFiles[0])} ] || [ -e "$HOME/.local/share/opencode/opencode.db" ]; }`
  return `{ ${AGENTS[kind].authFiles.map((f) => `[ -e ${file(f)} ]`).join(' || ')}; }`
}

/** Prints the agents that are signed in, space-separated. */
export const SIGNED_IN_SH = `printf '%s' "${AGENT_KINDS.map((k) => `$(${k === 'copilot' ? cached(signedInTest(k)) : signedInTest(k)} && printf '${k} ')`).join('')}"`

/**
 * Copilot's check starts node (about a second), too slow for every poll: its answer is kept for
 * five minutes, and asked again as soon as Copilot's config changes (a sign-in or sign-out).
 */
function cached(test: string): string {
  const c = '"$HOME/.tether/.copilot-signed-in"'
  return `{ if [ -f ${c} ] && [ -z "$(find ${c} -mmin +5 2>/dev/null)" ] && [ ! "$HOME/.copilot/config.json" -nt ${c} ]; then [ "$(cat ${c})" = 1 ]; elif ${test}; then mkdir -p "$HOME/.tether" && echo 1 > ${c}; else mkdir -p "$HOME/.tether" && echo 0 > ${c}; false; fi; }`
}
