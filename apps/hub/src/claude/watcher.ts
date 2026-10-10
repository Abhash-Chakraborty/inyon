import { OpenCodeClient } from '../agents/opencode-api.ts'
import { opencodeSelection, opencodeLive } from '../agents/opencode-controls.ts'
import type { AgentKind, ChatInfo, ChatItem, ScreenState, ServerMsg } from '@tether/protocol'
import { isDriving, startDriving } from './driving.ts'
import { chatKey } from '@tether/protocol'
import { codexHistory, normalizeCodex } from '../agents/codex.ts'
import { normalizeCopilot } from '../agents/copilot.ts'
import { AntigravityDoc } from '../agents/antigravity.ts'
import { GeminiDoc } from '../agents/gemini.ts'
import { opencodeItems, opencodePost, parseEndpoint } from '../agents/opencode.ts'
import { OcdbCache, isOcdb, ocdbRows, ocdbSession, ocdbShape, ocdbStamp } from '../agents/opencode-db.ts'
import { shq } from '../hosts/host.ts'
import { paneTitle, registry } from '../hosts/registry.ts'
import { capturePanes } from '../tmux/tmux.ts'
import { newMeta, normalize, type TranscriptMeta } from './transcript.ts'
import { parseScreen } from './screen.ts'
import { hasPastePreview, inputContains } from './delivery.ts'
import { getDraft, mirrorToTerminal, setDraft, squash } from './drafts.ts'

const PAGE = 160
/** messages kept per open chat; older ones stay in the transcript file (and the terminal) */
const KEEP = 4000
/** fallback screen poll; tmux control mode triggers re-reads as soon as the pane changes */
const SCREEN_MS = 2000
const IDLE_SHUTDOWN_MS = 120_000
/** agents whose input box Tether can read and retype, so a draft follows you between app and terminal */
const MIRRORS = new Set<AgentKind>(['claude', 'codex', 'antigravity', 'opencode', 'copilot'])

export interface Subscriber {
  send(msg: ServerMsg): void
}

/**
 * One per Claude pane that someone is looking at. Follows the session transcript and polls the
 * pane's screen (for prompts, the spinner and the permission mode), pushing changes to subscribers.
 */
class ChatWatcher {
  readonly key: string
  subs = new Set<Subscriber>()
  items: ChatItem[] = []
  meta: TranscriptMeta = newMeta()
  private agent?: AgentKind
  screen: ScreenState = { working: false, width: 0 }
  info: ChatInfo
  private tail?: { kill(): void }
  private transcript?: string
  private ready = false
  private pending: ChatItem[] = []
  private flushTimer?: ReturnType<typeof setTimeout>
  private screenTimer?: ReturnType<typeof setTimeout>
  private idleTimer?: ReturnType<typeof setTimeout>
  private stopped = false
  private screenJson = ''
  /** agy Remote Control, as last seen on screen */
  private remote?: { url: string; ts: string }
  private generation = 0

  constructor(public hostId: string, public paneId: string) {
    this.key = chatKey(hostId, paneId)
    this.info = this.emptyInfo()
    this.sync()
    this.pollScreen()
  }

  private emptyInfo(): ChatInfo {
    return { hostId: this.hostId, paneId: this.paneId, running: false, queue: [], tasks: [], subagents: [], artifacts: [], stats: { turns: 0, compactions: 0 } }
  }

  subscribe(s: Subscriber) {
    clearTimeout(this.idleTimer)
    this.subs.add(s)
    if (this.ready) s.send(this.resetMsg())
    else s.send({ t: 'chat.info', key: this.key, info: this.info })
    s.send({ t: 'chat.screen', key: this.key, screen: this.screen })
    const d = getDraft(this.key)
    if (d) s.send({ t: 'chat.draft', key: this.key, text: d.text, source: d.source, at: d.at })
  }

  // ---------- drafts (two-way with Claude's input box) ----------

  private mirrorTimer?: ReturnType<typeof setTimeout>
  private mirroringUntil = 0
  /** a send owns the input box until then; no mirroring meanwhile */
  private sendingUntil = 0
  private mirroring?: Promise<void>

