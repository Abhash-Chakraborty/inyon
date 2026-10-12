// Types shared by the hub (apps/hub) and the client (apps/web).
import type { AgentKind } from './agents.ts'

export * from './agents.ts'
export * from './versions.ts'

/** local: the hub itself · ssh: the hub connects out over SSH · node: the machine connects in to the hub (no open ports) */
export type HostKind = 'local' | 'ssh' | 'node' | 'link'

export interface HostConfig {
  id: string
  name: string
  kind: HostKind
  /** ssh only: `user@host` or an alias from ~/.ssh/config */
  target?: string
  port?: number
  identityFile?: string
  /** ssh from the phone app: the server's host key fingerprint, confirmed when it was added */
  hostKey?: string
  /**
   * ssh from the phone app: how it signs in (the secret itself stays in the phone's keystore).
   * "none" is for servers that let you in without a key or password (Tailscale SSH, an account
   * with an empty password).
   */
  auth?: 'phone-key' | 'password' | 'key' | 'none'
  /**
   * ssh from the phone app: the id of a paired computer that opens the connection instead of the
   * phone, with its own keys and ~/.ssh/config, for servers only it can reach. `target` may then
   * be an alias from that config.
   */
  via?: string
  /** node only: sha256 of the pairing token (the token itself is never stored) */
  tokenHash?: string
  /** node only: when the machine first connected with its token (unset while the command hasn't run) */
  pairedAt?: number
  /** node only: when its current token was made; one that's never used stops working after a day */
  tokenIssuedAt?: number
  /** link only (a laptop the phone app paired with directly): its id, from `inyon pair` */
  machineId?: string
  /** link only: where it was last reachable, and the relays it uses */
  urls?: string[]
  relays?: string[]
  /** put the Claude integration back when something replaces ~/.claude/settings.json */
  keepIntegration?: boolean
}

export type HostStatus = 'connecting' | 'online' | 'error'

export type AgentState = 'idle' | 'working' | 'waiting' | 'unknown'

export interface RateWindow {
  pct: number
  /** unix seconds */
  resetsAt?: number
}

/** Live numbers the agent reports (Claude: its status line payload; Codex: token_count events). */
export interface AgentStatus {
  model?: string
  modelId?: string
  effort?: string
  fast?: boolean
  version?: string
  contextPct?: number
  contextUsed?: number
  contextSize?: number
  costUsd?: number
  durationMs?: number
  apiDurationMs?: number
  linesAdded?: number
  linesRemoved?: number
  fiveHour?: RateWindow
  sevenDay?: RateWindow
  /** prepaid credits (Codex): a balance, or unlimited */
  credits?: { balance?: string; unlimited?: boolean }
  /** plan name when the agent reports it */
  plan?: string
  outputStyle?: string
  /**
   * Why some numbers are missing: the account changed since the limits were reported, or the
   * conversation was compacted since the context was. Both refill on the agent's next reply.
   */
  stale?: { limits?: 'account'; context?: 'compacted' }
  /** unix ms of the last update */
  updatedAt: number
}

export interface AgentPaneInfo {
  kind: AgentKind
  pid: number
  sessionId?: string
  transcriptPath?: string
  /** where the pane → session mapping came from */
  mappedBy?: 'hook' | 'cwd' | 'resume' | 'process'
  state: AgentState
  /** e.g. "manual", "plan", "accept edits" */
  mode?: string
  /** short text for the overview, e.g. the permission being asked */
  waitingFor?: string
  /** answers offered by the prompt on screen (single-choice prompts only), for quick replies */
  options?: { n: number; label: string }[]
  /** working spinner text */
  activity?: string
  /** background shells or tasks still running while the agent itself waits, e.g. "1 shell" */
  background?: string
  status?: AgentStatus
  /**
   * The integration is on but this session stopped sending live numbers (its settings changed
   * under it). Resuming the session fixes it; the hub does that itself once it's safe.
   */
  statusStopped?: boolean
  startedAt?: number
}

export interface PaneInfo {
  id: string // tmux pane id, e.g. "%12"
  index: number
  active: boolean
  command: string
  cwd: string
  title: string
  /** the name you gave this session in Inyon */
  label?: string
  width: number
  height: number
  dead: boolean
  agent?: AgentPaneInfo
}

export interface WindowInfo {
  id: string // "@3"
  index: number
  name: string
  active: boolean
  activity: number
  panes: PaneInfo[]
}

export interface SessionInfo {
  id: string // "$1"
  name: string
  attached: number
  windows: WindowInfo[]
}

export type IntegrationState = 'unknown' | 'installed' | 'missing' | 'removed' | 'outdated'

/** Inyon's version, the same for the app, the hub and the inyon program (the root package.json's). */
export const VERSION = '0.8.0'

/**
 * A machine's inyon that can be updated from the app, or an update the app started. `latest` is the
 * hub's own version for a machine paired with the hub, the newest release for a phone-paired one.
 */
