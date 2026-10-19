import type { RateWindow } from '@inyon/protocol'
import { Host } from '../hosts/host.ts'

/**
 * Plan limits for the account a machine is signed in to, from the same endpoint Claude Code's
 * /usage reads. Runs on that machine with its own Claude login: the token is read there, handed
 * to curl on stdin (so it never shows in `ps`), and never comes back to the hub.
 */
export const SCRIPT = `
d="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
tok=""
[ -f "$d/.credentials.json" ] && tok=$(sed -n 's/.*"accessToken" *: *"\\([^"]*\\)".*/\\1/p' "$d/.credentials.json" | head -n 1)
if [ -z "$tok" ] && command -v security >/dev/null 2>&1; then
  tok=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | sed -n 's/.*"accessToken" *: *"\\([^"]*\\)".*/\\1/p')
fi
[ -n "$tok" ] || { echo "@@NOLOGIN"; exit 0; }
# only the plan fields leave the machine, never the token
c="$d/.credentials.json"
[ -f "$c" ] && echo "@@PLAN $(sed -n 's/.*"subscriptionType" *: *"\\([^"]*\\)".*/\\1/p' "$c" | head -n 1) $(sed -n 's/.*"rateLimitTier" *: *"\\([^"]*\\)".*/\\1/p' "$c" | head -n 1)"
command -v curl >/dev/null 2>&1 || { echo "@@NOCURL"; exit 0; }
printf 'Authorization: Bearer %s\\n' "$tok" | curl -sS -m 10 -H @- -H 'anthropic-beta: oauth-2025-04-20' https://api.anthropic.com/api/oauth/usage
`

export interface AccountUsage {
  fiveHour?: RateWindow
  sevenDay?: RateWindow
  /** unix ms */
  at: number
  error?: string
  /** "Max 20x", "Pro", … */
  plan?: string
}

/** subscriptionType + rateLimitTier from the login file, e.g. max + default_claude_max_20x → "Max 20x" */
export function planLabel(sub?: string, tier?: string) {
  if (!sub) return
  const name = sub.charAt(0).toUpperCase() + sub.slice(1).toLowerCase()
  const x = tier?.match(/_(\d+x)$/)?.[1]
  return x && sub.toLowerCase() === 'max' ? `${name} ${x}` : name
}

const unix = (v: unknown) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? undefined : Math.round(t / 1000)
}
const win = (w: any): RateWindow | undefined =>
  w && typeof w.utilization === 'number' ? { pct: w.utilization, resetsAt: unix(w.resets_at) } : undefined

export async function fetchClaudeUsage(host: Host): Promise<AccountUsage> {
  const r = await host.exec(SCRIPT, { timeoutMs: 15000 })
  const m = r.stdout.match(/^@@PLAN ?(\S*) ?(\S*)$/m)
  const plan = planLabel(m?.[1] || undefined, m?.[2] || undefined)
  const out = r.stdout.replace(/^@@PLAN.*$/m, '').trim()
  if (out.includes('@@NOLOGIN')) return { at: Date.now(), error: 'Not signed in to a Claude subscription' }
  if (out.includes('@@NOCURL')) return { at: Date.now(), error: 'curl is not installed' }
  try {
    const d = JSON.parse(out)
    if (d?.error) return { at: Date.now(), error: d.error.message ?? 'Usage request failed' }
    return { fiveHour: win(d.five_hour), sevenDay: win(d.seven_day), at: Date.now(), plan }
  } catch {
    return { at: Date.now(), error: (r.stderr || out || 'Usage request failed').trim().slice(0, 200) }
  }
}