  private broadcastDraft(except?: Subscriber) {
    const d = getDraft(this.key)
    const msg = { t: 'chat.draft' as const, key: this.key, text: d?.text ?? '', source: d?.source ?? 'app', at: d?.at ?? Date.now() }
    for (const s of this.subs) if (s !== except) s.send(msg)
  }

  /** Text typed in the app: save it, share it with other devices, and mirror it into the terminal. */
  draftFromApp(text: string, from?: Subscriber) {
    const prev = getDraft(this.key)
    setDraft(this.key, { text, source: 'app', at: Date.now(), mirrored: prev?.mirrored })
    this.broadcastDraft(from)
    clearTimeout(this.mirrorTimer)
    this.mirrorTimer = setTimeout(() => this.mirror(), 900)
  }

  private mirror() {
    if (Date.now() < this.sendingUntil) {
      clearTimeout(this.mirrorTimer)
      this.mirrorTimer = setTimeout(() => this.mirror(), this.sendingUntil - Date.now() + 100)
      return
    }
    this.mirroring = this.doMirror().finally(() => (this.mirroring = undefined))
  }

  /**
   * A message is about to be typed and submitted: drop any pending mirror and wait for one in
   * flight, or both type into the box and the message goes in twice.
   */
  async beginSend() {
    clearTimeout(this.mirrorTimer)
    this.sendingUntil = Date.now() + 15_000
    await this.mirroring
  }

  /**
   * A settings command borrows the input box (it clears it, types "/model", opens a menu): keep
   * the draft as it was, ignore what the box shows meanwhile, and put the draft back afterwards.
   */
  async holdDraft(onScreen?: string): Promise<() => Promise<void>> {
    clearTimeout(this.mirrorTimer)
    const stopDriving = startDriving(this.hostId, this.paneId)
    await this.mirroring
    if (onScreen && !getDraft(this.key)) setDraft(this.key, { text: onScreen, source: 'terminal', at: Date.now(), mirrored: onScreen })
    this.mirroringUntil = this.sendingUntil = Date.now() + 60_000
    return async () => {
      stopDriving()
      // read the screen as it is now (the menu is gone), so the empty box isn't taken for the draft
      // and the mirror doesn't skip because it still sees the menu
      await this.pollScreen()
      this.sendingUntil = 0
      const d = getDraft(this.key)
      if (d) {
        this.mirroringUntil = Date.now() + 2500
        setDraft(this.key, { ...d, mirrored: this.screen.draft ?? '' })
        this.mirror()
        await this.mirroring
      }
      this.mirroringUntil = Date.now() + 800
    }
  }

  private async doMirror() {
    const pane = registry.findPane(this.hostId, this.paneId)?.pane
    const d = getDraft(this.key)
    if (!MIRRORS.has(pane?.agent?.kind as AgentKind) || this.screen.prompt || !this.screen.inputVisible) return
    const target = d?.text ?? ''
    const current = this.screen.draft ?? ''
    if (squash(current) === squash(target) || target && inputContains(current, target)) {
      if (d) setDraft(this.key, { ...d, mirrored: target })
      return
    }
    this.mirroringUntil = Date.now() + 2500
    if (d) setDraft(this.key, { ...d, mirrored: target })
    try {
      await mirrorToTerminal(this.hostId, this.paneId, target, current)
    } catch {}
    this.mirroringUntil = Date.now() + 800
    this.pollScreen()
  }

  /**
   * Called after a message is sent: the box is empty again everywhere. A message from the app's
   * box rarely matches the saved draft exactly (edits are pushed on a delay, attachments add their
   * paths), so for those (`startedAt` set) only a draft written after the send began survives.
   * Picker commands leave `startedAt` at 0 and keep a half-typed draft.
   */
  draftSent(text?: string, startedAt = 0) {
    clearTimeout(this.mirrorTimer)
    this.sendingUntil = Date.now() + 1500
    const current = getDraft(this.key)
    if (!text || !current || current.at <= startedAt || squash(text).startsWith(squash(current.text))) setDraft(this.key, undefined)
    else this.mirrorTimer = setTimeout(() => this.mirror(), 1600)
    this.broadcastDraft()
  }

