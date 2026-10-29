// Generated from crates/inyon-protocol by `cargo test -p inyon-protocol --test gen`. Don't edit it:
// change the Rust types, run that test and commit what it writes. gen-check.ts compares these
// types with the hand-written ones in index.ts.

export type AgentKind = "claude" | "codex" | "opencode" | "copilot" | "gemini" | "antigravity" | "cursor" | "grok" | "pi" | "amp" | "goose" | "hermes" | "kimi" | "kiro" | "qwen" | "qoder" | "codebuddy";

export type SkinTokens = { bg: string, panel: string, raised: string, hover: string, line: string, lineStrong: string, fg: string, fg2: string, fg3: string, accent: string, accentFg: string, accentSoft: string, accentText: string, bubble: string, code: string, };

export type CommandSource = "built-in" | "skill" | "project" | "user" | "plugin";

export type SlashCommand = { name: string, description: string, source: CommandSource, 
/**
 * runs immediately when picked (no arguments expected)
 */
instant?: boolean, };

export type AgentModel = { id: string, label: string, note?: string, context?: number, 
/**
 * Advertised choices for this model; empty means there is no adjustable effort.
 */
efforts?: Array<string>, 
/**
 * The level the CLI uses when none is chosen.
 */
defaultEffort?: string, 
/**
 * CLI model ids for a family whose effort is encoded in the model name.
 */
variants?: { [key in string]: string }, };

export type CatalogSource = "cli" | "fallback";

/**
 * A mode (permission preset, plan mode, OpenCode agent) the app can switch to.
 */
export type ModeOption = { id: string, label: string, };

export type AgentCatalog = { models: Array<AgentModel>, source: CatalogSource, updatedAt: number, error?: string, 
/**
 * the agent's own list of modes when it can be asked (OpenCode's primary agents, custom ones included)
 */
modes?: Array<ModeOption>, };

/**
 * How to install an agent: its own installer when it has one, its npm package otherwise.
 */
export type AgentInstall = { cmd?: string, npm?: string, docs: string, };

/**
 * Where an agent's newest version is published.
 */
export type LatestSource = { npm: string, };

export type ReplyFont = "serif" | "sans" | "mono";

export type Skin = { light: SkinTokens, dark: SkinTokens, };

export type ConfigFormat = "json" | "toml" | "md";

export type ConfigFile = { path: string, label: string, format: ConfigFormat, };

/**
 * The commands that turn Claude Code's ultracode switch on and off.
 */
export type UltracodeCommands = { on: string, off: string, };

/**
 * How to set things from the outside. The TypeScript catalog has functions here; this has their
 * templates (`{id}`, `{level}`, `{text}`), filled in by the `AgentDef` methods.
 */
export type AgentSet = { model?: string, effort?: string, goal?: string, clearGoal?: string, compact?: string, clear?: string, rc?: string, ultracode?: UltracodeCommands, };

/**
 * Everything Inyon knows about one coding agent. `args` holds the sources of the TypeScript
 * regular expressions (no flags), and `set` the templates of its functions.
 */
export type AgentDef = { kind: AgentKind, install: AgentInstall, 
/**
 * where its newest version is published (its npm package); none means Inyon can't tell
 */
latest?: LatestSource, 
/**
 * the agent's own update command; npm installs are updated with npm instead
 */
update?: string, login: string, 
/**
 * a command that prints the version
 */
version: string, 
/**
 * files that exist once the user has signed in (any of them)
 */
authFiles: Array<string>, name: string, vendor: string, 
/**
 * process names that identify the agent inside a pane
 */
comm: Array<string>, 
/**
 * argv patterns that identify it when the process name is too generic
 */
args: Array<string>, launch: string, 
/**
 * reply typography
 */
replyFont: ReplyFont, spinner: Array<string>, skin: Skin, 
/**
 * conversation readable as chat (otherwise terminal-first)
 */
chat: boolean, 
/**
 * The running CLI supports direct ! shell commands.
 */
shell?: boolean, models: Array<AgentModel>, efforts: Array<string>, modes: Array<ModeOption>, commands: Array<SlashCommand>, 
/**
 * The commands that open the agent's own list of past conversations in its terminal.
 */
conversations?: Array<string>, configFiles: Array<ConfigFile>, set: AgentSet, };

