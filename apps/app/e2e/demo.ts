// Made-up machines and sessions for the app's browser checks: nothing from a real account.
export function overview(now = Date.now()) {
  const s = Math.floor(now / 1000)
  const limits = { fiveHour: { pct: 22, resetsAt: s + 2 * 3600 + 900 }, sevenDay: { pct: 41, resetsAt: s + 3 * 86400 } }
  let n = 10
  const pane = (title: string, cwd: string, command: string, agent: Record<string, unknown>) => {
    n++
    return { id: `%${n}`, index: 0, active: true, command, cwd, title, width: 80, height: 40, dead: false, agent: { pid: 4000 + n, startedAt: now - 3600_000, mappedBy: 'hook', ...agent } }
  }
  const session = (name: string, win: string, p: ReturnType<typeof pane>, ago: number) => ({
    id: `$${n}`,
    name,
    attached: 0,
    windows: [{ id: `@${n}`, index: 1, name: win, active: true, activity: s - ago, panes: [p] }],
  })
  const host = (id: string, name: string, kind: string, sessions: unknown[], extra: Record<string, unknown> = {}) => ({
    config: { id, name, kind },
    status: 'online',
    hostname: name,
    integration: 'installed',
    tmux: 'ok',
    agents: ['claude', 'codex', 'opencode'],
    os: 'Linux',
    latencyMs: 38,
    sessions,
    updatedAt: now,
    lastSeen: now,
    ...extra,
  })
  return {
    t: 'overview',
    hosts: [
      host('local', 'studio', 'local', [
        session('storefront', 'claude', pane('✳ Fix flaky checkout test', '/home/sam/code/storefront', 'claude', {
          kind: 'claude', state: 'working', activity: 'Running the checkout suite… (2m 14s · ↓ 3.1k tokens)',
          status: { model: 'Sonnet 5.5', effort: 'medium', contextPct: 6.1, contextUsed: 61200, contextSize: 1000000, costUsd: 3.42, updatedAt: now - 4000, ...limits },
        }), 3),
        session('accounts', 'codex', pane('Migrate auth to passkeys', '/home/sam/code/accounts', 'node', {
          kind: 'codex', state: 'waiting', waitingFor: 'Run bun test src/auth?', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }],
          status: { model: 'GPT-6-Astra', effort: 'medium', contextPct: 18.7, contextUsed: 48300, contextSize: 258400, sevenDay: { pct: 27, resetsAt: s + 5 * 86400 }, updatedAt: now - 9000 },
        }), 40),
      ], { machineKind: 'server' }),
      host('build-box', 'build-box', 'node', [
        session('docs', 'claude', pane('✳ Write release notes', '/home/sam/code/docs-site', 'claude', {
          kind: 'claude', state: 'idle',
          status: { model: 'Opus 5.5', effort: 'high', contextPct: 9.2, contextUsed: 92400, contextSize: 1000000, costUsd: 1.86, updatedAt: now - 60000 },
        }), 260),
        session('billing', 'opencode', pane('Tidy the billing API types', '/home/sam/code/billing', 'opencode', {
          kind: 'opencode', state: 'idle', background: '1 shell',
          status: { model: 'Qwen3 Coder', contextPct: 11.6, contextUsed: 30500, contextSize: 262144, costUsd: 0.74, updatedAt: now - 60000 },
        }), 900),
      ], { machineKind: 'laptop', nodeVersion: '0.23.1' }),
    ],
  }
}