  /** The terminal's input box changed: if someone typed there, adopt it as the draft. */
  private syncDraftFromScreen() {
    if (Date.now() < this.mirroringUntil || Date.now() < this.sendingUntil || this.screen.prompt || !this.screen.inputVisible) return
    const term = this.screen.draft ?? ''
    if (hasPastePreview(term)) return
    const d = getDraft(this.key)
    if (squash(term) === squash(d?.mirrored ?? '')) return
    if (squash(term) === squash(d?.text ?? '')) {
      if (d) setDraft(this.key, { ...d, mirrored: term })
      return
    }
    setDraft(this.key, term ? { text: term, source: 'terminal', at: Date.now(), mirrored: term } : undefined)
    this.broadcastDraft()
  }

  unsubscribe(s: Subscriber) {
    this.subs.delete(s)
    if (!this.subs.size) {
      this.idleTimer = setTimeout(() => watchers.stop(this.key), IDLE_SHUTDOWN_MS)
    }
  }

  /** A very long session keeps only its latest messages in memory (in chunks, not on every push). */
  private trim() {
    if (this.items.length > KEEP + 500) this.items.splice(0, this.items.length - KEEP)
  }

  more(s: Subscriber, before: number) {
    const idx = this.items.findIndex((i) => i.seq >= before)
    const end = idx < 0 ? this.items.length : idx
    const start = Math.max(0, end - PAGE)
    s.send({ t: 'chat.more', key: this.key, items: this.items.slice(start, end), hasMore: start > 0 })
  }

  private resetMsg(): ServerMsg {
    const start = Math.max(0, this.items.length - PAGE)
    return { t: 'chat.reset', key: this.key, info: this.info, items: this.items.slice(start), hasMore: start > 0 }
  }

  private broadcast(msg: ServerMsg) {
    for (const s of this.subs) s.send(msg)
  }

  /** Re-reads pane info from the registry; restarts the tail if the session changed. */
  sync() {
    const found = registry.findPane(this.hostId, this.paneId)
    const agent = found?.pane.agent
    if (agent?.kind) this.agent = agent.kind
    if (agent?.transcriptPath && agent.transcriptPath !== this.transcript) this.follow(agent.transcriptPath)
    if (!this.transcript && found && !agent?.transcriptPath) this.ready = true // nothing to read; show the empty state
    this.publishInfo()
  }

  /** Builds ChatInfo from the pane and the transcript summary; broadcasts it when it changed. */
  private publishInfo() {
    const found = registry.findPane(this.hostId, this.paneId)
    const agent = found?.pane.agent
    const m = this.meta
    const info: ChatInfo = {
      hostId: this.hostId,
      paneId: this.paneId,
      agent: agent?.kind ?? this.agent,
      running: !!agent,
      transcriptPath: agent?.transcriptPath ?? this.transcript,
      sessionId: agent?.sessionId ?? this.info.sessionId,
      mappedBy: agent?.mappedBy ?? this.info.mappedBy,
      cwd: m.cwd ?? found?.pane.cwd,
      title: m.customTitle || m.title || (found ? paneTitle(found.pane) : undefined),
      model: m.model,
      status: m.status,
      gitBranch: m.gitBranch,
      version: m.version,
      mode: this.screen.mode ?? agent?.mode ?? m.mode,
      goal: m.goal,
      rc: m.rc ?? this.remote,
      // Antigravity's queue is only on screen
      queue: m.queue.length ? [...m.queue] : [...(this.screen.queue ?? [])],
      tasks: [...m.tasks.values()].slice(-40),
      subagents: [...m.subagents.values()].slice(-40),
      artifacts: [...m.artifacts.values()].slice(-40),
      stats: { ...m.stats, startedAt: m.stats.startedAt ?? (agent?.startedAt ? new Date(agent.startedAt).toISOString() : undefined) },
      error: !found ? 'This pane no longer exists' : undefined,
    }
    if (JSON.stringify(info) !== JSON.stringify(this.info)) {
      this.info = info
      if (this.ready) this.broadcast({ t: 'chat.info', key: this.key, info })
    }
  }

  /** Formats whose files are edited in place (Gemini) or read over an API (OpenCode): rebuild the whole view. */
  private snapshotTimer?: ReturnType<typeof setTimeout>
  private apiPermission?: { id: string; base: string; title: string; detail?: string }