/**
 * One file of the newest release, as latest.json lists it.
 */
export type ReleaseFile = { name: string, size?: number, sha256?: string, };

/**
 * local: the hub itself · ssh: the hub connects out over SSH · node: the machine connects in to the hub (no open ports)
 */
export type HostKind = "local" | "ssh" | "node" | "link";

/**
 * How the phone app signs in to an SSH server ("none" for servers that let you in without a key or password).
 */
export type HostAuth = "phone-key" | "password" | "key" | "none";

export type HostConfig = { id: string, name: string, kind: HostKind, 
/**
 * ssh only: `user@host` or an alias from ~/.ssh/config
 */
target?: string, port?: number, identityFile?: string, 
/**
 * ssh from the phone app: the server's host key fingerprint, confirmed when it was added
 */
hostKey?: string, 
/**
 * ssh from the phone app: how it signs in (the secret itself stays in the phone's keystore)
 */
auth?: HostAuth, 
/**
 * ssh from the phone app: the id of a paired computer that opens the connection instead of the phone
 */
via?: string, 
/**
 * node only: sha256 of the pairing token (the token itself is never stored)
 */
tokenHash?: string, 
/**
 * node only: when the machine first connected with its token (unset while the command hasn't run)
 */
pairedAt?: number, 
/**
 * node only: when its current token was made; one that's never used stops working after a day
 */
tokenIssuedAt?: number, 
/**
 * link only (a laptop the phone app paired with directly): its id, from `inyon pair`
 */
machineId?: string, 
/**
 * link only: where it was last reachable, and the relays it uses
 */
urls?: Array<string>, relays?: Array<string>, 
/**
 * put the Claude integration back when something replaces ~/.claude/settings.json
 */
keepIntegration?: boolean, };

export type HostStatus = "connecting" | "online" | "error";

export type AgentState = "idle" | "working" | "waiting" | "unknown";

export type RateWindow = { pct: number, 
/**
 * unix seconds
 */
resetsAt?: number, };

/**
 * Prepaid credits (Codex): a balance, or unlimited.
 */
export type Credits = { balance?: string, unlimited?: boolean, };

export type StaleLimits = "account";

export type StaleContext = "compacted";

/**
 * Why some numbers are missing: the account changed since the limits were reported, or the
 * conversation was compacted since the context was. Both refill on the agent's next reply.
 */
export type Stale = { limits?: StaleLimits, context?: StaleContext, };

/**
 * Live numbers the agent reports (Claude: its status line payload; Codex: token_count events).
 */
export type AgentStatus = { model?: string, modelId?: string, effort?: string, fast?: boolean, version?: string, contextPct?: number, contextUsed?: number, contextSize?: number, costUsd?: number, durationMs?: number, apiDurationMs?: number, linesAdded?: number, linesRemoved?: number, fiveHour?: RateWindow, sevenDay?: RateWindow, credits?: Credits, 
/**
 * plan name when the agent reports it
 */
plan?: string, outputStyle?: string, stale?: Stale, 
/**
 * unix ms of the last update
 */
updatedAt: number, };

/**
 * Where the pane → session mapping came from.
 */
export type MappedBy = "hook" | "cwd" | "resume" | "process";

/**
 * An answer offered by the prompt on screen, for quick replies.
 */
export type QuickOption = { n: number, label: string, };

