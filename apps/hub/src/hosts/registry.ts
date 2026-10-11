import { opencodeLive } from '../agents/opencode-controls.ts'
import { modelFromFooter, opencodeCliModels, peekOpenCodeModels, withoutProvider } from '../agents/opencode-models.ts'
import { AGENTS, type AgentPaneInfo, type AgentStatus, type HostConfig, type HostState, type PaneInfo, type ScreenState, type SessionInfo } from '@tether/protocol'
import { loadHosts, loadSettings, saveHosts } from '../config.ts'
import { keyPart, kv } from '../platform/store.ts'
import { Host, shq } from './host.ts'
import { capturePanes, guessTranscript, probe, type ProbeResult } from '../tmux/tmux.ts'
import { parseScreen } from '../claude/screen.ts'
import { isDriving } from '../claude/driving.ts'
import { claudeStatus } from '../agents/status.ts'
import { fetchClaudeUsage, type AccountUsage } from '../agents/claude-usage.ts'
import { codexStatus, codexTitle, guessCodexRollout } from '../agents/codex.ts'
import { guessCopilotSession } from '../agents/copilot.ts'
import { guessGeminiSession } from '../agents/gemini.ts'
import { agyStatus, agyTranscript } from '../agents/antigravity.ts'
import { opencodeEndpoint } from '../agents/opencode.ts'
import { OCDB, guessOpenCodeSession, ocdbSession } from '../agents/opencode-db.ts'
import { LiveTmux } from '../tmux/live.ts'
import { nodeLinks } from './node-link.ts'
import { nodeUpdates } from './node-update.ts'
import { bareTitle, nameTaken, ownsTitle, pendingName, sessionName } from './names.ts'
import { pruneChats } from '../claude/chat-cache.ts'
import { untilStdinCloses } from '../claude/transcript-tail.ts'

/** Fallback poll; tmux control mode delivers changes as they happen. */
const POLL_MS = 4000
/** while nobody is looking (the phone app in the background), poll much less: it costs battery and data */
const QUIET_POLL_MS = 20000
let pollMs = POLL_MS
const MAX_BACKOFF_MS = 20000

export type RegistryEvent =
  | { type: 'overview' }
  | { type: 'notify'; host: string; pane: string; kind: 'waiting' | 'done' | 'offline' | 'online'; title: string; body: string; agent?: string }
  | { type: 'hook'; host: string; pane: string; event: any }
  | { type: 'pane-output'; host: string; pane: string }
  /** a rename waits for this agent, which is idle now */
  | { type: 'rename-due'; host: string; pane: string }

interface Runtime {
  /** each agent's state when the machine went offline, kept to compare with once it's back */
  beforeOutage?: Map<string, { kind: string; state: string }>
  /** the "offline" notification went out for the current outage */
  offlineNotified?: boolean
  /** last snapshot written to disk (JSON of the sessions) and when */
  savedSnapshot?: string
  savedAt?: number
  host: Host
  state: HostState
  probe?: ProbeResult
  timer?: ReturnType<typeof setTimeout>
  failures: number
  polling: boolean
  pollAgain: boolean
  events?: { kill(): void }
  /** agent pid → transcript found without hooks (by folder, resume id or Codex rollout) */
  cwdMap: Map<number, { path?: string; at: number; title?: string }>
  /** agent pid → status read from its transcript (Codex) */
  statusCache: Map<number, { status?: AgentStatus; permission?: string; at: number }>
  stopped: boolean
  /** last time the agy status line was put back */
  agyHealedAt?: number
  codexHealedAt?: number
  live?: LiveTmux
  /** panes with fresh output, re-read on a short debounce */
  dirty: Set<string>
  dirtyTimer?: ReturnType<typeof setTimeout>
  /** last screen per agent pane, for deciding whether a restart is safe */
  screens: Map<string, ScreenState>
  /** when the integration was last put back automatically */
  healedAt?: number
  /** sessions already resumed automatically (once each, so a failure can't loop) */
  resumed: Set<string>
  /** sessions already reconnected through their project settings, and when */
  reconnected: Map<string, number>
  /** plan limits for the signed-in Claude account, read the way /usage does */
  /** `at` is the last attempt, `okAt` the last success, whose numbers are kept through errors */
  usage?: AccountUsage & { account?: string; okAt?: number }
  usageLoading?: boolean
}

/** a transcript this far ahead of the status line means the session stopped reporting */
const STALL_S = 90
/** account limits: refresh every minute, retry a failure after five, ignore after ten */
// the usage endpoint rate-limits; Claude's own /usage is only asked when you open it
const USAGE_EVERY_MS = 3 * 60_000
const USAGE_RETRY_MS = 5 * 60_000
const USAGE_STALE_MS = 20 * 60_000
/** don't fight a tool that keeps rewriting settings.json */
const HEAL_EVERY_MS = 10 * 60_000

/** a machine that stops answering for this long gets an "offline" notification */
const OFFLINE_NOTIFY_MS = 60_000

/**
 * Whether to say a machine is offline. On the phone, the app's own connection drops whenever it's in
 * the background or the phone has no signal, which says nothing about the machine: no alerts then,
 * and the minute starts over when the app is back.
 */