  private publishSnapshot(items: ChatItem[]) {
    this.items = items
    const first = !this.ready
    this.ready = true
    this.publishInfo()
    if (first || this.subs.size) this.broadcast(this.resetMsg())
  }

  /** Formats rewritten per step (Gemini's session file, Antigravity's transcript): rebuild on change. */
  private followDoc(path: string, gen: number, doc: { apply(rec: any): void; items(meta: TranscriptMeta): ChatItem[] }) {
    const host = registry.host(this.hostId)
    // a new conversation has no file until the first message; show the empty chat meanwhile
    setTimeout(() => {
      if (gen === this.generation && !this.ready && !this.snapshotTimer) this.publishSnapshot([])
    }, 2500)
    const rebuild = () => {
      this.snapshotTimer = undefined
      if (gen === this.generation) this.publishSnapshot(doc.items(this.meta))
    }
    this.tail = host.stream(`exec tail -c +1 -F ${shq(path)} 2>/dev/null`, (line) => {
      if (gen !== this.generation) return
      try {
        doc.apply(JSON.parse(line))
      } catch {
        return
      }
      if (!this.snapshotTimer) this.snapshotTimer = setTimeout(rebuild, this.ready ? 350 : 600)
    })
  }

  private followOpenCode(uri: string, gen: number) {
    const ep = parseEndpoint(uri)
    if (!ep?.session) {
      this.ready = true
      return
    }
    const host = registry.host(this.hostId)
    const cwd = registry.findPane(this.hostId, this.paneId)?.pane.cwd
    const client = new OpenCodeClient(host, uri, cwd)
    const refresh = async () => {
      this.snapshotTimer = undefined
      const msgs = await client.request(`/session/${encodeURIComponent(ep.session)}/message`).catch(() => undefined)
      if (gen !== this.generation || !Array.isArray(msgs)) return
      const items = opencodeItems(msgs, this.meta)
      const selection = await opencodeSelection(host, uri, cwd).catch(() => undefined)
      if (gen !== this.generation) return
      if (selection) {
        this.meta.model = selection.model
        this.meta.effort = selection.variant
        this.meta.mode = selection.agent
        this.meta.status = { ...this.meta.status, model: selection.model, modelId: selection.model, effort: selection.variant, updatedAt: Date.now() }
      }
      this.publishSnapshot(items)
      const perms = await client.permissions().catch(() => undefined)
      if (gen !== this.generation) return
      const mine = (Array.isArray(perms) ? perms : []).find((p: any) => p.sessionID === ep.session)
      const next = mine ? { id: mine.id, base: ep.base, title: mine.title ?? mine.permission ?? 'Permission requested', detail: [mine.type, ...(mine.patterns ?? [])].filter(Boolean).join(' ') } : undefined
      if (JSON.stringify(next) !== JSON.stringify(this.apiPermission)) {
        this.apiPermission = next
        this.pollScreen()
      }
    }
    const later = () => {
      if (!this.snapshotTimer) this.snapshotTimer = setTimeout(refresh, 300)
    }
    refresh()
    // the event stream tells us when anything changes
    this.tail = host.stream(`exec curl -sN ${shq(`${ep.base}/event`)}`, (line) => {
      if (gen === this.generation && line.startsWith('data:')) later()
    })
    const poll = setInterval(() => (gen === this.generation && !this.stopped ? later() : clearInterval(poll)), 5000)
  }

  /**
   * OpenCode without a server (plain `opencode`): read its database. A cheap change stamp is
   * checked about every second while it works (every few seconds when idle), and only rows
   * written since the last read are fetched.
   */
  private followOpenCodeDb(uri: string, gen: number) {
    const session = ocdbSession(uri)
    if (!session) return this.publishSnapshot([])
    const host = registry.host(this.hostId)
    const cache = new OcdbCache()
    let last = -1
    let changedAt = Date.now()
    const tick = async () => {
      if (gen !== this.generation || this.stopped) return
      try {
        const stamp = await ocdbStamp(host, session)
        if (gen !== this.generation) return
        if (stamp !== last || !this.ready) {
          last = stamp
          changedAt = Date.now()
          // a little overlap: rows written in the same millisecond as the last read
          const [rows, shape] = await Promise.all([ocdbRows(host, session, Math.max(0, cache.stamp - 1500)), ocdbShape(host, session)])
          if (gen !== this.generation) return
          cache.merge(rows)
          cache.retain(shape.ids)
          this.publishSnapshot(opencodeItems(cache.list(shape.revert), this.meta))
        }
      } catch {
        if (!this.ready) this.publishSnapshot([])
      }
      const busy = this.screen.working || Date.now() - changedAt < 15_000
      setTimeout(tick, busy ? 900 : 2500)
    }
    tick()
  }