export type AgentPaneInfo = { kind: AgentKind, 
/**
 * a custom agent's name (Settings › Agents); `kind` is the agent it works like
 */
custom?: string, pid: number, sessionId?: string, transcriptPath?: string, 
/**
 * where the pane → session mapping came from
 */
mappedBy?: MappedBy, state: AgentState, 
/**
 * e.g. "manual", "plan", "accept edits"
 */
mode?: string, 
/**
 * short text for the overview, e.g. the permission being asked
 */
waitingFor?: string, 
/**
 * answers offered by the prompt on screen (single-choice prompts only), for quick replies
 */
options?: Array<QuickOption>, 
/**
 * working spinner text
 */
activity?: string, 
/**
 * background shells or tasks still running while the agent itself waits, e.g. "1 shell"
 */
background?: string, 
/**
 * Claude Code: ultracode (a dynamic workflow for every task) is on for the session
 */
ultracode?: boolean, status?: AgentStatus, 
/**
 * the integration is on but this session stopped sending live numbers
 */
statusStopped?: boolean, startedAt?: number, 
/**
 * the last turn ended on an error instead of finishing; gone with the next prompt
 */
failure?: TurnFailure, };

/**
 * Why a turn stopped (Claude Code's StopFailure hook).
 */
export type TurnFailure = { 
/**
 * "rate_limit", "billing_error", "authentication_failed", "overloaded", "server_error",
 * "invalid_request", "max_output_tokens" or "unknown"
 */
error: string, 
/**
 * rate limits: when the full limit resets, unix seconds
 */
resetsAt?: number, };

export type PaneInfo = { 
/**
 * tmux pane id, e.g. "%12"
 */
id: string, 
/**
 * tmux's numbers as JavaScript reads them: NaN (null on the wire) where tmux printed no number
 */
index: number, active: boolean, command: string, cwd: string, title: string, 
/**
 * the name you gave this session in Inyon
 */
label?: string, width: number, height: number, dead: boolean, agent?: AgentPaneInfo, 
/**
 * runs your companion agent (Settings › Companion); at most one pane across all machines
 */
companion?: boolean, };

export type WindowInfo = { 
/**
 * "@3"
 */
id: string, index: number, name: string, active: boolean, activity: number, panes: Array<PaneInfo>, };

export type SessionInfo = { 
/**
 * "$1"
 */
id: string, name: string, attached: number, windows: Array<WindowInfo>, };

export type IntegrationState = "unknown" | "installed" | "missing" | "removed" | "outdated";

export type NodeUpdateState = "updating" | "updated" | "failed";

/**
 * A machine's inyon that can be updated from the app, or an update the app started.
 */
export type NodeUpdate = { latest: string, 
/**
 * false for an inyon (or tether-node) too old to update itself
 */
supported: boolean, state?: NodeUpdateState, error?: string, };

export type MachineKind = "server" | "laptop" | "desktop";

export type TmuxState = "unknown" | "ok" | "no-server" | "missing";

/**
 * An agent's plan limits on a machine, read from the account it's signed in to, with or without a
 * session running.
 */
export type AccountLimits = { kind: AgentKind, fiveHour?: RateWindow, sevenDay?: RateWindow, plan?: string, credits?: Credits, 
/**
 * limit resets the account has banked (Codex): counted, never used
 */
resets?: number, 
/**
 * unix ms of the reading
 */
updatedAt: number, };

