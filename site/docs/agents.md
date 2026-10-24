---
title: Agents
description: What works with each coding agent, where Inyon reads it from, and the limits of each.
---

Inyon works with the agent CLIs you already use, signed in however you like. It reads each one from its own records and its screen, and never asks it to do anything you couldn't do at the keyboard.

## What works with each

| | Claude Code | Codex | Gemini CLI | OpenCode | Copilot | Antigravity CLI |
|---|---|---|---|---|---|---|
| Chat view | Full | Full | Beta | Beta | Beta | Yes |
| Reply shown as it's written | No | From 0.17.6 | No | No | No | No |
| Prompts as buttons | Yes | Yes | Yes | Yes, several answers too | Yes | Yes |
| Sub-agents listed | Yes | From 0.17.6 | No | No | No | No |
| Model | Yes | Yes | No | Live list | Live list | Yes |
| Effort | Yes | Yes | No | Every variant | No | Yes |
| Mode | Yes | Yes | No | Its agents, custom too | Yes | Yes |
| Providers | No | No | No | Connect, disconnect | No | No |
| Goal | Yes | Yes | No | No | No | Set only |
| Compact | Yes | Yes | Yes | Yes | Yes | No |
| Rewind | Yes | Per message | No | Undo, redo | No | Yes |
| Share | No | No | No | Link, stop sharing | No | No |
| [Past conversations](sessions.md#past-conversations) | Yes | Yes | No | Yes | Yes | Yes |
| `!` shell commands | Yes | Yes | No | Yes | Yes | No |
| Remote Control | Yes | No | No | No | No | Yes |
| [Ultracode](controls.md#ultracode) | Yes | No | No | No | No | No |
| Cost | Yes | No | No | Yes | No | No |
| Plan limits | 5-hour and weekly | 5-hour, weekly, credits | No | No | No | 5-hour and weekly |

## How Inyon reads them

| What | Where it comes from |
|---|---|
| Panes and agents | tmux and the process tree; live changes through a read-only tmux control client |
| Conversations | Each agent's own session files or local server |
| Replies as they're written | Codex: the live events of its own app-server, joined on the machine (see below) |
| Prompts and spinners | The pane's screen, parsed into options |
| Plan limits | Claude: the account's usage, read on the machine the same way `/usage` does. Codex: its status events, and from 0.21 the account itself through `codex app-server`, with no session running. Antigravity: its status events |
| Context and cost | Claude's status line data (with the integration) and transcripts; OpenCode's own record, plus its sidebar and status row; the others' own events |
| Typing and answering | tmux, exactly as if you typed it: keys with `send-keys`, and from 0.20 text through a tmux paste buffer, so it never shows on a command line |

The agents never know Inyon is there. Close it and nothing breaks.

## Claude Code

Read from its transcripts in `~/.claude`. With the optional integration (turned on from a machine's Integration tab), a hook gives exact session matching and the status line gives live context, cost and limits. Models, effort, permission modes, goals, Remote Control, [ultracode](controls.md#ultracode), compact, clear and `/rewind` all work.

## Codex

Read from its session files in `~/.codex/sessions`. Model and effort go through Codex's own picker. It shows plan limits and credits, every message of yours can **Rewind to here**, and `$` lists skills. Codex runs its hooks inside a background process that can't tell which pane it belongs to, so Inyon reads Codex's prompts from the screen.

From 0.17.6 the chat shows Codex's reply while it is being written, the way the terminal does, with its thinking folded above it. Codex's terminal is a client of a background process on the machine (its app-server), which other clients may join; Inyon joins the open conversation from the machine with a small `node` script and listens, without sending anything. It needs `node` on the machine, which an npm install of Codex has; without it the reply still appears when it's complete. Joining also brings the turn's timer, token usage the moment Codex reports it, and sub-agents as they start and finish.

The same release reads more of Codex's record: a question Codex asks mid-turn shows as a card with its choices and your answer, a plan written in Plan mode shows as a plan card, a script that ran several tools lists each step with the diffs of its patches, sub-agents appear under **Running** with what they reported back, and each turn carries how long it took. While Codex works, the switch by the send button decides whether a message is queued or steered in; see [Writing messages](sessions.md#writing-messages).

## Gemini CLI (beta)

The app lists it as *Gemini CLI (legacy)*, next to Google's newer Antigravity CLI. Read from Gemini's chat recordings in `~/.gemini/tmp`. Prompts become buttons and context is shown. Inyon can't change Gemini's model yet, and doesn't list its past conversations: resume those in the terminal. `/compress` compacts.

## OpenCode (beta)

Made for OpenCode 1.19. Inyon reads a session two ways: one it started (`--hostname 127.0.0.1 --port 0`) through OpenCode's own local server, any other through OpenCode's database and its screen. Either way the terminal's footer (agent · model · variant) is what the app shows, and a pick made in the app goes through OpenCode's own keys, so the two never disagree. While a menu or a question hides the footer, the last values stand.

From 0.17.6:

- **Providers.** A machine's Setup tab lists OpenCode's providers, connected ones first, and connects or disconnects them with OpenCode's own `opencode auth login` and `opencode auth logout`. The same list opens from a session's model menu (*Connect a provider…*), on the phone too, and the model list follows at once. See [Adding machines](machines.md#the-setup-tab).
- **Agents and variants.** The agent list comes from the machine, custom agents included, and every variant a model has is read, whatever it's called; *Default* means none.
- **Context and cost** come from OpenCode's own record (the last reply's whole usage, counted as its sidebar counts it), and the sidebar and status row fill in on the session cards.
- **Undo, redo, share and compact**, and a new conversation, work in both modes; a session Inyon started gets them through its server.
- **Questions** that take several answers, or ask several things at once, show as checkboxes and tabs with a Confirm button.
- OpenCode's key bindings are read from its config (user and project), so a remapped Tab or Ctrl+T doesn't break the controls.
- With several conversations in one folder, the one the terminal shows is found by its title.

A password-protected OpenCode server isn't supported. A plain `opencode` already running sees a provider connected from the app after it restarts; a session Inyon started sees it at once.

## GitHub Copilot (beta)

Found through its process locks and event log. Its models come from the CLI's own catalog, so they match what your account can use. Assisted approval and effort changes stay in the terminal, and sign-in uses Copilot's device-code flow.

## Antigravity CLI

Google's `agy`. Read from its transcripts, with plan quotas from its own status line. Models, effort, modes, goals (set, but not cleared yet), Remote Control and `/rewind` work.

## Pages an agent makes

From 0.20 any of them can put a site it built, such as a plan or mockups, in the app with `inyon pages add <folder>`. The [Blueprint](skills.md#blueprint) skill does it on its own. The page records who added it: `claude`, `codex`, `gemini` or `opencode` when one of those ran the command, `cli` for anything else. See [Pages](pages.md).

## Installing and signing in

A machine's **Setup** tab installs any of them, with the official installer or npm (Codex, Gemini CLI and Copilot need Node.js, which it can install too), and runs each one's sign-in as steps in the app. From 0.17.4 it also shows which of the six has a newer version and updates it with one button, from the browser or the phone. See [Adding machines](machines.md#the-setup-tab).

## Adding an agent

Most of what Inyon knows about an agent lives in one file, `packages/protocol/src/agents.ts`. A chat view also needs a reader for the agent's session files. [CONTRIBUTING.md](../../CONTRIBUTING.md) explains how.
