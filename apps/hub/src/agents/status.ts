import type { AgentStatus } from '@inyon/protocol'
import type { ProbeResult } from '../tmux/tmux.ts'

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Claude Code's status line payload → AgentStatus. */
export function statusFromClaude(d: any, ts: number): AgentStatus {
  const cw = d?.context_window ?? {}
  const cu = cw.current_usage ?? {}
  const used = num(cu.input_tokens) !== undefined
    ? (cu.input_tokens ?? 0) + (cu.cache_creation_input_tokens ?? 0) + (cu.cache_read_input_tokens ?? 0)
    : undefined
  const rl = d?.rate_limits ?? {}
  const win = (w: any) => (w && num(w.used_percentage) !== undefined ? { pct: w.used_percentage, resetsAt: toUnix(w.resets_at) } : undefined)
  return {
    model: d?.model?.display_name,
    modelId: d?.model?.id,
    effort: d?.effort?.level,
    fast: !!d?.fast_mode,
    version: d?.version,
    contextPct: num(cw.used_percentage),
    contextUsed: used,
    contextSize: num(cw.context_window_size),
    costUsd: num(d?.cost?.total_cost_usd),
    durationMs: num(d?.cost?.total_duration_ms),
    apiDurationMs: num(d?.cost?.total_api_duration_ms),
    linesAdded: num(d?.cost?.total_lines_added),
    linesRemoved: num(d?.cost?.total_lines_removed),
    fiveHour: win(rl.five_hour),
    sevenDay: win(rl.seven_day),
    outputStyle: d?.output_style?.name,
    updatedAt: ts * 1000,
  }
}

/**
 * The status line snapshot Claude last wrote for a pane, minus anything that is no longer true.
 * The file stays behind when Claude stops writing it, so every number has to earn its place.
 */
export function claudeStatus(pr: Pick<ProbeResult, 'integration' | 'statusPanes' | 'compactPanes'>, pane: string, startedAt: number, sessionId?: string): AgentStatus | undefined {
  const st = pr.statusPanes.get(pane)
  // Claude only writes it while the integration is in its settings; otherwise it's a leftover
  if (!st || pr.integration !== 'installed') return undefined
  // from an earlier process in this pane, or from before a /clear or /resume
  if (st.ts < startedAt - 5) return undefined
  if (sessionId && st.data?.session_id && st.data.session_id !== sessionId) return undefined
  const status = statusFromClaude(st.data, st.ts)
  // limits belong to the account, not the session: after /login they describe someone else
  if (st.account && st.accountNow && st.account !== st.accountNow) {
    status.fiveHour = status.sevenDay = undefined
    status.stale = { ...status.stale, limits: 'account' }
  }
  // the snapshot predates the last compaction, so its context size is the pre-compaction one
  const compacted = pr.compactPanes.get(pane)
  if (compacted && compacted >= startedAt - 5 && compacted > st.ts) {
    status.contextPct = status.contextUsed = undefined
    status.stale = { ...status.stale, context: 'compacted' }
  }
  return status
}

function toUnix(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 1e12 ? Math.round(v / 1000) : v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : Math.round(t / 1000)
  }
  return undefined
}

/** Codex token_count event (+ the turn's model/effort) → AgentStatus. */
export function statusFromCodex(ev: any, ctx: { model?: string; effort?: string }, tsMs: number): AgentStatus {
  const info = ev?.info ?? {}
  const last = info.last_token_usage ?? {}
  const size = num(info.model_context_window)
  const used = num(last.input_tokens) !== undefined ? (last.input_tokens ?? 0) + (last.output_tokens ?? 0) : undefined
  const rl = ev?.rate_limits ?? {}
  const win = (w: any) =>
    w && num(w.used_percent) !== undefined
      ? { pct: w.used_percent, resetsAt: num(w.resets_in_seconds) !== undefined ? Math.round(tsMs / 1000 + w.resets_in_seconds) : toUnix(w.resets_at) }
      : undefined
  const credits = rl.credits && (rl.credits.has_credits || rl.credits.unlimited) ? { balance: rl.credits.balance ?? undefined, unlimited: !!rl.credits.unlimited } : undefined
  return {
    model: ctx.model,
    modelId: ctx.model,
    effort: ctx.effort,
    credits,
    plan: typeof rl.plan_type === 'string' ? rl.plan_type : undefined,
    contextUsed: used,
    contextSize: size,
    contextPct: used !== undefined && size ? Math.min(100, (used / size) * 100) : undefined,
    // Some subscription plans expose only a weekly primary bucket.
    fiveHour: win([rl.primary, rl.secondary].find((w) => w?.window_minutes === 300) ?? (rl.primary?.window_minutes == null ? rl.primary : undefined)),
    sevenDay: win([rl.primary, rl.secondary].find((w) => w?.window_minutes === 10080) ?? (rl.secondary?.window_minutes == null ? rl.secondary : undefined)),
    updatedAt: tsMs,
  }
}