export type HostState = { config: HostConfig, status: HostStatus, error?: string, 
/**
 * hostname reported by the machine
 */
hostname?: string, 
/**
 * Claude Code integration
 */
integration: IntegrationState, 
/**
 * Antigravity has its own settings and status wrapper.
 */
agyIntegration?: IntegrationState, tmux: TmuxState, 
/**
 * agent CLIs found on PATH
 */
agents: Array<AgentKind>, 
/**
 * agents with a saved sign-in on the machine (unknown until the first probe)
 */
signedIn?: Array<AgentKind>, os?: string, 
/**
 * what the machine is, for its icon (detected on the machine)
 */
machineKind?: MachineKind, 
/**
 * the inyon version a paired machine or laptop runs
 */
nodeVersion?: string, 
/**
 * what that machine's inyon warns about its connection to the hub (plain http, from a machine
 * added before 0.20), with how to fix it
 */
nodeWarning?: string, 
/**
 * set when that inyon is behind, or while an update runs
 */
nodeUpdate?: NodeUpdate, latencyMs?: number, sessions: Array<SessionInfo>, updatedAt: number, 
/**
 * last successful check (ms); kept across hub restarts
 */
lastSeen?: number, 
/**
 * when the machine stopped answering; its sessions are the last ones seen, saved on disk
 */
offlineSince?: number, 
/**
 * plan limits of the accounts signed in there
 */
limits?: Array<AccountLimits>, };

export type AssistantBlock = { "type": "text", text: string, } | { "type": "thinking", text: string, } | { "type": "tool_use", id: string, name: string, input: any, };

/**
 * One unified hunk of an Edit/Write/MultiEdit.
 */
export type PatchHunk = { oldStart: number, oldLines: number, newStart: number, newLines: number, lines: Array<string>, };

export type ToolResultMeta = { 
/**
 * Edit/Write/MultiEdit: unified hunks
 */
patch?: Array<PatchHunk>, filePath?: string, 
/**
 * Write: created a new file
 */
created?: boolean, stdout?: string, stderr?: string, interrupted?: boolean, 
/**
 * AskUserQuestion
 */
answers?: { [key in string]: string }, 
/**
 * ExitPlanMode
 */
plan?: string, 
/**
 * Read
 */
numLines?: number, 
/**
 * Bash/Monitor run in the background: the task it started (see ChatInfo.tasks)
 */
taskId?: string, };

export type NoticeLevel = "info" | "warn" | "error";

export type ChatItem = { "kind": "user", seq: number, uuid: string, ts: string, text: string, images: number, queued?: boolean, shell?: boolean, } | { "kind": "assistant", seq: number, uuid: string, ts: string, msgId: string, model?: string, block: AssistantBlock, } | { "kind": "tool_result", seq: number, uuid: string, ts: string, toolUseId: string, isError: boolean, text: string, truncated?: boolean, meta?: ToolResultMeta, } | { "kind": "command", seq: number, uuid: string, ts: string, name: string, args: string, output?: string, } | { "kind": "notice", seq: number, uuid: string, ts: string, level: NoticeLevel, subtype: string, text: string, } | { "kind": "turn_end", seq: number, uuid: string, ts: string, durationMs: number, } | { "kind": "goal", seq: number, uuid: string, ts: string, condition: string, met: boolean, reason?: string, cleared?: boolean, };

export type TaskType = "shell" | "monitor" | "workflow" | "other";

export type TaskStatus = "running" | "completed" | "failed" | "stopped";

export type BackgroundTask = { id: string, type: TaskType, description: string, command?: string, status: TaskStatus, outputFile?: string, summary?: string, startedAt?: string, endedAt?: string, };

export type SubagentStatus = "running" | "done" | "error";

export type SubagentInfo = { toolUseId: string, type?: string, description: string, prompt?: string, status: SubagentStatus, background?: boolean, startedAt?: string, transcriptPath?: string, };

export type ArtifactInfo = { url: string, title?: string, updatedAt?: string, };

export type SessionStats = { contextTokens?: number, costUsd?: number, durationMs?: number, apiDurationMs?: number, linesAdded?: number, linesRemoved?: number, turns: number, compactions: number, 
/**
 * unix ms of the last compaction
 */
compactedAt?: number, 
/**
 * unix ms of the event `contextTokens` came from
 */
contextAt?: number, startedAt?: string, };

/**
 * sending: being typed · sent: submitted, not yet in the agent's record · queued: in the agent's
 * queue while it works · delivered: in the conversation (`uuid` is that item) · failed: `error`
 */