export interface NodeUpdate {
  latest: string
  /** false for an inyon (or tether-node) too old to update itself (its setup command has to be run again) */
  supported: boolean
  state?: 'updating' | 'updated' | 'failed'
  error?: string
}

export interface HostState {
  config: HostConfig
  status: HostStatus
  error?: string
  /** hostname reported by the machine */
  hostname?: string
  /**
   * Claude Code integration: `removed` when its scripts are there but ~/.claude/settings.json no
   * longer points at them (the file was replaced), `outdated` when the scripts are an older version.
   */
  integration: IntegrationState
  /** Antigravity has its own settings and status wrapper. */
  agyIntegration?: IntegrationState
  tmux: 'unknown' | 'ok' | 'no-server' | 'missing'
  /** agent CLIs found on PATH */
  agents: AgentKind[]
  /** agents with a saved sign-in on the machine (unknown until the first probe) */
  signedIn?: AgentKind[]
  os?: string
  /** the inyon version a paired machine or laptop runs */
  nodeVersion?: string
  /** set when that inyon is behind, or while an update runs */
  nodeUpdate?: NodeUpdate
  latencyMs?: number
  sessions: SessionInfo[]
  updatedAt: number
  /** last successful check (ms); kept across hub restarts */
  lastSeen?: number
  /** when the machine stopped answering; its sessions are the last ones seen, saved on disk */
  offlineSince?: number
}

// ---------- Chat (normalized Claude Code transcript) ----------

export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }

export interface ToolResultMeta {
  /** Edit/Write/MultiEdit: unified hunks */
  patch?: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]
  filePath?: string
  /** Write: created a new file */
  created?: boolean
  stdout?: string
  stderr?: string
  interrupted?: boolean
  /** AskUserQuestion */
  answers?: Record<string, string>
  /** ExitPlanMode */
  plan?: string
  /** Read */
  numLines?: number
  /** Bash/Monitor run in the background: the task it started (see ChatInfo.tasks) */
  taskId?: string
}

export type ChatItem =
  | { kind: 'user'; seq: number; uuid: string; ts: string; text: string; images: number; queued?: boolean; shell?: boolean }
  | { kind: 'assistant'; seq: number; uuid: string; ts: string; msgId: string; model?: string; block: AssistantBlock }
  | { kind: 'tool_result'; seq: number; uuid: string; ts: string; toolUseId: string; isError: boolean; text: string; truncated?: boolean; meta?: ToolResultMeta }
  | { kind: 'command'; seq: number; uuid: string; ts: string; name: string; args: string; output?: string }
  | { kind: 'notice'; seq: number; uuid: string; ts: string; level: 'info' | 'warn' | 'error'; subtype: string; text: string }
  | { kind: 'turn_end'; seq: number; uuid: string; ts: string; durationMs: number }
  | { kind: 'goal'; seq: number; uuid: string; ts: string; condition: string; met: boolean; reason?: string; cleared?: boolean }

export interface BackgroundTask {
  id: string
  type: 'shell' | 'monitor' | 'workflow' | 'other'
  description: string
  command?: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  outputFile?: string
  summary?: string
  startedAt?: string
  endedAt?: string
}

export interface SubagentInfo {
  toolUseId: string
  type?: string
  description: string
  prompt?: string
  status: 'running' | 'done' | 'error'
  background?: boolean
  startedAt?: string
  transcriptPath?: string
}

export interface ArtifactInfo {
  url: string
  title?: string
  updatedAt?: string
}

export interface SessionStats {
  contextTokens?: number
  costUsd?: number
  durationMs?: number
  apiDurationMs?: number
  linesAdded?: number
  linesRemoved?: number
  turns: number
  compactions: number
  /** unix ms of the last compaction */
  compactedAt?: number
  /** unix ms of the event `contextTokens` came from */
  contextAt?: number
  startedAt?: string
}

/**
 * One message sent through Inyon. The hub knows the exact text it typed, so it is the one that
 * matches it to the agent's record; every device reads the outcome from here.
 * sending: being typed · sent: submitted, not yet in the agent's record · queued: in the agent's
 * queue while it works · delivered: in the conversation (`uuid` is that item) · failed: `error`
 */
export interface SendState {
  id: string
  text: string
  at: number
  state: 'sending' | 'sent' | 'queued' | 'delivered' | 'failed'
  uuid?: string
  error?: string
  /** a change made with the app's controls (model, effort, goal…): followed, but not shown as a message */
  setting?: boolean
}

