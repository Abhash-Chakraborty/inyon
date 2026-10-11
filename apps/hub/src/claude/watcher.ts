import { OpenCodeClient } from '../agents/opencode-api.ts'
import { opencodeSelection, opencodeLive } from '../agents/opencode-controls.ts'
import type { AgentKind, ChatInfo, ChatItem, ScreenState, SendState, ServerMsg } from '@tether/protocol'
import { isDriving, startDriving } from './driving.ts'
import { SendLedger } from './delivery.ts'
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
import { loadMeta, newMeta, normalize, saveMeta, type TranscriptMeta } from './transcript.ts'
import { parseScreen } from './screen.ts'
import { hasPastePreview, inputContains } from './delivery.ts'
import { getDraft, mirrorToTerminal, setDraft, squash } from './drafts.ts'
import { KEEP as CACHE_KEEP, loadChat, saveChat } from './chat-cache.ts'
import { metaCommand, parseSize, rangeCommand, sizeCommand, tailCommand, TranscriptReader } from './transcript-tail.ts'

const DEBUG = typeof process !== 'undefined' && !!process.env?.TETHER_DEBUG

const PAGE = 160
/** messages kept per open chat; older ones stay in the transcript file (and the terminal) */
const KEEP = 4000
/** fallback screen poll; tmux control mode triggers re-reads as soon as the pane changes */
const SCREEN_MS = 2000
const IDLE_SHUTDOWN_MS = 120_000
/** agents whose input box Tether can read and retype, so a draft follows you between app and terminal */
const MIRRORS = new Set<AgentKind>(['claude', 'codex', 'antigravity', 'opencode', 'copilot'])

/** a closed chat's state is kept this long, so opening it again carries on instead of re-reading */
const PARK_MS = 30 * 60_000
const PARKED_MAX = 6
/** more than this to read on: catch up out of sight and show the result at once */
const CATCHUP_BYTES = 64 * 1024
/** a read that hasn't reached the end by then is shown as far as it got, if nothing more arrives */
const FIRST_LINE_MS = 8000
/**
 * A long Claude conversation opens on its last stretch of file, and earlier messages are read
 * backwards, a piece at a time, as you scroll up. Messages read that way are numbered down from
 * TAIL_SEQ, so they still sort before the ones after them. The stretch is small so the chat shows
 * quickly; a page is filled in from before it once it's on screen.
 */
const TAIL_BYTES = 256_000
const OLDER_BYTES = 1_000_000
const TAIL_SEQ = 1_000_000_000
const QUIET_MS = 5000