export type SendStatus = "sending" | "sent" | "queued" | "delivered" | "failed";

/**
 * One message sent through Inyon. The hub knows the exact text it typed, so it is the one that
 * matches it to the agent's record; every device reads the outcome from here.
 */
export type SendState = { id: string, text: string, at: number, state: SendStatus, uuid?: string, error?: string, 
/**
 * a change made with the app's controls (model, effort, goal…): followed, but not shown as a message
 */
setting?: boolean, };

/**
 * A message Inyon holds for a pane and types in once its agent is free (from 0.22): it can still
 * be edited, moved or dropped. `error` says why the last try didn't go, and holding stops there.
 */
export type HeldPrompt = { id: string, text: string, at: number, error?: string, };

/**
 * Controls picked in the app while the agent couldn't take them (from 0.22): Inyon makes each
 * pick once the agent is free, the last of each kind winning. The values are what was picked:
 * a model as the agent's `/model` takes it, an effort level, a mode id. `error` says why the
 * last try didn't take, and nothing more is tried until it's picked again or dropped.
 */
export type ChosenControls = { model?: string, effort?: string, mode?: string, error?: string, };

/**
 * A conversation the agent saved in a pane's folder, which it can be started again with.
 */
export type PastConversation = { 
/**
 * what the agent's command line takes to resume it
 */
id: string, 
/**
 * the agent's own title for it, a name given in Inyon, or else the first thing you asked
 */
title: string, 
/**
 * last activity, ms since the epoch
 */
at: number, 
/**
 * the conversation open in the pane now
 */
current?: boolean, };

export type LiveKind = "text" | "thinking" | "plan" | "output";

/**
 * Something the agent is writing right now, before it's in its record. The record's item has the
 * same id, so the finished message takes the live one's place without a jump.
 */
export type LiveItem = { id: string, kind: LiveKind, text: string, turnId?: string, };

export type ChatGoal = { condition: string, met: boolean, reason?: string, ts: string, };

/**
 * Remote Control's link while it's on.
 */
export type RemoteControl = { url: string, ts: string, };

/**
 * The turn under way, for the working timer.
 */
export type Turn = { id?: string, 
/**
 * unix ms, fractional when the agent wrote it so
 */
startedAt: number, };

export type ChatInfo = { 
/**
 * Live metrics from transcript/API adapters.
 */
status?: AgentStatus, hostId: string, paneId: string, agent?: AgentKind, title?: string, sessionId?: string, transcriptPath?: string, cwd?: string, model?: string, gitBranch?: string, version?: string, 
/**
 * the agent process is (still) running in the pane
 */
running: boolean, mappedBy?: MappedBy, error?: string, goal?: ChatGoal, rc?: RemoteControl, 
/**
 * the conversation's public link, while it's shared (OpenCode's /share)
 */
share?: string, 
/**
 * messages typed while the agent was busy, not yet picked up
 */
queue: Array<string>, 
/**
 * messages Inyon holds until the agent is free, in the order they go (from 0.22)
 */
held?: Array<HeldPrompt>, 
/**
 * a model, effort or mode waiting for the agent to be free (from 0.22)
 */
chosen?: ChosenControls, 
/**
 * the turn under way, for the working timer (Codex: from its records and its live events)
 */
turn?: Turn, 
/**
 * recent sends and how far each got, matched by the hub against the agent's own record
 */
sends?: Array<SendState>, tasks: Array<BackgroundTask>, subagents: Array<SubagentInfo>, artifacts: Array<ArtifactInfo>, stats: SessionStats, mode?: string, 
/**
 * Claude Code: ultracode is on for the session
 */
ultracode?: boolean, };

export type PromptOption = { n: number, label: string, detail?: string, selected: boolean, 
/**
 * multi-select checkbox state; undefined for single-select
 */
checked?: boolean, 
/**
 * what's set now, in a settings picker (Codex marks it "(current)")
 */
current?: boolean, };