export interface ChatInfo {
  /** Live metrics from transcript/API adapters. */
  status?: AgentStatus
  hostId: string
  paneId: string
  agent?: AgentKind
  title?: string
  sessionId?: string
  transcriptPath?: string
  cwd?: string
  model?: string
  gitBranch?: string
  version?: string
  /** the agent process is (still) running in the pane */
  running: boolean
  mappedBy?: 'hook' | 'cwd' | 'resume' | 'process'
  error?: string
  goal?: { condition: string; met: boolean; reason?: string; ts: string }
  rc?: { url: string; ts: string }
  /** messages typed while the agent was busy, not yet picked up */
  queue: string[]
  /** recent sends and how far each got, matched by the hub against the agent's own record */
  sends?: SendState[]
  tasks: BackgroundTask[]
  subagents: SubagentInfo[]
  artifacts: ArtifactInfo[]
  stats: SessionStats
  mode?: string
}

export interface PromptOption {
  n: number
  label: string
  detail?: string
  selected: boolean
  /** multi-select checkbox state; undefined for single-select */
  checked?: boolean
  /** what's set now, in a settings picker (Codex marks it "(current)") */
  current?: boolean
}

export interface ScreenPrompt {
  /** text above the options (title, command, question) */
  body: string[]
  options: PromptOption[]
  /** AskUserQuestion tab strip */
  tabs?: { label: string; done: boolean; current: boolean }[]
  footer?: string
  multi: boolean
  /** the option number of a free-text "Type something" entry */
  freeTextOption?: number
  /** options aren't numbered on screen: answer by moving the cursor (↑/↓) and pressing Enter */
  navigate?: boolean
  /** the dialog asks for typed input (e.g. "Paste code here if prompted >") */
  input?: { label: string }
  /** URLs shown in the dialog, re-joined when the terminal wrapped them */
  links?: string[]
  /** answered through the agent's API rather than keystrokes (OpenCode permissions) */
  api?: boolean
}

/**
 * Which question a prompt is: its text and its choices, whitespace aside (the screen rewraps). An
 * answer carries the key of the question it was given for, so a tap that arrives after that
 * question was answered elsewhere never lands on the next one, which often has the same numbers.
 */
export const promptKey = (p: Pick<ScreenPrompt, 'body' | 'options'>) =>
  [...p.body, ...p.options.map((o) => `${o.n}.${o.label}`)].join('\n').replace(/\s+/g, '')

export interface ScreenState {
  /** A recognizable input box is present, even with a custom footer. */
  inputVisible?: boolean
  /** a menu/prompt is waiting for an answer */
  prompt?: ScreenPrompt
  working: boolean
  /** spinner line, e.g. "Undulating… (12s · thinking)" */
  activity?: string
  mode?: string
  /** text sitting in Claude's input box (typed but not sent) */
  draft?: string
  /** Remote Control as the screen last reported it: its link while on, null once turned off (agy) */
  remote?: string | null
  /** background shells/monitors listed under the input box, which die if the agent restarts */
  background?: string
  /** messages waiting to be sent after the current turn, when only the screen shows them (Antigravity) */
  queue?: string[]
  /** model and effort from the agent's own footer, for sessions that don't report live numbers */
  model?: string
  effort?: string
  width: number
}

// ---------- WebSocket protocol ----------

export type ClientMsg =
  | { t: 'sub.overview' }
  | { t: 'sub.chat'; host: string; pane: string }
  | { t: 'unsub.chat'; host: string; pane: string }
  | { t: 'chat.more'; host: string; pane: string; before: number }
  | { t: 'draft'; host: string; pane: string; text: string }
  | { t: 'term.open'; id: string; host: string; pane: string; cols: number; rows: number }
  | { t: 'term.in'; id: string; d: string }
  | { t: 'term.resize'; id: string; cols: number; rows: number }
  | { t: 'term.close'; id: string }
  | { t: 'ping' }

export type ServerMsg =
  | { t: 'overview'; hosts: HostState[] }
  | { t: 'chat.reset'; key: string; info: ChatInfo; items: ChatItem[]; hasMore: boolean }
  | { t: 'chat.append'; key: string; items: ChatItem[] }
  | { t: 'chat.more'; key: string; items: ChatItem[]; hasMore: boolean }
  | { t: 'chat.info'; key: string; info: ChatInfo }
  | { t: 'chat.screen'; key: string; screen: ScreenState }
  /**
   * Reading what was said while nobody was watching (bytes of the transcript read so far, of how
   * many). The chat shows what it had until a chat.reset brings everything at once.
   */
  | { t: 'chat.progress'; key: string; done: number; total: number }
  /** the unsent message for a pane, shared by the app (every device) and the terminal's input box */
  | { t: 'chat.draft'; key: string; text: string; source: 'app' | 'terminal'; at: number }
  | { t: 'term.data'; id: string; d: string }
  | { t: 'term.exit'; id: string; reason?: string }
  | { t: 'notify'; host: string; pane: string; kind: 'waiting' | 'done' | 'offline' | 'online'; title: string; body: string; agent?: AgentKind }
  | { t: 'pong' }

export const chatKey = (host: string, pane: string) => `${host}:${pane}`