export function offlineAlertDue(o: { since?: number; notified?: boolean; now: number; held: boolean; heldUntil: number; online: boolean }) {
  if (!o.since || o.notified || o.held || !o.online) return false
  return o.now - Math.max(o.since, o.heldUntil) >= OFFLINE_NOTIFY_MS
}
const snapshotKey = (id: string) => `snapshots/${keyPart(id)}`

/** The last state seen from a machine, so it still shows its sessions while it's unreachable. */
function loadSnapshot(id: string): HostState | undefined {
  return kv.get<HostState>(snapshotKey(id))
}
function saveSnapshot(state: HostState) {
  try {
    kv.set(snapshotKey(state.config.id), { ...state, config: publicConfig(state.config) })
  } catch (e) {
    console.error('snapshot:', (e as Error).message)
  }
}

/** Sessions as last seen: nothing is known to be running or waiting any more. */
function offlineSessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.map((s) => ({
    ...s,
    windows: s.windows.map((w) => ({ ...w, panes: w.panes.map((p) => (p.agent ? { ...p, agent: { ...p.agent, state: 'unknown' as const, waitingFor: undefined } } : p)) })),
  }))
}

export const paneTitle = (p: PaneInfo) => p.title.replace(/^[^\w\s]\s+/u, '').trim()

/** What a machine reached through tether-node is waiting on. */
const waitingFor = (c: HostConfig) =>
  nodeLinks.why(c.id) ?? (c.kind === 'link' ? `Connecting to ${c.name}…` : 'Waiting for the machine to connect (is tether-node running?)')

class Registry {
  private hosts = new Map<string, Runtime>()
  private listeners = new Set<(e: RegistryEvent) => void>()
  /** offline alerts are held while the phone app is hidden; this is when they were last released */
  private alertsHeld = false
  private alertsFrom = 0

  start() {
    for (const c of loadHosts()) {
      // tokens made before they expired: their day starts now
      if (c.kind === 'node' && !c.pairedAt && c.tokenHash && !c.tokenIssuedAt) c.tokenIssuedAt = Date.now()
      this.add(c, false)
    }
    // a tether-node machine (re)connected or dropped: re-probe it right away
    nodeLinks.onChange((id, up) => {
      const rt = this.hosts.get(id)
      if (!rt) return
      if (!up) {
        rt.live?.stop()
        rt.events = undefined
        this.markDown(rt, 'connecting', waitingFor(rt.host.config))
        this.emit({ type: 'overview' })
      }
      this.refresh(id, up ? 100 : 1000)
    })
    // a tether-node update started, progressed or finished
    nodeUpdates.onChange(() => this.emit({ type: 'overview' }))
  }

  on(fn: (e: RegistryEvent) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: RegistryEvent) {
    for (const fn of this.listeners) fn(e)
  }

  configs(): HostConfig[] {
    return [...this.hosts.values()].map((r) => r.host.config)
  }

  overview(): HostState[] {
    return [...this.hosts.values()].map((r) => ({ ...r.state, config: publicConfig(r.state.config), nodeUpdate: nodeUpdates.view(r.state) }))
  }

  get(id: string) {
    return this.hosts.get(id)
  }

  host(id: string): Host {
    const r = this.hosts.get(id)
    if (!r) throw new HttpError(404, 'Unknown machine')
    return r.host
  }

  findPane(hostId: string, paneId: string) {
    const r = this.hosts.get(hostId)
    if (!r) return undefined
    for (const s of r.state.sessions)
      for (const w of s.windows)
        for (const p of w.panes) if (p.id === paneId) return { session: s, window: w, pane: p, home: r.probe?.home }
    return undefined
  }

  add(config: HostConfig, persist = true) {
    // start from the last state seen, so a machine that's unreachable right now still shows
    // its sessions (marked offline) until it answers again
    const snap = loadSnapshot(config.id)
    const rt: Runtime = {
      host: new Host(config),
      state: snap
        ? { ...snap, config, status: 'connecting', error: undefined, latencyMs: undefined, sessions: offlineSessions(snap.sessions ?? []), lastSeen: snap.lastSeen ?? snap.updatedAt, offlineSince: snap.offlineSince }
        : { config, status: 'connecting', integration: 'unknown', tmux: 'unknown', agents: [], sessions: [], updatedAt: 0 },
      failures: 0,
      polling: false,
      pollAgain: false,
      cwdMap: new Map(),
      statusCache: new Map(),
      stopped: false,
      dirty: new Set(),
      screens: new Map(),
      resumed: new Set(),
      reconnected: new Map(),
    }
    rt.live = new LiveTmux(rt.host, (pane) => this.onPaneOutput(rt, pane), () => this.refresh(config.id, 150))
    this.hosts.set(config.id, rt)
    if (persist) this.persist()
    this.poll(rt)
    this.emit({ type: 'overview' })
  }

  update(id: string, patch: Partial<HostConfig>) {
    const rt = this.hosts.get(id)
    if (!rt) throw new HttpError(404, 'Unknown machine')
    this.remove(id, false)
    this.add({ ...rt.host.config, ...patch, id })
  }

  /** Records something about a machine that doesn't change how it's reached right now. */
  note(id: string, patch: Partial<HostConfig>) {
    const rt = this.hosts.get(id)
    if (!rt) return
    Object.assign(rt.host.config, patch)
    this.persist()
  }

