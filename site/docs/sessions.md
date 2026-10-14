---
title: Sessions
description: Reading a session as a chat, answering prompts, and writing messages with commands, files, images and shell commands.
---

Tap a session to open it. If an agent is running in the pane, it opens as a chat; otherwise it opens the [terminal](terminal.md). The **Chat · Terminal** switch in the header moves between the two at any time.

![A desktop browser showing a Claude Code session's terminal, with the sidebar of machines and sessions on the left and the edited file's diff on the right](../../docs/terminal-light.webp)

## The chat

The chat is the agent's own record of the conversation, read from its session files, not a copy of the screen. It shows:

- **Replies**, formatted: headings, lists, tables and code with syntax highlighting and a copy button.
- **Tool calls**, one line each with a verb (*Ran*, *Read*, *Edited*, *Searched the web*…), the target, `+`/`−` line counts and how long it took. Tap one to expand it: a command and its output, an edit as a diff, a file read, or the raw input and result.
- **Plans, to-dos and questions** as cards: a proposed plan and whether it was approved, a checklist, or the questions the agent asked and your answers.
- **Thinking**, collapsed.
- **Goals**, as *Goal set*, *Goal met* or *Goal cleared*.
- **Notices**: compaction, Remote Control turned on, and a *While you were away* recap when you come back.

Settings → Appearance → **Tool calls in chat** switches between *Everything* and *Compact*. Compact folds a long run of tool calls down to the last four, with the rest behind *N more steps*.

### Following along

The chat follows new replies as they arrive, unless you've scrolled up to read; then it keeps your place and offers **Jump to latest**. Scroll up to load earlier messages. If you've been away for more than five minutes, it opens at the newest reply.

While the agent works, a line under the last message says what it's doing. Background work (shells, monitors, subagents) shows under it too; see [Background work](controls.md#background-work).

### Images

Images the agent shows inline are drawn only when they're local: pasted, uploaded or from the same machine. A remote image link stays a link, so a page can't learn what you're reading by loading an image.

## Answering prompts

When the agent asks something, the composer is replaced by the question:

- **Options** become numbered buttons. Tap one to answer. Prompts that allow several answers show checkboxes and a **Next →** button.
- **Free text** ("Type your answer…") opens a text box.
- **Links**, such as a sign-in page, get **Open** and **Copy link**.
- **A pasted value**, such as a sign-in code, gets a box and **Submit**.
- **Several questions** at once show a strip of tabs, marking which are done.

**Cancel** sends `Esc`, as you would at the keyboard. If Inyon can't read the options on a screen it doesn't recognise, it shows `↑`, `↓` and `Enter` buttons instead.

Each answer is tied to the question it was shown for. If the agent has already moved on, an old card can't answer the wrong question.

You can also answer straight from the [overview](overview.md#whats-on-it) or from a notification, without opening the session.

## Writing messages

Type in the box at the bottom and press `Enter` to send. `Shift Enter` adds a line. On a phone, `Enter` adds a line and the send button sends.

While the agent is working, sending queues the message instead: the box says *Queue a message for Claude…*, and the agent reads it at its next step. With nothing typed, the button becomes **Stop**, which sends `Esc`.

### Commands and skills

Type `/` for the agent's commands, skills and plugins, fetched from the machine each time, with where each comes from (project, user, plugin). Keep typing to filter, then `↑` `↓` and `Enter` or `Tab` to pick.

A few commands open Inyon's own controls instead of being typed: `/model`, `/models`, `/effort`, for OpenCode `/agents`, and the agent's resume command, which opens [Past conversations](#past-conversations). Commands that only change a setting (model, effort, mode, goal…) don't clutter the chat. In Codex, `$` lists skills.

### Files with @

Type `@` and part of a path to search the session's folder. Picking a file inserts its path; picking a folder keeps the list open inside it.

### Shell commands with !

Start a message with `!` to run a shell command in the session's folder, through the agent: Claude Code, Codex, OpenCode and Copilot. The agent runs it and handles permissions, and the output shows in the chat.

### Images and files

Attach with the paperclip, take a photo on a phone, paste a screenshot, or drag files onto the chat. Files upload to the machine (into `~/.inyon/uploads`) with progress, and the message lists their paths for the agent. A failed upload can be retried, and you can't send until it's either done or removed.

Pasting more than 40 lines of text attaches it as a file instead (*Pasted text · 120 lines*), so long logs don't flood the box. On a computer, typing anywhere on the page goes into the box, and pasting anywhere attaches.

Settings → **Uploads and clipboard** sets how long uploads are kept (1, 7 or 30 days, or forever), the largest file allowed and, from 0.17, how much space they may take on each machine. See [Settings](settings.md#uploads-and-clipboard).

### Drafts follow you

What you type is saved as you go, and mirrored into the agent's own input box in the terminal. Start a message on your phone and finish it at the keyboard, or the other way round. A draft picked up from elsewhere is marked *From the terminal*.

### Message states

A message shows **Sending**, then **Sent** once the agent has it. If it can't be delivered, it says so, with **Retry** and **Dismiss**; messages that failed because the connection dropped are retried by themselves when it comes back. A message that hasn't appeared in the conversation after ten minutes says so.

## Renaming

Click or tap the title in the header to rename a session (up to 80 characters), or choose **Use automatic name** to go back. The name stays with the conversation, even if you resume it later. Renaming a plain terminal renames its tmux window.

## Past conversations

From 0.15, Inyon lists an agent's past conversations itself, since its own resume picker only works in the terminal. Open the list with **Past conversations…** in the header's **⋯** menu, with **History** in the controls sheet on a phone, or by sending the agent's resume command from the message box:

| Agent | Command |
|---|---|
| Claude Code, Codex | `/resume` |
| GitHub Copilot, Antigravity CLI | `/resume` or `/switch` |
| OpenCode | `/sessions` |

The list holds the conversations the agent saved in the session's folder, newest first, up to 50. Each shows its title and when it was last active: the agent's own title, a name you gave it, or else your first message. The one open now is marked *Open now*.

Tap one to switch to it. The agent exits the way `/exit` would, so the current conversation is saved and can be resumed later, then starts again on the one you picked, in the same pane. The chat loads it once the agent is back. If the agent is working, Inyon asks first.

A switch stops with a message instead when:

- shells or monitors are running in the background, since exiting would stop them;
- the agent doesn't exit (close it from the terminal);
- another switch in the same session is still under way.

The list works for every machine, whether you reach it through your hub, a paired hub or straight from the phone. A paired hub needs to be up to date. Gemini CLI isn't supported: resume its conversations in the terminal.

## When nothing is running

If the agent has exited, the session offers **Resume conversation**, **Past conversations** (to pick another one), **Start** for each installed agent, or **Terminal**. A pane that has closed says *This pane is gone*.

## Signing in

If an agent isn't signed in on that machine, the session shows a banner with **Sign in**. Inyon runs the agent's own sign-in and turns it into steps: a code to copy, a page to open, or a code to paste back. See [Setting up a machine](machines.md#the-setup-tab).