/**
 * A tab of AskUserQuestion's tab strip.
 */
export type PromptTab = { label: string, done: boolean, current: boolean, };

/**
 * The dialog asks for typed input (e.g. "Paste code here if prompted >").
 */
export type PromptInput = { label: string, };

export type ScreenPrompt = { 
/**
 * text above the options (title, command, question)
 */
body: Array<string>, 
/**
 * each body line is a whole line: the hub has joined the ones the terminal wrapped
 */
wholeLines?: boolean, options: Array<PromptOption>, 
/**
 * AskUserQuestion tab strip
 */
tabs?: Array<PromptTab>, footer?: string, multi: boolean, 
/**
 * the option number of a free-text "Type something" entry
 */
freeTextOption?: number, 
/**
 * options aren't numbered on screen: answer by moving the cursor (↑/↓) and pressing Enter
 */
navigate?: boolean, 
/**
 * the dialog asks for typed input (e.g. "Paste code here if prompted >")
 */
input?: PromptInput, 
/**
 * URLs shown in the dialog, re-joined when the terminal wrapped them
 */
links?: Array<string>, 
/**
 * answered through the agent's API rather than keystrokes (OpenCode permissions and questions)
 */
api?: boolean, 
/**
 * the label of the action that sends toggled choices together ("Confirm", "Next"); answered with option 0
 */
confirm?: string, };

export type ScreenState = { 
/**
 * A recognizable input box is present, even with a custom footer.
 */
inputVisible?: boolean, 
/**
 * a menu/prompt is waiting for an answer
 */
prompt?: ScreenPrompt, working: boolean, 
/**
 * spinner line, e.g. "Undulating… (12s · thinking)"
 */
activity?: string, 
/**
 * when the current turn started (unix ms), read off the spinner's elapsed time (Codex)
 */
since?: number, mode?: string, 
/**
 * text sitting in Claude's input box (typed but not sent)
 */
draft?: string, 
/**
 * Remote Control as the screen last reported it: its link while on, null once turned off (agy)
 */
remote?: string | null, 
/**
 * background work listed under the input box: null when the footer lists none, left out when it wasn't visible
 */
background?: string | null, 
/**
 * messages waiting to be sent after the current turn, when only the screen shows them (Antigravity)
 */
queue?: Array<string>, 
/**
 * questions Codex asked while it works, waiting to be answered (it opens them with shift+←)
 */
questions?: number, 
/**
 * model and effort from the agent's own footer, for sessions that don't report live numbers
 */
model?: string, effort?: string, 
/**
 * Claude Code's ultracode switch, as its input box shows it; undefined while the box isn't visible
 */
ultracode?: boolean, 
/**
 * context and cost as the agent's own status row or sidebar prints them (OpenCode)
 */
contextPct?: number, contextUsed?: number, costUsd?: number, 
/**
 * a menu of the agent's own open over the box, by its title ("Select model", "Select variant")
 */
dialog?: string, width: number, };

export type ProviderVia = "credential" | "env";

/**
 * A model provider OpenCode knows, and whether this machine can use it.
 */
export type OpenCodeProvider = { id: string, name: string, connected: boolean, 
/**
 * a saved credential (`opencode auth login`), or an API key in the machine's environment
 */
via?: ProviderVia, 
/**
 * the credential's kind, as `opencode auth list` prints it (api, oauth)
 */
type?: string, 
/**
 * environment variables that connect it without a saved credential
 */
env?: Array<string>, };

export type ProvidersReport = { providers: Array<OpenCodeProvider>, updatedAt: number, 
/**
 * the provider list couldn't be read (OpenCode missing, or its server didn't start)
 */
error?: string, };

/**
 * A one-time code the hub's web app shows (as a QR, and as text to type) for a phone to pair with.
 */