  /** A fresh pairing token for a node: the old one stops working and it waits to be paired again. */
  setNodeToken(id: string, tokenHash: string) {
    const rt = this.hosts.get(id)
    if (!rt || rt.host.config.kind !== 'node') throw new HttpError(404, 'Unknown machine')
    rt.host.config.tokenHash = tokenHash
    rt.host.config.tokenIssuedAt = Date.now()
    delete rt.host.config.pairedAt
    this.persist()
    this.emit({ type: 'overview' })
  }

  /** A node connected with its token for the first time: it is no longer waiting to be paired. */
  markPaired(id: string) {
    const rt = this.hosts.get(id)
    if (!rt || rt.host.config.pairedAt) return
    rt.host.config.pairedAt = Date.now()
    this.persist()
    this.emit({ type: 'overview' })
  }

  remove(id: string, persist = true) {
    const rt = this.hosts.get(id)
    if (!rt) return
    rt.stopped = true
    clearTimeout(rt.timer)
    clearTimeout(rt.dirtyTimer)
    rt.events?.kill()
    rt.live?.stop()
    this.hosts.delete(id)
    if (persist) {
      kv.del(snapshotKey(id))
      pruneChats(id)
      this.persist()
      this.emit({ type: 'overview' })
    }
  }

  private persist() {
    saveHosts(this.configs())
  }

  /** Remember whether to put the Claude integration back if it disappears. */
  setKeepIntegration(id: string, keep: boolean) {
    const rt = this.hosts.get(id)
    if (!rt || rt.host.config.keepIntegration === keep) return
    rt.host.config.keepIntegration = keep
    this.persist()
  }

  /** The agent process found in a pane by the last probe. */
  agentProc(hostId: string, paneId: string) {
    return this.hosts.get(hostId)?.probe?.agentProcs.get(paneId)
  }

  /** Re-poll a machine soon (after an action or a hook event). */
  /** Re-read cached agent numbers and settings on the next poll (after changing them). */
  forgetStatus(id: string) {
    this.hosts.get(id)?.statusCache.clear()
  }

  /** Polls every 20 s instead of 4 s while no one is looking; the next poll picks it up. */
  quiet(on: boolean) {
    pollMs = on ? QUIET_POLL_MS : POLL_MS
  }

  /** The phone app went to the background (true) or came back with a network (false). */
  holdAlerts(on: boolean) {
    this.alertsHeld = on
    if (!on) this.alertsFrom = Date.now()
  }

  refresh(id: string, delay = 120) {
    const rt = this.hosts.get(id)
    if (!rt || rt.stopped) return
    if (rt.polling) {
      rt.pollAgain = true
      return
    }
    clearTimeout(rt.timer)
    rt.timer = setTimeout(() => this.poll(rt), delay)
  }

  /** Reads every machine again now (pull to refresh); settles once they've answered, or after `ms`. */
  async refreshAll(ms = 6000) {
    for (const id of this.hosts.keys()) this.refresh(id, 0)
    const until = Date.now() + ms
    await new Promise((r) => setTimeout(r, 50))
    while (Date.now() < until && [...this.hosts.values()].some((rt) => !rt.stopped && (rt.polling || rt.pollAgain))) await new Promise((r) => setTimeout(r, 100))
  }

  private async poll(rt: Runtime) {
    if (rt.stopped) return
    if ((rt.host.config.kind === 'node' || rt.host.config.kind === 'link') && !nodeLinks.isUp(rt.host.id)) {
      this.markDown(rt, 'connecting', waitingFor(rt.host.config))
      rt.timer = setTimeout(() => this.poll(rt), 5000)
      return
    }
    rt.polling = true
    let next = pollMs
    try {
      const pr = await probe(rt.host)
      rt.probe = pr
      await this.annotateAgents(rt, pr)
      const prev = rt.state
      rt.state = {
        config: rt.host.config,
        status: 'online',
        hostname: pr.hostname,
        integration: pr.integration,
        agyIntegration: pr.agyIntegration ?? 'unknown',
        codexIntegration: pr.codexIntegration ?? 'unknown',
        tmux: pr.tmux,
        agents: pr.installed,
        signedIn: pr.signedIn,
        os: pr.os,
        nodeVersion: rt.host.config.kind === 'node' || rt.host.config.kind === 'link' ? nodeLinks.info.get(rt.host.id)?.version : undefined,
        latencyMs: pr.latencyMs,
        sessions: pr.sessions,
        updatedAt: Date.now(),
        lastSeen: Date.now(),
      }
      rt.failures = 0
      if (prev.offlineSince) this.cameBack(rt, prev.offlineSince)
      this.snapshot(rt)
      this.diffNotify(rt, prev)
      if (pr.integration === 'installed' && !rt.events) this.watchEvents(rt)
      this.healIntegration(rt, pr).catch((e) => console.error('integration heal:', e?.message ?? e))
      // live updates for every tmux session that has an agent in it
      rt.live?.sync(pr.sessions.filter((s) => s.windows.some((w) => w.panes.some((p) => p.agent))).map((s) => s.id))
      if (JSON.stringify({ ...prev, updatedAt: 0, latencyMs: 0 }) !== JSON.stringify({ ...rt.state, updatedAt: 0, latencyMs: 0 })) {
        this.emit({ type: 'overview' })
      }
    } catch (err) {
      rt.failures++
      next = Math.min(Math.max(MAX_BACKOFF_MS, pollMs), pollMs * 2 ** Math.min(rt.failures, 4))
      const error = String((err as Error)?.message ?? err)
      const before = rt.state
      this.markDown(rt, 'error', error)
      if (before.status !== 'error' || before.error !== error || rt.state !== before) this.emit({ type: 'overview' })
    } finally {
      rt.polling = false
    }
    if (rt.stopped) return
    if (rt.pollAgain) {
      rt.pollAgain = false
      next = 100
    }
    rt.timer = setTimeout(() => this.poll(rt), next)
  }

