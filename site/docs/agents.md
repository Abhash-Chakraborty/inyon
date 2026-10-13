---
title: Agents
description: What works with each coding agent, where Inyon reads it from, and the limits of each.
---

Inyon works with the agent CLIs you already use, signed in however you like. It reads each one from its own records and its screen, and never asks it to do anything you couldn't do at the keyboard.

## What works with each

| | Claude Code | Codex | Gemini CLI | OpenCode | Copilot | Antigravity CLI |
|---|---|---|---|---|---|---|
| Chat view | Full | Full | Beta | Beta | Beta | Yes |
| Prompts as buttons | Yes | Yes | Yes | Yes | Yes | Yes |
| Model | Yes | Yes | No | Live list | Live list | Yes |
| Effort | Yes | Yes | No | Yes | No | Yes |
| Mode | Yes | Yes | No | Build / Plan | Yes | Yes |
| Goal | Yes | Yes | No | No | No | Set only |
| Compact | Yes | Yes | Yes | Yes | Yes | No |
| Rewind | Yes | Per message | No | Undo | No | Yes |
| [Past conversations](sessions.md#past-conversations) | Yes | Yes | No | Yes | Yes | Yes |
| `!` shell commands | Yes | Yes | No | Yes | Yes | No |
| Remote Control | Yes | No | No | No | No | Yes |
| Cost | Yes | No | No | Yes | No | No |
| Plan limits | 5-hour and weekly | 5-hour, weekly, credits | No | No | No | 5-hour and weekly |

## How Inyon reads them

| What | Where it comes from |
|---|---|
| Panes and agents | tmux and the process tree; live changes through a read-only tmux control client |
| Conversations | Each agent's own session files or local server |
| Prompts and spinners | The pane's screen, parsed into options |
| Plan limits | Claude: the account's usage, read on the machine the same way `/usage` does. Codex and Antigravity: their own status events |
| Context and cost | Claude's status line data (with the integration) and transcripts; the others' own events |
| Typing and answering | `tmux send-keys`, exactly as if you typed it |

The agents never know Inyon is there. Close it and nothing breaks.

## Claude Code

Read from its transcripts in `~/.claude`. With the optional integration (turned on from a machine's Integration tab), a hook gives exact session matching and the status line gives live context, cost and limits. Models, effort, permission modes, goals, Remote Control, compact, clear and `/rewind` all work.

## Codex

Read from its session files in `~/.codex/sessions`. Model and effort go through Codex's own picker. It shows plan limits and credits, every message of yours can **Rewind to here**, and `$` lists skills. Codex runs its hooks inside a background process that can't tell which pane it belongs to, so Inyon reads Codex's prompts from the screen.

## Gemini CLI (beta)

The app lists it as *Gemini CLI (legacy)*, next to Google's newer Antigravity CLI. Read from Gemini's chat recordings in `~/.gemini/tmp`. Prompts become buttons and context is shown. Inyon can't change Gemini's model yet, and doesn't list its past conversations: resume those in the terminal. `/compress` compacts.

## OpenCode (beta)

Inyon talks to the local server OpenCode already runs. Sessions Inyon starts expose a loopback API (`--hostname 127.0.0.1 --port 0`); their providers supply the model list and reasoning variants, and *Build* / *Plan* picks the OpenCode agent.

- Two sessions sharing a folder need an explicit `-s` session ID.
- Password-protected OpenCode servers aren't supported yet.
- The API path works for sessions Inyon started; others are read from the screen.

## GitHub Copilot (beta)

Found through its process locks and event log. Its models come from the CLI's own catalog, so they match what your account can use. Assisted approval and effort changes stay in the terminal, and sign-in uses Copilot's device-code flow.

## Antigravity CLI

Google's `agy`. Read from its transcripts, with plan quotas from its own status line. Models, effort, modes, goals (set, but not cleared yet), Remote Control and `/rewind` work.

## Installing and signing in

A machine's **Setup** tab installs any of them, with the official installer or npm (Codex, Gemini CLI and Copilot need Node.js, which it can install too), and runs each one's sign-in as steps in the app. See [Adding machines](machines.md#the-setup-tab).

## Adding an agent

Most of what Inyon knows about an agent lives in one file, `packages/protocol/src/agents.ts`. A chat view also needs a reader for the agent's session files. [CONTRIBUTING.md](../../CONTRIBUTING.md) explains how.