export type PhonePairCode = { 
/**
 * 8 characters of Crockford base32, shown as "K7Q4-MX2T"
 */
id: string, 
/**
 * 6 digits
 */
code: string, 
/**
 * what the QR holds: inyon://hub?u=<hub origin>&c=<id:code>&n=<hub name>
 */
link: string, 
/**
 * unix ms; ten minutes after the code was made
 */
expiresAt: number, };

/**
 * POST /api/phones/claim: the phone hands in the code and says what to call it.
 */
export type PhoneClaim = { 
/**
 * "ID:DIGITS", the id in any case
 */
code: string, name: string, };

/**
 * The hub a phone paired with.
 */
export type HubInfo = { id: string, name: string, version: string, };

export type PhoneClaimResult = { 
/**
 * sent as `Authorization: Bearer` from then on; the hub keeps only its hash
 */
token: string, hub: HubInfo, };

/**
 * GET /api/phones: a phone that paired, as the hub lists it.
 */
export type PairedPhone = { id: string, name: string, pairedAt: number, lastSeen: number, 
/**
 * set on the phone that asked
 */
thisPhone?: true, };

/**
 * What a companion may do: read the overview, watch chats, answer prompts, send text. Nothing else.
 */
export type CompanionScope = "overview" | "chat" | "answer" | "send";

/**
 * A short one-time code for a companion to type: six characters, no 0, O, 1, I or L.
 */
export type CompanionPairCode = { code: string, 
/**
 * unix ms; five minutes after the code was made
 */
expiresAt: number, 
/**
 * from 1.1: the SHA-256 of the certificate the hub serves itself (its DER, lowercase hex), for the pairing link
 */
tlsFingerprint?: string, };

/**
 * POST /api/companions/claim, sent with `X-Inyon-Contract`.
 */
export type CompanionClaim = { 
/**
 * any case, spaces and dashes ignored
 */
code: string, 
/**
 * what the hub lists it as, e.g. "Legato on abhash-laptop"
 */
name: string, 
/**
 * the app itself, e.g. "Legato for Windows"
 */
app?: string, };

export type CompanionClaimResult = { 
/**
 * sent as `Authorization: Bearer` from then on; the hub keeps only its hash
 */
token: string, hubId: string, scopes: Array<CompanionScope>, contractVersion: number, 
/**
 * from 1.1, when the hub serves HTTPS itself: the SHA-256 of its certificate's DER, lowercase hex, to pin
 */
tlsFingerprint?: string, };

/**
 * GET /api/companions: a companion app that paired, as the hub lists it.
 */
export type PairedCompanion = { id: string, name: string, app?: string, scopes: Array<CompanionScope>, contractVersion: number, pairedAt: number, lastSeen: number, };

/**
 * GET /api/companions/me: the companion asking, and the hub it paired with.
 */
export type CompanionMe = { id: string, name: string, app?: string, scopes: Array<CompanionScope>, contractVersion: number, hub: HubInfo, };

/**
 * What a page's progress.json says, counted: tasks done of all tasks, and its `now` and `updated` lines.
 */
export type PageProgress = { done: number, total: number, 
/**
 * the "working on" line
 */
now?: string, 
/**
 * when progress.json was last written, as it says (an ISO time)
 */
updated?: string, };

/**
 * GET /api/pages: one page, on one machine. Its id is `<host>/<slug>`.
 */
export type PageEntry = { 
/**
 * the machine's host id ("local" for the hub's own machine)
 */
host: string, 
/**
 * `^[a-z0-9][a-z0-9-]{0,62}$`, unique on its machine
 */
slug: string, name: string, 
/**
 * the project folder: the git top level of the page's folder, or the folder itself
 */
project: string, 
/**
 * who added it: an agent ("claude", "codex"…), "cli" for the inyon command, or "app"
 */
by: string, 
/**
 * unix ms
 */
added: number, 
/**
 * the site's folder, absolute; it holds index.html
 */
folder: string, 
/**
 * left out when the site has no readable progress.json
 */
progress?: PageProgress, 
/**
 * the Markdown notes in the site's `research/` folder, by file name (from 0.22.4); left out
 * when there are none
 */
notes?: Array<string>, 
/**
 * the agent conversation that added or found it (Claude Code's session id, Codex's thread
 * id), from 0.22.5: the app shows that session's name over it
 */
session?: string, 
/**
 * the name Inyon last gave that session, for when it isn't running
 */
sessionName?: string, };