  /**
   * The machine isn't answering. The first time, its sessions become "last seen" (nothing is known
   * to be running) and the outage starts; after a minute you're told once.
   */
  private markDown(rt: Runtime, status: 'connecting' | 'error', error: string) {
    const st = rt.state
    const offlineSince = st.offlineSince ?? (st.status === 'online' ? Date.now() : st.lastSeen ? Date.now() : undefined)
    if (st.status === status && st.error === error && st.offlineSince === offlineSince) {
      this.maybeNotifyOffline(rt)
      return
    }
    if (st.status === 'online') {
      // shown as unknown while away, but a turn that finishes meanwhile still counts as done, and
      // a question that was already waiting isn't announced again
      rt.beforeOutage = new Map()
      for (const s of st.sessions) for (const w of s.windows) for (const p of w.panes) if (p.agent) rt.beforeOutage.set(p.id, { kind: p.agent.kind, state: p.agent.state })
    }
    rt.state = { ...st, status, error, latencyMs: undefined, offlineSince, sessions: st.status === 'online' ? offlineSessions(st.sessions) : st.sessions }
    if (st.status === 'online') this.snapshot(rt, true)
    this.maybeNotifyOffline(rt)
  }

  private maybeNotifyOffline(rt: Runtime) {
    const online = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine !== false
    if (!offlineAlertDue({ since: rt.state.offlineSince, notified: rt.offlineNotified, now: Date.now(), held: this.alertsHeld, heldUntil: this.alertsFrom, online })) return
    rt.offlineNotified = true
    this.emit({ type: 'notify', host: rt.host.id, pane: '', kind: 'offline', title: `${rt.host.config.name} is offline`, body: 'Its sessions show as they were last seen. Tether reconnects by itself.' })
  }

  private cameBack(rt: Runtime, since: number) {
    if (rt.offlineNotified) {
      const mins = Math.max(1, Math.round((Date.now() - since) / 60_000))
      this.emit({ type: 'notify', host: rt.host.id, pane: '', kind: 'online', title: `${rt.host.config.name} is back online`, body: `Reconnected after ${mins} min. Sessions are up to date.` })
    }
    rt.offlineNotified = false
  }

  /** Saves every machine's latest look that the 15 s limit held back (before the app may close). */
  saveAll() {
    for (const rt of this.hosts.values()) {
      if (rt.state.status === 'online' && JSON.stringify(rt.state.sessions) !== rt.savedSnapshot) this.snapshot(rt, true)
    }
  }

  /** Saves what the machine looks like now; skipped when nothing changed, at most every 15 s. */
  private snapshot(rt: Runtime, force = false) {
    const key = JSON.stringify(rt.state.sessions)
    if (!force && (key === rt.savedSnapshot || Date.now() - (rt.savedAt ?? 0) < 15_000)) return
    rt.savedSnapshot = key
    rt.savedAt = Date.now()
    saveSnapshot(rt.state)
  }