/** What a stopped watcher leaves behind for the next one on the same pane. */
interface Parked {
  at: number
  transcript: string
  reader: TranscriptReader
  seq: number
  codex: boolean
  agent?: AgentKind
  items: ChatItem[]
  meta: TranscriptMeta
  info: ChatInfo
  older?: number
}

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
  private tail?: { kill(): void; exited?: Promise<number> }
  /** the transcript tail ended by itself (the machine dropped off): follow again once it's back */
  private tailLost = false
  private transcript?: string
  /** how far into the transcript file it has read, so a dropped tail can carry on from there */
  private reader?: TranscriptReader
  private seq = 0
  /** file offset of the line the first held message came from; 0 when nothing is before it */
  private olderFrom?: number
  /** each held message's line in the file, so trimming from the front knows where it cut */
  private lineAt = new Map<number, number>()
  /** opened on the last stretch and no line read yet: the first one read is where older ones end */
  private tailStart = false
  /**
   * Lines read since a long conversation opened, while the summary of the part before them is
   * still on its way. Once it lands they're replayed onto it, so it ends up as a full read's.
   */
  private replay?: any[]
  private codex = false
  private ready = false
  /**
   * Reading a backlog (what was said while nobody watched): updates are held back and one reset
   * brings the result, so the chat doesn't replay hours of messages and passing states (a goal
   * since met) don't flash by. Meanwhile new subscribers get the chat as it was before.
   */
  private behind?: ServerMsg
  /**
   * A saved (or parked) copy's goal may have been met or cleared since. Until what was written in
   * the meantime is read, no goal shows, so an old one doesn't flash up and vanish.
   */
  private goalUnsure = false
  private history?: Promise<void>
  private pending: ChatItem[] = []
  private flushTimer?: ReturnType<typeof setTimeout>
  private screenTimer?: ReturnType<typeof setTimeout>
  private idleTimer?: ReturnType<typeof setTimeout>
  private stopped = false
  private screenJson = ''
  /** agy Remote Control, as last seen on screen */
  private remote?: { url: string; ts: string }
  private generation = 0

  constructor(public hostId: string, public paneId: string, parked?: Parked) {
    this.key = chatKey(hostId, paneId)
    this.info = this.emptyInfo()
    if (parked) this.unpark(parked)
    else this.fromCache()
    this.sync()
    this.pollScreen()
  }

  private onRemoteHost() {
    return registry.get(this.hostId)?.host.config.kind !== 'local'
  }

  /**
   * The saved copy of this conversation: when it says where reading stopped (and the pane still
   * has that transcript) carry on from there. Otherwise it's only shown while the machine isn't
   * answering, if it's this session.
   */
  private fromCache() {
    const cached = loadChat(this.key)
    const agent = registry.findPane(this.hostId, this.paneId)?.pane.agent
    if (!cached || (agent?.sessionId && agent.sessionId !== cached.sessionId)) return
    const at = cached.at
    // a Claude chat saved before long conversations opened on their last stretch doesn't say where
    // its first message is in the file; reading it afresh is quick now, scrolling up from it isn't
    const outdated = at && !at.codex && at.agent !== 'copilot' && at.older === undefined
    if (at && !outdated && cached.transcript && cached.items.length && (!agent?.transcriptPath || agent.transcriptPath === cached.transcript)) {
      try {
        const meta = loadMeta(at.meta)
        return this.unpark({ at: cached.savedAt, transcript: cached.transcript, reader: new TranscriptReader(at.offset), seq: at.seq, codex: at.codex, agent: at.agent, items: cached.items, meta, info: cached.info, older: at.older })
      } catch {}
    }
    const rt = registry.get(this.hostId)
    if (!rt || rt.state.status === 'online' || !this.onRemoteHost()) return
    this.items = cached.items
    // without the session id the copy may be an older conversation in this pane: show what was
    // said, but not a goal or queue that may be long gone
    const sure = !!agent?.sessionId
    this.info = { ...cached.info, running: !!agent, ...(sure ? {} : { goal: undefined, queue: [] }) }
    this.ready = true
  }

  /** Picks up where the last watcher on this pane stopped; sync() then follows the file from there. */
  private unpark(p: Parked) {
    Object.assign(this, { transcript: p.transcript, reader: p.reader, seq: p.seq, codex: p.codex, agent: p.agent, items: p.items, meta: p.meta, info: { ...p.info, goal: undefined }, olderFrom: p.older })
    this.goalUnsure = true
    this.ready = true
    this.tailLost = true
  }

  park(): Parked | undefined {
    if (!this.ready || !this.reader || !this.transcript) return
    return { at: Date.now(), transcript: this.transcript, reader: this.reader, seq: this.seq, codex: this.codex, agent: this.agent, items: this.items, meta: this.meta, info: this.info, older: this.olderFrom }
  }

  private cacheTimer?: ReturnType<typeof setTimeout>
  /** Keeps the saved copy of the conversation current (at most every 10 s). */
  private cacheLater() {
    if (this.cacheTimer) return
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = undefined
      if (this.stopped || !this.items.length) return
      // still loading: try again once the whole conversation is in
      if (!this.ready) return this.cacheLater()
      this.save()
    }, 10_000)
  }

  save() {
    // a summary still missing the part before the last stretch would be saved as if it were whole:
    // wait for it
    if (this.replay) return this.cacheLater()
    if (!this.ready || !this.items.length) return
    // the read position is saved only with the summary and messages read up to it
    // only the latest messages are saved: cut between lines and remember where the first one starts
    let first = Math.max(0, this.items.length - CACHE_KEEP)
    let older = this.olderFrom
    if (first > 0 && older !== undefined) {
      const line = (i: number) => this.lineAt.get(this.items[i]!.seq)
      // messages restored from a saved copy have no known line, so the cut moves on past them too;
      // with none known the copy is saved without a place and read afresh next time
      while (first < this.items.length && (line(first) === undefined || line(first) === line(first - 1))) first++
      older = first < this.items.length ? line(first) : undefined
      if (older === undefined) first = Math.max(0, this.items.length - CACHE_KEEP)
    }
    const at = this.reader && this.transcript ? { offset: this.reader.offset, seq: this.seq, codex: this.codex, agent: this.agent, meta: saveMeta(this.meta), older } : undefined
    if (!at && !this.onRemoteHost()) return
    saveChat(this.key, { sessionId: this.info.sessionId, transcript: this.transcript, info: this.info, items: this.items.slice(first), at })
  }

  private emptyInfo(): ChatInfo {
    return { hostId: this.hostId, paneId: this.paneId, running: false, queue: [], tasks: [], subagents: [], artifacts: [], stats: { turns: 0, compactions: 0 } }
  }

  subscribe(s: Subscriber) {
    clearTimeout(this.idleTimer)
    this.subs.add(s)
    if (this.behind) s.send(this.behind)
    else if (this.ready) s.send(this.resetMsg())
    else s.send({ t: 'chat.info', key: this.key, info: this.info })
    if (this.progress) s.send(this.progress)
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

  /** the last message sent from here, and when, to tell a stale draft of it from a new one */
  private lastSent?: { text: string; at: number }

  /** Text typed in the app: save it, share it with other devices, and mirror it into the terminal. */
  draftFromApp(text: string, from?: Subscriber) {
    // A phone's keyboard can put a message back in the box just after it was sent, and the app
    // passes that on as a draft. It isn't one: keep the box empty, and tell that app so.
    const ls = this.lastSent
    if (ls && Date.now() - ls.at < 5000 && squash(text) && squash(ls.text).endsWith(squash(text))) {
      const d = getDraft(this.key)
      from?.send({ t: 'chat.draft', key: this.key, text: d?.text ?? '', source: d?.source ?? 'app', at: Date.now() })
      return
    }
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
    // a paste preview in the box is this draft only if the mirror put this draft there
    if (squash(current) === squash(target) || target && inputContains(current, target, squash(d?.mirrored ?? '') === squash(target))) {
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
    if (text) this.lastSent = { text, at: Date.now() }
    clearTimeout(this.mirrorTimer)
    this.sendingUntil = Date.now() + 1500
    const current = getDraft(this.key)
    // with a start time, a draft written since survives unless it is this message (pushed just
    // before the send, arriving just after), or this message before its attached files were added
    const sent = !!text && !!current && (squash(text) === squash(current.text) || squash(text).startsWith(`${squash(current.text)}Attachedfiles:`))
    if (!text || !current || (startedAt ? current.at <= startedAt || sent : sent || squash(text).startsWith(squash(current.text)))) setDraft(this.key, undefined)
    else this.mirrorTimer = setTimeout(() => this.mirror(), 1600)
    this.broadcastDraft()
  }

  /** Following the agent's transcript, so `recorded` can be trusted. */
  get following() {
    return this.ready && !!this.transcript && !!this.tail
  }

  // ---------- sends (what reached the agent) ----------

  private ledger = new SendLedger()

  trackSend(id: string, text: string, setting = false) {
    this.ledger.track(id, text, this.items, setting)
    this.publishInfo()
  }

  settleSend(id: string, patch: Partial<Pick<SendState, 'state' | 'error'>>) {
    this.ledger.settle(id, patch)
    this.publishInfo()
  }

  delivery(id: string) {
    this.ledger.match(this.items, this.currentQueue())
    return this.ledger.get(id)
  }

  // Antigravity's queue is only on screen
  private currentQueue() {
    return this.meta.queue.length ? this.meta.queue : this.screen.queue ?? []
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

  /** Used without anyone watching (a send from elsewhere): stop later unless someone subscribes. */
  idleLater() {
    if (this.subs.size) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => watchers.stop(this.key), IDLE_SHUTDOWN_MS)
  }

  unsubscribe(s: Subscriber) {
    this.subs.delete(s)
    if (!this.subs.size) {
      this.idleTimer = setTimeout(() => watchers.stop(this.key), IDLE_SHUTDOWN_MS)
    }
  }

  /** A very long session keeps only its latest messages in memory (in chunks, not on every push). */
  private trim() {
    if (this.items.length > KEEP + 500) {
      let cut = this.items.length - KEEP
      if (this.olderFrom !== undefined) {
        // cut between lines, never inside one, and only where the line is known (or the read
        // back from the file couldn't join up): otherwise keep everything a while longer
        const line = (i: number) => this.lineAt.get(this.items[i]!.seq)
        while (cut < this.items.length && line(cut) !== undefined && line(cut) === line(cut - 1)) cut++
        const at = cut < this.items.length ? line(cut) : undefined
        if (at === undefined) return this.cacheLater()
        this.olderFrom = at
      }
      for (const it of this.items.splice(0, cut)) this.lineAt.delete(it.seq)
    }
    this.cacheLater()
  }

  async more(s: Subscriber, before: number) {
    let idx = this.items.findIndex((i) => i.seq >= before)
    if (idx === 0 && this.olderInFile()) {
      await (this.olderFrom !== undefined ? this.loadOlder() : this.loadHistory())
      idx = this.items.findIndex((i) => i.seq >= before)
    }
    const end = idx < 0 ? this.items.length : idx
    const start = Math.max(0, end - PAGE)
    s.send({ t: 'chat.more', key: this.key, items: this.items.slice(start, end), hasMore: start > 0 || this.olderInFile() })
  }

  /** Messages before the first one held (a saved copy, or a long session trimmed) are still in the file. */
  private olderInFile() {
    if (!this.reader || !this.transcript) return false
    if (this.olderFrom !== undefined) return this.olderFrom > 0
    const first = this.items[0]?.seq ?? 0
    return first > 0 && first < TAIL_SEQ
  }

  /**
   * Reads lines between two offsets of the transcript, each with the offset its line starts at.
   * `complete` says every line up to `to` arrived: a dropped connection or a timeout ends the
   * stream early, and taking that for the whole piece would leave a gap nothing reads again.
   */
  private async readRange(path: string, from: number, to: number) {
    const host = registry.host(this.hostId)
    const reader = new TranscriptReader(from)
    const out: { entry: any; at: number }[] = []
    const code = await new Promise<number>((done) => {
      const t = host.stream(rangeCommand(path, from, to, this.onRemoteHost()), (line) => {
        const r = reader.line(line)
        if (r?.entry) out.push({ entry: r.entry, at: reader.offset - r.bytes })
      })
      t.exited ? t.exited.then((c) => done(c ?? 0), () => done(-1)) : done(0)
      setTimeout(() => (t.kill(), done(-1)), 60_000)
    })
    return { lines: out, complete: code === 0 && reader.received === to }
  }

  /**
   * What's known about a conversation as a whole (title, goal, counts, tasks, subagents) from the
   * part before its last stretch: only the lines that carry it are sent, and what they say goes
   * into the summary, not the chat.
   */
  private async readMeta(path: string, to: number, meta: TranscriptMeta, from = 0) {
    const host = registry.host(this.hostId)
    const reader = new TranscriptReader(from)
    await new Promise<void>((done) => {
      const t = host.stream(metaCommand(path, to, this.onRemoteHost(), from), (line) => {
        const r = reader.line(line)
        if (r?.entry) normalize(r.entry, meta)
      })
      t.exited ? t.exited.then(() => done(), () => done()) : done()
      setTimeout(() => (t.kill(), done()), 30_000)
    })
  }

  /**
   * Earlier messages of a conversation opened on its last stretch: reads the file backwards from
   * the first held message, a piece at a time, until there's a page of them or the file begins.
   */
  private loadOlder() {
    return (this.history ??= (async () => {
      const path = this.transcript!
      const first = this.items[0]?.seq ?? TAIL_SEQ
      const older: { item: Omit<ChatItem, 'seq'>; at: number }[] = []
      let end = this.olderFrom!
      let span = OLDER_BYTES
      while (end > 0 && older.length < PAGE) {
        const from = Math.max(0, end - span)
        const { lines, complete } = await this.readRange(path, from, end)
        if (this.stopped || path !== this.transcript) return
        // nothing is kept from a read cut short: the next scroll up asks for the same piece again
        if (!complete) return
        if (!lines.length) {
          // one line longer than the piece (a screenshot): take a bigger piece
          if (from === 0) end = 0
          else span *= 4
          continue
        }
        // tool calls and their results sit close together, so a piece's own summary links them
        const meta = newMeta()
        const got: typeof older = []
        for (const { entry, at } of lines) for (const d of normalize(entry, meta)) got.push({ item: d as Omit<ChatItem, 'seq'>, at })
        older.unshift(...got)
        end = lines[0]!.at
      }
      if (this.stopped || path !== this.transcript || (this.items[0]?.seq ?? TAIL_SEQ) !== first) return
      let seq = first - older.length
      const items = older.map(({ item, at }) => {
        const it = { ...item, seq: seq++ } as ChatItem
        this.lineAt.set(it.seq, at)
        return it
      })
      this.items.unshift(...items)
      this.olderFrom = end
      this.tailStart = false
    })().finally(() => (this.history = undefined)))
  }

  /**
   * Reads the transcript from the start for the messages before the first one held. They're
   * numbered the same way as on the first read, so they join up with the rest.
   */
  private loadHistory() {
    return (this.history ??= (async () => {
      const path = this.transcript!
      const first = this.items[0]?.seq ?? 0
      const host = registry.host(this.hostId)
      const meta = newMeta()
      const older: ChatItem[] = []
      let seq = 0
      const add = (e: any) => {
        for (const d of this.codex ? normalizeCodex(e, meta) : this.agent === 'copilot' ? normalizeCopilot(e, meta) : normalize(e, meta)) {
          if (seq >= first) return false
          older.push({ ...d, seq: seq++ } as ChatItem)
        }
        return true
      }
      if (this.codex) for (const line of await codexHistory(host, path).catch(() => [] as string[])) try { add(JSON.parse(line)) } catch {}
      const reader = new TranscriptReader()
      await new Promise<void>((done) => {
        const t = host.stream(tailCommand(path, 0, this.onRemoteHost(), false), (line) => {
          const r = reader.line(line)
          if (r?.entry && !add(r.entry)) {
            t.kill()
            done()
          }
        })
        t.exited?.then(() => done())
        setTimeout(() => (t.kill(), done()), 120_000)
      })
      if (this.stopped || path !== this.transcript || this.items[0]?.seq !== first) return
      this.items.unshift(...older.slice(-Math.max(PAGE, KEEP - this.items.length)))
    })().finally(() => (this.history = undefined)))
  }

  private resetMsg(): ServerMsg {
    const start = Math.max(0, this.items.length - PAGE)
    return { t: 'chat.reset', key: this.key, info: this.info, items: this.items.slice(start), hasMore: start > 0 || this.olderInFile() }
  }

  private progress?: Extract<ServerMsg, { t: 'chat.progress' }>
  private progressAt = 0
  /** How far a read that's out of sight has got (at most a few times a second). */
  private reportProgress(done: number, total: number, force = false) {
    if (!force && Date.now() - this.progressAt < 400) return
    this.progressAt = Date.now()
    this.progress = total > 0 && done < total ? { t: 'chat.progress', key: this.key, done, total } : undefined
    this.broadcast(this.progress ?? { t: 'chat.progress', key: this.key, done: 0, total: 0 })
  }

  private broadcast(msg: ServerMsg) {
    for (const s of this.subs) s.send(msg)
  }

  /** Re-reads pane info from the registry; restarts the tail if the session changed. */
  sync() {
    const found = registry.findPane(this.hostId, this.paneId)
    const agent = found?.pane.agent
    if (agent?.kind) this.agent = agent.kind
    // a machine that isn't answering can't be read: keep what's shown (live or saved) until it's back
    const online = registry.get(this.hostId)?.state.status === 'online'
    if (online && agent?.transcriptPath && (agent.transcriptPath !== this.transcript || this.tailLost)) this.follow(agent.transcriptPath)
    if (!this.transcript && found && !agent?.transcriptPath) this.ready = true // nothing to read; show the empty state
    this.publishInfo()
  }

  /** What was written since the saved copy is read (and its summary is in): show the goal again. */
  private settleGoal() {
    if (!this.goalUnsure || this.replay) return
    this.goalUnsure = false
    this.publishInfo()
  }

  /** Builds ChatInfo from the pane and the transcript summary; broadcasts it when it changed. */
  private publishInfo() {
    this.ledger.match(this.items, this.currentQueue())
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
      goal: this.goalUnsure ? undefined : m.goal,
      rc: m.rc ?? this.remote,
      queue: [...this.currentQueue()],
      sends: this.ledger.list(),
      tasks: [...m.tasks.values()].slice(-40),
      subagents: [...m.subagents.values()].slice(-40),
      artifacts: [...m.artifacts.values()].slice(-40),
      stats: { ...m.stats, startedAt: m.stats.startedAt ?? (agent?.startedAt ? new Date(agent.startedAt).toISOString() : undefined) },
      error: !found ? 'This pane no longer exists' : undefined,
    }
    if (JSON.stringify(info) !== JSON.stringify(this.info)) {
      this.info = info
      if (this.ready && !this.behind) this.broadcast({ t: 'chat.info', key: this.key, info })
    }
  }

  /** Formats whose files are edited in place (Gemini) or read over an API (OpenCode): rebuild the whole view. */
  private snapshotTimer?: ReturnType<typeof setTimeout>
  private apiPermission?: { id: string; base: string; title: string; detail?: string }

  private publishSnapshot(items: ChatItem[]) {
    this.items = items
    // the whole conversation, read again: its goal is current
    this.goalUnsure = false
    this.cacheLater()
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
    this.watchTail(gen)
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
    this.watchTail(gen)
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

  private retryTimer?: ReturnType<typeof setTimeout>
  private retries = 0
  /** Notices when the current tail stops without being asked to (an SSH or paired link dropped). */
  private watchTail(gen: number) {
    const t = this.tail
    t?.exited?.then(() => {
      if (gen !== this.generation || this.tail !== t || this.stopped) return
      this.tailLost = true
      // try again soon rather than at the next poll; backing off if it keeps ending at once
      clearTimeout(this.retryTimer)
      this.retryTimer = setTimeout(() => !this.stopped && this.sync(), Math.min(30_000, 1000 * 2 ** this.retries++))
    })
  }

  private async follow(path: string) {
    const doc = path.startsWith('opencode://') || isOcdb(path) || path.includes('/.gemini/tmp/') || path.includes('/.gemini/antigravity-cli/brain/')
    // the same file again after a dropped connection: carry on from the byte where it stopped
    let again = !doc && path === this.transcript && this.ready && !!this.reader
    this.tail?.kill()
    this.tailLost = false
    this.transcript = path
    const gen = ++this.generation
    const restart = () => {
      this.items = []
      this.meta = newMeta()
      this.pending = []
      this.ready = false
      this.behind = undefined
      this.reader = undefined
      this.olderFrom = undefined
      this.lineAt.clear()
      this.tailStart = false
      this.replay = undefined
      this.goalUnsure = false
    }
    if (!again) restart()
    if (path.startsWith('opencode://')) return this.followOpenCode(path, gen)
    if (isOcdb(path)) return this.followOpenCodeDb(path, gen)
    if (path.includes('/.gemini/tmp/')) return this.followDoc(path, gen, new GeminiDoc())
    if (path.includes('/.gemini/antigravity-cli/brain/')) return this.followDoc(path, gen, new AntigravityDoc())
    const t0 = performance.now()
    if (DEBUG) console.log('[follow]', again ? 'resume' : 'start', this.key, path)
    const host = registry.host(this.hostId)
    const { size, aligned } = parseSize((await host.exec(sizeCommand(path, again ? this.reader!.offset : 0))).stdout)
    if (gen !== this.generation || this.stopped) return
    // shorter than what was read, or no line starts where it stopped: the file was rewritten (or
    // the count is off), so read it from the start rather than mid-line
    if (again && (size < this.reader!.offset || !aligned)) {
      again = false
      restart()
    }
    // away a long while (a saved copy from hours ago): rather than read everything said since, keep
    // the saved chat on screen and read only the last stretch, while the summary catches up from
    // the lines in between
    const claude = !this.codex && this.agent !== 'copilot' && this.olderFrom !== undefined
    const jump = again && claude && size - this.reader!.offset > TAIL_BYTES
    if (jump) {
      const saved = this.reader!.offset
      const from = size - TAIL_BYTES
      this.behind = this.resetMsg()
      this.publishInfo()
      const replay: any[] = (this.replay = [])
      const prefix = loadMeta(saveMeta(this.meta))
      void this.readMeta(path, from, prefix, saved).then(() => {
        if (gen !== this.generation || this.stopped || this.replay !== replay) return
        for (const e of replay) normalize(e, prefix)
        this.meta = prefix
        this.replay = undefined
        this.settleGoal()
        if (this.ready && !this.behind) {
          this.publishInfo()
          this.save()
        } else this.cacheLater()
      })
      this.items = []
      this.pending = []
      this.lineAt.clear()
      // above anything shown before, so nothing the app still holds is mistaken for these
      this.seq = Math.max(this.seq, TAIL_SEQ) + TAIL_SEQ
      this.reader = new TranscriptReader(from)
      this.olderFrom = size
      this.tailStart = true
    }
    if (!again) {
      this.seq = 0
      this.reader = new TranscriptReader()
      this.codex = this.agent === 'codex' || /\/\.codex\/sessions\//.test(path)
      if (!this.codex && this.agent !== 'copilot') {
        this.olderFrom = 0
        if (size > TAIL_BYTES) {
          // a long conversation: only its last stretch, shown as soon as it's in, while what's
          // known about it as a whole (title, goal, tasks) is read alongside
          const from = size - TAIL_BYTES
          const replay: any[] = (this.replay = [])
          const prefix = newMeta()
          void this.readMeta(path, from, prefix).then(() => {
            if (gen !== this.generation || this.stopped || this.replay !== replay) return
            for (const e of replay) normalize(e, prefix)
            this.meta = prefix
            this.replay = undefined
            this.settleGoal()
            if (this.ready && !this.behind) {
              this.publishInfo()
              this.save()
            } else this.cacheLater()
          })
          this.seq = TAIL_SEQ
          this.reader = new TranscriptReader(from)
          this.olderFrom = size
          this.tailStart = true
        }
      }
      // a Codex segment file starts after a rewind: show the history it continues first
      if (this.codex) {
        for (const line of await codexHistory(host, path).catch(() => [] as string[])) {
          try {
            this.items.push(...normalizeCodex(JSON.parse(line), this.meta).map((d) => ({ ...d, seq: this.seq++ }) as ChatItem))
            this.trim()
          } catch {}
        }
        if (gen !== this.generation || this.stopped) return
      }
    }
    const reader = this.reader!
    const total = size - reader.offset
    let remaining = total
    // nothing written since the saved copy: its goal stands
    if (remaining <= 0) this.settleGoal()
    // a lot was said meanwhile: read it out of sight, keeping the chat as it was until it's all in
    if (again && remaining > CATCHUP_BYTES && !jump) {
      this.publishInfo()
      this.behind = this.resetMsg()
    }
    const reading = () => !this.ready || !!this.behind
    let filling = false
    const finishInitial = () => {
      clearTimeout(quiet)
      if (!reading() || gen !== this.generation) return
      // short of a page: with nothing at all to show (the stretch was one screenshot), read back
      // first; otherwise show what's there now and fill the page in from before it
      const short = this.seq >= TAIL_SEQ && this.items.length < PAGE && this.olderInFile() && !filling
      if (short && !this.items.length) {
        filling = true
        void this.loadOlder().finally(finishInitial)
        return
      }
      if (short) {
        filling = true
        void this.loadOlder().then(() => {
          if (gen === this.generation && this.ready && !this.behind) this.broadcast(this.resetMsg())
          this.save()
        })
      }
      if (DEBUG) console.log('[follow] ready', this.key, Math.round(performance.now() - t0), 'ms', this.items.length, 'items')
      this.ready = true
      this.behind = undefined
      this.progress = undefined
      this.publishInfo()
      this.broadcast(this.resetMsg())
      // saved at once, not 10 s later: an app closed before then would read it all again next time
      this.save()
    }
    // If the file is empty or tail never catches up, still show what we have once it goes quiet.
    let quiet = reading() ? setTimeout(finishInitial, remaining > 0 ? FIRST_LINE_MS : 0) : undefined
    if (reading() && remaining > 0) this.reportProgress(0, total, true)
    // a remote machine leaves out image data, which is most of a long session's file; its tail ends
    // when stdin closes, since closing the connection alone doesn't stop it there
    const remote = this.onRemoteHost()
    this.tail = host.stream(tailCommand(path, reader.offset, remote), (line) => {
      if (gen !== this.generation) return
      const r = reader.line(line)
      if (!r) return
      this.retries = 0
      remaining -= r.bytes
      // once this line's entry is in the summary, not before: it may be the goal being met
      if (remaining <= 0) queueMicrotask(() => gen === this.generation && this.settleGoal())
      if (r.entry) {
        const e = r.entry
        const at = reader.offset - r.bytes
        if (this.tailStart) {
          this.olderFrom = at
          this.tailStart = false
        }
        this.replay?.push(e)
        const items = (this.codex ? normalizeCodex(e, this.meta) : this.agent === 'copilot' ? normalizeCopilot(e, this.meta) : normalize(e, this.meta)).map((d) => ({ ...d, seq: this.seq++ }) as ChatItem)
        if (this.olderFrom !== undefined) for (const it of items) this.lineAt.set(it.seq, at)
        if (items.length) {
          this.items.push(...items)
          this.trim()
          if (!reading()) this.queue(items)
        }
      }
      if (reading()) {
        clearTimeout(quiet)
        if (remaining <= 0) finishInitial()
        else {
          quiet = setTimeout(finishInitial, QUIET_MS)
          this.reportProgress(total - remaining, total)
        }
      } else {
        this.scheduleInfo()
      }
    }, { keepStdin: remote })
    this.watchTail(gen)
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
    clearTimeout(this.cacheTimer)
    clearTimeout(this.retryTimer)
    if (registry.get(this.hostId)?.state.status === 'online') this.save()
    this.tail?.kill()
    clearTimeout(this.screenTimer)
    clearTimeout(this.flushTimer)
    clearTimeout(this.idleTimer)
  }
}

class Watchers {
  private map = new Map<string, ChatWatcher>()
  private parked = new Map<string, Parked>()

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
    if (!w) {
      const p = this.parked.get(key)
      this.parked.delete(key)
      this.map.set(key, (w = new ChatWatcher(hostId, paneId, p && Date.now() - p.at < PARK_MS ? p : undefined)))
    }
    return w
  }

  /** Saves every open chat now (the app is going to the background and may not come back). */
  saveAll() {
    for (const w of this.map.values()) w.save()
  }

  peek(hostId: string, paneId: string) {
    return this.map.get(chatKey(hostId, paneId))
  }

  stop(key: string) {
    const w = this.map.get(key)
    if (!w) return
    const p = w.park()
    w.stop()
    this.map.delete(key)
    if (!p) return
    this.parked.set(key, p)
    for (const k of this.parked.keys()) if (this.parked.size > PARKED_MAX) this.parked.delete(k)
  }
}

export const watchers = new Watchers()