  /** Answers a permission request through the agent's API (OpenCode). */
  async answerApi(option: number) {
    const p = this.apiPermission
    if (!p) return false
    const reply = option === 1 ? 'once' : option === 2 ? 'always' : 'reject'
    const ok = await opencodePost(registry.host(this.hostId), `${p.base}/permission/${p.id}/reply`, { reply })
    if (!ok) throw new Error('OpenCode did not accept the permission response. The question is still pending.')
    this.apiPermission = undefined
    this.pollScreen()
    return ok
  }

  private async follow(path: string) {
    this.tail?.kill()
    this.transcript = path
    this.items = []
    this.meta = newMeta()
    this.pending = []
    this.ready = false
    const gen = ++this.generation
    if (path.startsWith('opencode://')) return this.followOpenCode(path, gen)
    if (isOcdb(path)) return this.followOpenCodeDb(path, gen)
    if (path.includes('/.gemini/tmp/')) return this.followDoc(path, gen, new GeminiDoc())
    if (path.includes('/.gemini/antigravity-cli/brain/')) return this.followDoc(path, gen, new AntigravityDoc())
    const t0 = performance.now()
    if (process.env.TETHER_DEBUG) console.log('[follow] start', this.key, path)
    const host = registry.host(this.hostId)
    const sizeRes = await host.exec(`wc -c < ${shq(path)} 2>/dev/null || echo 0`)
    if (gen !== this.generation || this.stopped) return
    let remaining = Number(sizeRes.stdout.trim()) || 0
    let seq = 0
    const codex = this.agent === 'codex' || /\/\.codex\/sessions\//.test(path)
    // a Codex segment file starts after a rewind: show the history it continues first
    if (codex) {
      for (const line of await codexHistory(host, path).catch(() => [] as string[])) {
        try {
          this.items.push(...normalizeCodex(JSON.parse(line), this.meta).map((d) => ({ ...d, seq: seq++ }) as ChatItem))
          this.trim()
        } catch {}
      }
      if (gen !== this.generation || this.stopped) return
    }
    const finishInitial = () => {
      if (this.ready || gen !== this.generation) return
      if (process.env.TETHER_DEBUG) console.log('[follow] ready', this.key, Math.round(performance.now() - t0), 'ms', this.items.length, 'items')
      this.ready = true
      this.publishInfo()
      this.broadcast(this.resetMsg())
    }
    // If the file is empty or tail never catches up, still show what we have.
    const fallback = setTimeout(finishInitial, remaining ? 8000 : 0)
    this.tail = host.stream(`exec tail -c +1 -F ${shq(path)} 2>/dev/null`, (line) => {
      if (gen !== this.generation) return
      remaining -= Buffer.byteLength(line) + 1
      let entry: any
      try {
        entry = JSON.parse(line)
      } catch {
        return
      }
      const items = (codex ? normalizeCodex(entry, this.meta) : this.agent === 'copilot' ? normalizeCopilot(entry, this.meta) : normalize(entry, this.meta)).map((d) => ({ ...d, seq: seq++ }) as ChatItem)
      if (items.length) {
        this.items.push(...items)
        this.trim()
        if (this.ready) this.queue(items)
      }
      if (!this.ready && remaining <= 0) {
        clearTimeout(fallback)
        finishInitial()
      } else if (this.ready) {
        this.scheduleInfo()
      }
    })
  }

  private infoTimer?: ReturnType<typeof setTimeout>
  private scheduleInfo() {
    if (this.infoTimer) return
    this.infoTimer = setTimeout(() => {
      this.infoTimer = undefined
      this.publishInfo()
    }, 150)
  }