  /** Adds the agent, its session mapping, live status and on-screen state to each agent pane. */
  private async annotateAgents(rt: Runtime, pr: ProbeResult) {
    const panes: PaneInfo[] = pr.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes))
    const agentPanes = panes.filter((p) => pr.agentProcs.has(p.id))
    const screens = await capturePanes(rt.host, agentPanes.map((p) => p.id))
    const live = new Set<number>()
    // every Codex on the host, so two in one folder don't claim the same thread
    const codexProcs = [...pr.agentProcs.values()].filter((x) => x.kind === 'codex').map((x) => ({ pid: x.pid, cwd: x.cwd, startedAt: x.startedAt, resume: x.resume }))
    await Promise.all(agentPanes.map(async (p) => {
      const proc = pr.agentProcs.get(p.id)!
      live.add(proc.pid)
      const info: AgentPaneInfo = { kind: proc.kind, pid: proc.pid, state: 'unknown', startedAt: Math.round(proc.startedAt * 1000) }
      const hook = pr.hookPanes.get(p.id)
      // Claude's hook, and Codex's once the integration is in (the same script, the same fields)
      if ((proc.kind === 'claude' || proc.kind === 'codex') && hook?.data.transcript_path && hook.ts >= proc.startedAt - 5) {
        info.transcriptPath = hook.data.transcript_path
        info.sessionId = hook.data.session_id
        info.mappedBy = 'hook'
      } else if (proc.kind === 'antigravity') {
        // the conversation whose presence lock the process holds: exact, no guessing
        const id = pr.agyConversations.get(proc.pid)
        if (id && pr.home) {
          info.sessionId = id
          info.transcriptPath = agyTranscript(pr.home, id)
          info.mappedBy = 'process'
        }
      } else if (pr.home) {
        let cached = rt.cwdMap.get(proc.pid)
        // re-check often until the session's first transcript appears, then occasionally (for /clear)
        // an OpenCode TUI that hasn't started a conversation yet ("opencode-db:") is checked often too
        // OpenCode puts the conversation's title in the terminal title, so a change there is a switch
        if (!cached || Date.now() - cached.at > (cached.path && cached.path !== OCDB ? 15000 : 2000) || (proc.kind === 'opencode' && cached.title !== p.title)) {
          const path =
            proc.kind === 'claude' ? await guessTranscript(rt.host, pr.home, proc)
            : proc.kind === 'codex' ? await guessCodexRollout(rt.host, pr.home, { ...proc, title: p.title }, codexProcs)
            : proc.kind === 'gemini' ? await guessGeminiSession(rt.host, pr.home, proc)
            : proc.kind === 'copilot' ? await guessCopilotSession(rt.host, pr.home, proc)
            // its local server when started with --port, else its database
            : (await opencodeEndpoint(rt.host, proc.pid, proc.cwd)) ?? (await guessOpenCodeSession(rt.host, proc, screens.get(p.id), p.title))
          cached = { path, at: Date.now(), title: p.title }
          rt.cwdMap.set(proc.pid, cached)
        }
        if (cached.path) {
          info.transcriptPath = cached.path
          // a Codex segment file after a rewind is "<thread>_<segment>"; the thread is the session
          info.sessionId = cached.path.split('/').pop()!.replace(/\.jsonl?$/, '').replace(/^(rollout-[\dT-]+-|session-)/, '').replace(/_[0-9a-f-]{36}$/, '')
          if (proc.kind === 'copilot') info.sessionId = cached.path.split('/').at(-2)
          if (proc.kind === 'opencode') info.sessionId = cached.path.startsWith(OCDB) ? ocdbSession(cached.path) : cached.path.split('/').pop() || undefined
          info.mappedBy = proc.resume ? 'resume' : 'cwd'
        }
      }
      // live numbers
      if (proc.kind === 'claude') {
        info.status = claudeStatus(pr, p.id, proc.startedAt, info.mappedBy === 'hook' ? info.sessionId : undefined)
        // Claude rewrites its status as it redraws (after /model, say): a moment without a model
        // isn't a change of model, so keep the last one for this conversation
        const was = this.findPane(rt.host.id, p.id)?.pane.agent
        if (!info.status && was?.sessionId === info.sessionId && was?.status) info.status = was.status
        else if (info.status && !info.status.model && was?.sessionId === info.sessionId && was?.status?.model) {
          info.status = { ...info.status, model: was.status.model, modelId: was.status.modelId, effort: info.status.effort ?? was.status.effort }
        }
      }
      if (proc.kind === 'codex' && info.transcriptPath) {
        let c = rt.statusCache.get(proc.pid)
        if (!c || Date.now() - c.at > 8000) {
          c = { ...(await codexStatus(rt.host, info.transcriptPath)), at: Date.now() }
          rt.statusCache.set(proc.pid, c)
        }
        info.status = c.status
        // the permission preset isn't on screen; Plan mode (on screen) overrides it below
        if (c.permission) info.mode = c.permission
      }
      if (proc.kind === 'codex') p.title = codexTitle(p.title, proc.cwd ?? p.cwd)
      // OpenCode titles the terminal "OC | <conversation>", or "OpenCode" before there is one
      if (proc.kind === 'opencode') p.title = p.title.replace(/^OC \| /, '').replace(/^OpenCode$/, '')
      if (proc.kind === 'antigravity') {
        const st = agyStatus(pr, p.id, proc.startedAt, info.sessionId)
        if (st) {
          const { title: _t, state: _s, queued: _q, confirming: _c, mode: _m, ...status } = st
          info.status = status
        }
        // agy leaves the pane title alone (the host name); show the conversation's title instead
        const title = (info.sessionId && pr.agyTitles.get(info.sessionId)) || st?.title
        // the shell may have set it to the command line ("agy --model … -i '…'"); that's no name either
        const generic = !p.title || p.title === pr.hostname || /^(agy|antigravity)(\s|$)/i.test(p.title)
        if (title && generic) p.title = title
        else if (generic) p.title = ''
      }
      p.agent = info
      const lines = screens.get(p.id)
      if (lines) {
        const sc = parseScreen(lines, p.width, proc.kind)
        rt.screens.set(p.id, sc)
        applyScreen(p, sc, rt.host)
        await applyOpenCodeLive(rt.host, p)
      }
      // a rename the agent hasn't taken yet: done once its title says so, else typed when it's idle
      const want = pendingName(rt.host.id, info.sessionId)
      if (want && ownsTitle(proc.kind)) {
        if (bareTitle(p.title) === want.name) nameTaken(rt.host.id, info.sessionId!)
        else if (info.state === 'idle') this.emit({ type: 'rename-due', host: rt.host.id, pane: p.id })
      }
      p.label = sessionName(rt.host.id, info.sessionId, proc.kind)
      // agy's own word on its mode, for when a custom status line hides the footer
      if (proc.kind === 'antigravity' && !info.mode) {
        const m = agyStatus(pr, p.id, proc.startedAt, info.sessionId)?.mode
        if (m) info.mode = m
      }
    }))
    await this.checkReporting(rt, pr, agentPanes)
    this.applyUsage(rt, pr, agentPanes)
    for (const pid of rt.cwdMap.keys()) if (!live.has(pid)) rt.cwdMap.delete(pid)
    for (const pid of rt.statusCache.keys()) if (!live.has(pid)) rt.statusCache.delete(pid)
    for (const id of rt.screens.keys()) if (!agentPanes.some((p) => p.id === id)) rt.screens.delete(id)
  }

  /**
   * Limits are per account, so they come from the account (like /usage), not from whatever a
   * session's status line last said: right after a /login or a credentials swap, with no restart.
   */
  private applyUsage(rt: Runtime, pr: ProbeResult, panes: PaneInfo[]) {
    if (!pr.installed.includes('claude')) return
    const u = rt.usage
    const due = !u || Date.now() - u.at > (u.error ? USAGE_RETRY_MS : USAGE_EVERY_MS) || u.account !== pr.account
    if (due && !rt.usageLoading) {
      rt.usageLoading = true
      fetchClaudeUsage(rt.host)
        .then((r) => {
          const prev = rt.usage?.account === pr.account ? rt.usage : undefined
          rt.usage = r.error ? { ...prev, at: r.at, error: r.error, account: pr.account } : { ...r, okAt: r.at, account: pr.account }
          if (r.error) console.error(`usage ${rt.host.id}: ${r.error}`)
          this.refresh(rt.host.id, 0)
        })
        .catch((e) => console.error('usage:', e?.message ?? e))
        .finally(() => (rt.usageLoading = false))
    }
    if (!u?.okAt || u.account !== pr.account || Date.now() - u.okAt > USAGE_STALE_MS) return
    for (const p of panes) {
      const a = p.agent
      if (a?.kind !== 'claude') continue
      const st: AgentStatus = a.status ?? { updatedAt: 0 }
      st.fiveHour = u.fiveHour
      st.sevenDay = u.sevenDay
      if (u.plan) st.plan = u.plan
      if (st.stale?.limits) st.stale = { ...st.stale, limits: undefined }
      a.status = st
    }
  }

  /**
   * A Claude session writes its status line after every message. If its transcript has moved on
   * for a while and the status hasn't, the session stopped reporting (its settings were swapped
   * under it), and whatever it last wrote is out of date.
   */
  private async checkReporting(rt: Runtime, pr: ProbeResult, panes: PaneInfo[]) {
    if (pr.integration !== 'installed') return
    const claude = panes.filter((p) => p.agent?.kind === 'claude' && p.agent.transcriptPath)
    if (!claude.length) return
    const paths = [...new Set(claude.map((p) => p.agent!.transcriptPath!))]
    // The newest entry's own timestamp, not the file's mtime: Claude also touches the file
    // without adding a message, which would look like a session that stopped reporting.
    const r = await rt.host.exec(
      `for f in ${paths.map(shq).join(' ')}; do echo "$(tail -c 262144 "$f" 2>/dev/null | grep -o '"timestamp":"[^"]*"' | tail -n 1 | cut -d'"' -f4) $f"; done`,
    )
    const last = new Map<string, number>()
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^(\S+) (.+)$/)
      const t = m ? Date.parse(m[1]) : NaN
      if (m && !Number.isNaN(t)) last.set(m[2], t / 1000)
    }
    for (const p of claude) {
      const a = p.agent!
      const moved = last.get(a.transcriptPath!) ?? 0
      const st = pr.statusPanes.get(p.id)
      const since = Math.max(st?.ts ?? 0, (a.startedAt ?? 0) / 1000)
      if (moved > since + STALL_S) {
        // keep nothing it reported: limits come from the account and context from the transcript
        a.status = undefined
        a.statusStopped = true
      }
    }
    this.autoHeal(rt, pr, claude).catch((e) => console.error('auto-heal:', e?.message ?? e))
  }

  /** Puts a replaced integration back, and resumes idle sessions that stopped reporting. */
  private async autoHeal(rt: Runtime, pr: ProbeResult, claude: PaneInfo[]) {
    const id = rt.host.id
    if (!rt.host.config.keepIntegration) return
    for (const p of claude) {
      const a = p.agent!
      if (!a.statusStopped || !a.sessionId) continue
      // first, without touching the session: point its project settings at the status line
      if (!rt.reconnected.has(a.sessionId)) {
        // a hub that runs for months sees many sessions: forget ones from days ago
        if (rt.reconnected.size > 500) {
          for (const [id, at] of rt.reconnected) if (Date.now() - at > 86_400_000) rt.reconnected.delete(id), rt.resumed.delete(id)
        }
        rt.reconnected.set(a.sessionId, Date.now())
        console.log(`reconnect ${id} ${p.id} ${a.sessionId}: stopped reporting live numbers`)
        const { reconnectAgent } = await import('../claude/actions.ts')
        await reconnectAgent(id, p.id).catch((e) => console.error(`reconnect ${p.id}: ${e?.message ?? e}`))
        continue
      }
      // still silent a few minutes later: resuming is the last resort, and only if you allowed it
      if (Date.now() - rt.reconnected.get(a.sessionId)! < 3 * 60_000 || rt.resumed.has(a.sessionId)) continue
      // resuming by a guessed session id could open the wrong conversation
      if (a.mappedBy !== 'hook') continue
      if (loadSettings().autoResume !== true) continue
      const sc = rt.screens.get(p.id)
      const win = pr.sessions.flatMap((s) => s.windows).find((w) => w.panes.some((x) => x.id === p.id))
      const quietFor = Date.now() / 1000 - (win?.activity ?? 0)
      // only when nothing would be lost: idle, nothing typed, no background shells, quiet a while
      if (!sc || sc.working || sc.prompt || sc.draft || sc.background || a.state !== 'idle' || quietFor < 45) continue
      rt.resumed.add(a.sessionId)
      console.log(`auto-resume ${id} ${p.id} ${a.sessionId}: stopped reporting live numbers`)
      // imported lazily: actions and the integration import this module
      const { restartAgent } = await import('../claude/actions.ts')
      await restartAgent(id, p.id)
    }
  }

  /** Called after each probe: the integration went missing from settings, so add it back. */
  private async healIntegration(rt: Runtime, pr: ProbeResult) {
    const cfg = rt.host.config
    if (pr.integration === 'installed' && cfg.keepIntegration === undefined) return this.setKeepIntegration(cfg.id, true)
    // agy turned up after the integration was installed (or its settings were replaced): add its status line
    if (cfg.keepIntegration && pr.integration === 'installed' && pr.agyIntegration === 'missing' && pr.installed.includes('antigravity')) {
      if (rt.agyHealedAt && Date.now() - rt.agyHealedAt < HEAL_EVERY_MS) return
      rt.agyHealedAt = Date.now()
      console.log(`antigravity integration missing on ${cfg.id}: adding it`)
      const { installAgyIntegration } = await import('../claude/integration.ts')
      await installAgyIntegration(rt.host)
      return this.refresh(cfg.id, 500)
    }
    // the same for Codex: its hook went in after the integration, or hooks.json was replaced
    if (cfg.keepIntegration && pr.integration === 'installed' && pr.codexIntegration === 'missing' && pr.installed.includes('codex') && pr.os !== 'Windows') {
      if (rt.codexHealedAt && Date.now() - rt.codexHealedAt < HEAL_EVERY_MS) return
      rt.codexHealedAt = Date.now()
      console.log(`codex integration missing on ${cfg.id}: adding it`)
      const { installCodexIntegration } = await import('../claude/integration.ts')
      await installCodexIntegration(rt.host)
      return this.refresh(cfg.id, 500)
    }
    if (!cfg.keepIntegration || !pr.installed.includes('claude')) return
    if (pr.integration !== 'removed' && pr.integration !== 'outdated') return
    if (rt.healedAt && Date.now() - rt.healedAt < HEAL_EVERY_MS) return
    rt.healedAt = Date.now()
    console.log(`integration ${pr.integration} on ${cfg.id}: putting it back`)
    const { installIntegration } = await import('../claude/integration.ts')
    await installIntegration(rt.host)
    this.refresh(cfg.id, 500)
  }

  private diffNotify(rt: Runtime, prev: HostState) {
    const before = new Map<string, PaneInfo>()
    for (const s of prev.sessions) for (const w of s.windows) for (const p of w.panes) before.set(p.id, p)
    const seen = rt.state.status === 'online' ? rt.beforeOutage : undefined
    if (seen) rt.beforeOutage = undefined
    for (const s of rt.state.sessions)
      for (const w of s.windows)
        for (const p of w.panes) {
          let was = before.get(p.id)?.agent?.state
          const last = seen?.get(p.id)
          if (was === 'unknown' && last && last.kind === p.agent?.kind) was = last.state as typeof was
          const now = p.agent?.state
          const agentName = p.agent ? AGENTS[p.agent.kind].name : 'Agent'
          if (!was || !now || was === now) continue
          const title = paneTitle(p) || `${s.name}:${w.index}`
          if (now === 'waiting') {
            this.emit({ type: 'notify', host: rt.host.id, pane: p.id, kind: 'waiting', title, body: p.agent?.waitingFor ?? `${agentName} needs your input`, agent: p.agent?.kind })
          } else if (was === 'working' && now === 'idle') {
            this.emit({ type: 'notify', host: rt.host.id, pane: p.id, kind: 'done', title, body: `${agentName} finished`, agent: p.agent?.kind })
          }
        }
  }

  /** A pane printed something: re-read just the agent panes that changed, shortly. */
  private onPaneOutput(rt: Runtime, pane: string) {
    this.emit({ type: 'pane-output', host: rt.host.id, pane })
    if (!this.findPane(rt.host.id, pane)?.pane.agent) return
    rt.dirty.add(pane)
    if (rt.dirtyTimer) return
    rt.dirtyTimer = setTimeout(() => this.flushDirty(rt), 180)
  }

  private async flushDirty(rt: Runtime) {
    rt.dirtyTimer = undefined
    const panes = [...rt.dirty]
    rt.dirty.clear()
    if (!panes.length || rt.stopped || rt.polling) return
    try {
      const prev = structuredClone(rt.state)
      const screens = await capturePanes(rt.host, panes)
      let changed = false
      for (const id of panes) {
        const pane = this.findPane(rt.host.id, id)?.pane
        const lines = screens.get(id)
        if (!pane?.agent || !lines) continue
        const before = JSON.stringify(pane.agent)
        applyScreen(pane, parseScreen(lines, pane.width, pane.agent.kind), rt.host)
        await applyOpenCodeLive(rt.host, pane)
        if (JSON.stringify(pane.agent) !== before) changed = true
      }
      if (changed) {
        rt.state = { ...rt.state, updatedAt: Date.now() }
        this.diffNotify(rt, prev)
        this.emit({ type: 'overview' })
      }
    } catch {}
  }

  /** Follows the hook event log on the machine for instant updates. */
  private watchEvents(rt: Runtime) {
    const prepare = 'umask 077; mkdir -p "$HOME/.tether" && touch "$HOME/.tether/events.jsonl"'
    const tail = 'tail -n0 -F "$HOME/.tether/events.jsonl" 2>/dev/null'
    // on another machine it stops when the connection does (see untilStdinCloses)
    const remote = rt.host.config.kind !== 'local'
    const cmd = remote ? `${prepare} && { ${untilStdinCloses(tail)}; }` : `${prepare} && exec ${tail}`
    const s = rt.host.stream(cmd, (line) => {
      try {
        const e = JSON.parse(line)
        this.refresh(rt.host.id)
        if (e.pane) this.emit({ type: 'hook', host: rt.host.id, pane: e.pane, event: e.data })
      } catch {}
    }, { keepStdin: remote })
    rt.events = s
    s.exited.then(() => {
      if (rt.events === s) rt.events = undefined
    })
  }
}