/**
 * GET /api/pages
 */
export type PageList = { pages: Array<PageEntry>, };

/**
 * POST /api/pages/:host/:slug/open. `url` is a path on the hub that called (`/v/<token>/`); the app
 * puts the hub's own address in front of it.
 */
export type PageOpen = { url: string, 
/**
 * unix ms; twelve hours after it was made
 */
expires: number, 
/**
 * how long the link lasts from when it was made, in ms; the app counts it on its own clock, which may not agree with the hub's
 */
ttl: number, };

/**
 * POST /api/pages/:host: add a folder as a page. The slug comes from the folder's name when left out.
 */
export type PageRegister = { 
/**
 * absolute, and holds index.html
 */
path: string, name?: string, slug?: string, };

/**
 * One entry of ~/.inyon/pages.json, the machine's list of pages.
 */
export type PageRecord = { slug: string, name: string, path: string, project: string, by: string, 
/**
 * unix ms
 */
added: number, };

/**
 * ~/.inyon/pages.json. Written to a temp file and renamed, under pages.json.lock.
 */
export type PagesFile = { 
/**
 * always 1
 */
v: number, pages: Array<PageRecord>, };

/**
 * What made a page's site; only Blueprint so far.
 */
export type PageKind = "blueprint";

/**
 * `<site>/.inyon-page.json`, the marker in a site's own folder. It is a dot file, so never served.
 */
export type PageMarker = { 
/**
 * always 1
 */
v: number, slug: string, name: string, kind: PageKind, 
/**
 * unix ms
 */
created: number, };

export type ClientMsg = { "t": "sub.overview" } | { "t": "sub.chat", host: string, pane: string, } | { "t": "unsub.chat", host: string, pane: string, } | { "t": "chat.more", host: string, pane: string, before: number, } | { "t": "draft", host: string, pane: string, text: string, } | { "t": "term.open", id: string, host: string, pane: string, cols: number, rows: number, } | { "t": "term.in", id: string, d: string, } | { "t": "term.resize", id: string, cols: number, rows: number, } | { "t": "term.close", id: string, } | { "t": "ping" } | { "t": "quiet", on: boolean, };

export type DraftSource = "app" | "terminal";

export type NotifyKind = "waiting" | "done" | "offline" | "online";

export type ServerMsg = { "t": "overview", hosts: Array<HostState>, } | { "t": "chat.reset", key: string, info: ChatInfo, items: Array<ChatItem>, hasMore: boolean, } | { "t": "chat.append", key: string, items: Array<ChatItem>, } | { "t": "chat.more", key: string, items: Array<ChatItem>, hasMore: boolean, } | { "t": "chat.info", key: string, info: ChatInfo, } | { "t": "chat.screen", key: string, screen: ScreenState, } | { "t": "chat.live", key: string, items: Array<LiveItem>, } | { "t": "chat.progress", key: string, done: number, total: number, } | { "t": "chat.draft", key: string, text: string, source: DraftSource, at: number, } | { "t": "term.data", id: string, d: string, } | { "t": "term.exit", id: string, reason?: string, } | { "t": "notify", host: string, pane: string, kind: NotifyKind, title: string, body: string, agent?: AgentKind, } | { "t": "page.notify", host: string, slug: string, title: string, body: string, } | { "t": "pong" } | { "t": "companion.reply", id: string, host: string, pane: string, text: string, error?: boolean, at: number, };