  private queue(items: ChatItem[]) {
    this.pending.push(...items)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined
        const batch = this.pending
        this.pending = []
        if (batch.length) this.broadcast({ t: 'chat.append', key: this.key, items: batch })
      }, 60)
    }
  }

  private changeTimer?: ReturnType<typeof setTimeout>
  /** The pane printed something: re-read the screen soon (coalescing bursts of output). */
  screenChanged() {
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined
      this.pollScreen()
    }, 120)
  }

  async pollScreen() {
    if (this.stopped) return
    clearTimeout(this.screenTimer)
    try {
      const host = registry.host(this.hostId)
      const caps = await capturePanes(host, [this.paneId])
      const lines = caps.get(this.paneId)
      const pane = registry.findPane(this.hostId, this.paneId)?.pane
      if (lines && pane?.agent) {
        const screen = parseScreen(lines, pane.width, pane.agent!.kind)
        // a menu Tether is working through itself stays out of the app
        if (isDriving(this.hostId, this.paneId) && screen.prompt) {
          screen.prompt = undefined
          screen.inputVisible = this.screen.inputVisible
        }
        if (pane.agent.kind === 'opencode' && pane.agent.transcriptPath?.startsWith('opencode://')) {
          const live = await opencodeLive(host, pane.agent.transcriptPath, pane.cwd).catch(() => undefined)
          if (live) {
            screen.working = live.working
            screen.activity = live.retrying ? 'Retrying' : live.working ? 'Working' : undefined
            screen.model = live.selection.model
            screen.effort = live.selection.variant
            screen.mode = live.selection.agent
          }
        }
        if (this.apiPermission) {
          screen.prompt = {
            body: [this.apiPermission.title, ...(this.apiPermission.detail ? ['╌', this.apiPermission.detail, '╌'] : [])],
            options: [
              { n: 1, label: 'Allow once', selected: true },
              { n: 2, label: 'Always allow', selected: false },
              { n: 3, label: 'Reject', selected: false },
            ],
            multi: false,
            api: true,
          }
        }
        const json = JSON.stringify(screen)
        if (json !== this.screenJson) {
          this.screenJson = json
          this.screen = screen
          this.broadcast({ t: 'chat.screen', key: this.key, screen })
          if (MIRRORS.has(pane.agent.kind)) this.syncDraftFromScreen()
          // agy says whether Remote Control is on only on screen; keep the last word after it scrolls away
          const remoteChanged = screen.remote !== undefined && (screen.remote ?? undefined) !== this.remote?.url
          if (remoteChanged) this.remote = screen.remote ? { url: screen.remote, ts: new Date().toISOString() } : undefined
          if (screen.queue || this.info.queue.length || remoteChanged) this.publishInfo()
        }
      } else if (this.screenJson !== 'none') {
        this.screenJson = 'none'
        this.screen = { working: false, width: 0 }
        this.broadcast({ t: 'chat.screen', key: this.key, screen: this.screen })
      }
    } catch {}
    if (!this.stopped) this.screenTimer = setTimeout(() => this.pollScreen(), SCREEN_MS)
  }

  stop() {
    this.stopped = true
    this.tail?.kill()
    clearTimeout(this.screenTimer)
    clearTimeout(this.flushTimer)
    clearTimeout(this.idleTimer)
  }
}

class Watchers {
  private map = new Map<string, ChatWatcher>()

  constructor() {
    registry.on((e) => {
      if (e.type === 'overview') for (const w of this.map.values()) w.sync()
      if (e.type === 'hook') this.map.get(chatKey(e.host, e.pane))?.pollScreen()
      if (e.type === 'pane-output') this.map.get(chatKey(e.host, e.pane))?.screenChanged()
    })
  }

  get(hostId: string, paneId: string) {
    const key = chatKey(hostId, paneId)
    let w = this.map.get(key)
    if (!w) this.map.set(key, (w = new ChatWatcher(hostId, paneId)))
    return w
  }

  peek(hostId: string, paneId: string) {
    return this.map.get(chatKey(hostId, paneId))
  }

  stop(key: string) {
    this.map.get(key)?.stop()
    this.map.delete(key)
  }
}

export const watchers = new Watchers()