/** Copies what the screen says (state, mode, prompt summary) onto a pane's agent info. */
function applyScreen(p: PaneInfo, sc: ReturnType<typeof parseScreen>, host: Host) {
  const info = p.agent!
  if (isDriving(host.id, p.id)) sc = { ...sc, prompt: undefined }
  info.state = sc.prompt ? 'waiting' : sc.working ? 'working' : 'idle'
  info.mode = sc.mode ?? info.mode
  // a session without live numbers still shows its model and effort on screen
  // agy's and Codex's footers are redrawn the moment you switch, so they beat numbers written earlier
  const live = info.kind === 'antigravity' || info.kind === 'codex'
  if (info.kind === 'opencode' && !info.transcriptPath?.startsWith('opencode://')) {
    // plain OpenCode: its footer is the only live source, and no variant there means the default
    if (sc.model) {
      const models = peekOpenCodeModels(host.id)?.models
      if (!models) void opencodeCliModels(host)
      const known = models && modelFromFooter(models, sc.model)
      info.status = { ...(info.status ?? { updatedAt: 0 }), model: known ? known.label.split(' · ').pop() : withoutProvider(sc.model), modelId: known?.id, effort: sc.effort, ...(known?.context && { contextSize: known.context }) }
    }
  } else {
    if (sc.model && (live || !info.status?.model)) info.status = { ...(info.status ?? { updatedAt: 0 }), model: sc.model }
    if (sc.effort && (live || !info.status?.effort)) info.status = { ...(info.status ?? { updatedAt: 0 }), effort: sc.effort }
  }
  info.activity = sc.activity
  info.background = sc.background
  info.options = undefined
  info.waitingFor = undefined
  if (!sc.prompt) return
  if (!sc.prompt.multi && !sc.prompt.tabs?.length && !sc.prompt.input) {
    info.options = sc.prompt.options.filter((o) => o.n !== sc.prompt!.freeTextOption).slice(0, 4).map((o) => ({ n: o.n, label: o.label }))
  }
  // the framed block (between ╌ separators) is the command or file being asked about
  const raw = sc.prompt.body.map((l) => l.trim())
  const sep = raw.indexOf('╌')
  const framed = sep >= 0 ? raw.slice(sep + 1).find((l) => l && l !== '╌') : undefined
  const body = raw.filter((l) => l && l !== '╌' && !/^Tip:/.test(l))
  const question = body.find((l) => /\?$/.test(l))
  info.waitingFor = framed && body[0] ? `${body[0].replace(/[?:]$/, '')}: ${framed}`.slice(0, 200) : sc.prompt.input?.label ?? question ?? body[0] ?? 'Needs your input'
}

