---
title: Steering an agent
nav: Controls
description: Model, effort, permission mode and goals; compact, clear and rewind; background work, usage and limits.
---

Everything you'd change at the keyboard has a control in the session. On a computer they sit as chips under the message box and in the header's **⋯** menu. On a phone, tap **More** in the header for the controls sheet.

While the agent is asking you something, the controls are hidden: typing would answer the question, so they can't work until it's answered.

## Model, effort and mode

| Control | What it changes | Agents |
|---|---|---|
| **Model** | The model for the next reply | Claude Code, Codex, OpenCode, Copilot, Antigravity |
| **Effort** | How hard the model thinks, from *Minimal* to *Max* (Codex adds *Ultra*) | Claude Code, Codex, OpenCode, Antigravity |
| **Mode** | How much the agent may do without asking | Claude Code, Codex, OpenCode (*Agent mode*), Copilot, Antigravity |

Each agent offers its own choices. Claude Code's modes are *Ask each time*, *Accept edits*, *Plan*, *Auto* and *Bypass permissions*. Codex's are *Ask for approval*, *Approve for me*, *Read-only*, *Full access* and *Plan*. OpenCode's are *Build* and *Plan*, and Copilot's *Manual approval* and *Full access*. Model lists for Codex, OpenCode, Copilot and Antigravity come live from the agent and refresh every minute, so they match what your account can use.

Inyon changes them the agent's own way, as if you'd used the agent's picker, so the terminal shows the same thing. Some can't change mid-reply: a mode change waits until the agent finishes working.

## Goals

A goal is a condition the agent checks before it stops: it keeps going until the goal is met. Tap the **Goal** chip and write one, such as *All tests pass and the PR is open*, then **Set goal**. The chat marks when a goal is set, met or cleared, and the sheet shows the last goal's outcome. **Turn off** clears it.

Goals work with Claude Code and Codex, and with Antigravity (which can't clear one yet).

## Remote Control

Claude Code and Antigravity can hand a session to their own apps. **Turn on Remote Control** in the menu starts it; an icon in the header then offers **Open on claude.ai** (or **Open in Antigravity**) and **Turn off**.

## Compact, clear, rewind

| Action | What it does | Agents |
|---|---|---|
| **Compact context** | Summarises the conversation to free up context | Claude Code, Codex, Gemini CLI, OpenCode, Copilot |
| **Clear conversation** | Starts a fresh conversation in the same pane, after asking | Every agent |
| **Rewind…** | Goes back to an earlier point | Claude Code, Antigravity, Codex |
| **Undo last message…** | Takes back your last message | OpenCode |

In Codex, every one of your messages also has **Rewind to here** while the agent is idle.

## Stopping and ending

- **Stop** (or `Esc` in an empty message box) interrupts the agent, like pressing `Esc` in the terminal.
- **Exit to shell** quits the agent and leaves the pane at a shell prompt, after asking.
- **End session…** closes the pane, its window or the whole tmux session. The confirmation says exactly which, and the session disappears at once.
- **Copy session ID** copies the agent's conversation ID, for resuming it elsewhere.
- **Past conversations…** (**History** on a phone) lists the agent's earlier conversations in this folder and switches to one. See [Past conversations](sessions.md#past-conversations).

## Background work

The layers button in the header (or the side panel on a wide screen) shows what's running beside the conversation:

- **Running:** queued messages, subagents with their transcripts, background shells with live output, and monitors. Shells and monitors each have a real **Stop**.
- **Changes:** every file the agent touched, marked added or modified with line counts, and the diff of each edit, newest first.
- **Preview:** a dev server the agent started, in a frame, with a phone-width toggle. Inyon suggests the local ports it finds.
- **Artifacts** (Claude Code): pages the agent published, with **Open**, **Copy link**, and a button that asks the agent to delete one.

## Usage and limits

The ring in the header shows how full the context window is; it turns amber past 60% and red past 85%. Tap it, or open **Usage** in the side panel, for:

- the context window, with **Compact now**;
- the plan and its limits: the 5-hour window and the week, with when each resets, plus Codex credits;
- the session's cost (Claude Code and OpenCode), run time and turns, and lines changed;
- the model, effort, fast mode, output style, the agent's version, the git branch, the folder, and the session ID;
- how Inyon matched the pane to its conversation, from an exact hook to a best guess by folder.

For Claude Code, the live numbers come from its status line, through Inyon's optional integration (turn it on from the machine's **Integration** tab). If a session stops reporting numbers, a note offers to reconnect or restart it. Settings → **Restart sessions that stop reporting** does that by itself.