/** A host's settings as the browser sees them: the pairing token's hash stays on the hub. */
export const publicConfig = ({ tokenHash: _t, ...c }: HostConfig): HostConfig => c

/** A pairing token works for a day if no machine connects with it; once one has, until it's removed. */
export const PAIR_TOKEN_MS = 24 * 3600_000
export const tokenExpired = (c: HostConfig, now = Date.now()) => c.kind === 'node' && !c.pairedAt && !!c.tokenIssuedAt && now - c.tokenIssuedAt > PAIR_TOKEN_MS

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export const registry = new Registry()

async function applyOpenCodeLive(host: Host, pane: PaneInfo) {
  const info = pane.agent
  if (info?.kind !== 'opencode' || !info.transcriptPath?.startsWith('opencode://')) return
  try {
    const live = await opencodeLive(host, info.transcriptPath, pane.cwd)
    info.state = live.permission ? 'waiting' : live.working ? 'working' : 'idle'
    info.activity = live.retrying ? 'Retrying' : live.working ? 'Working' : undefined
    info.mode = live.selection.agent ?? info.mode
    info.status = { ...info.status, model: live.selection.model, modelId: live.selection.model, effort: live.selection.variant, updatedAt: Date.now() }
    if (live.permission) {
      info.waitingFor = live.permission.permission ?? 'Permission requested'
      info.options = [{ n: 1, label: 'Allow once' }, { n: 2, label: 'Always allow' }, { n: 3, label: 'Reject' }]
    }
  } catch { /* Keep the terminal observation if the local API is unavailable. */ }
}
