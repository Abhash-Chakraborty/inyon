---
title: Adding machines
description: Add laptops and servers to a hub, set them up from the app, and what happens when one goes offline.
---

A hub reaches its own machine directly. Other machines join it, or it reaches them over SSH. Both start from **Machines → Add machine**.

## Laptops and desktops

Choose **Run a command on it**, name the machine, and tap **Create pairing command**. Pick macOS or Linux, or Windows, and run the one-line command it shows on that machine. The sheet waits with *Waiting for the machine to connect…* and then shows it.

The command downloads `inyon` from the hub, checks it against the hub's checksums, and installs it as a small user service that connects out to the hub. No `sudo`, no open ports on the machine.

- The command carries a token for that one machine. Treat it like a password until it's used.
- An unused command expires after 24 hours. **New pairing command** on the machine's page makes another.
- The machine needs to reach the hub's address. A plain `http://` hub address is only accepted on a private network.

## Servers over SSH

Choose **Reach it over SSH** and give it `user@host` or an alias from the hub's `~/.ssh/config`, plus a port and a key file if needed. The server only needs tmux and your agents.

The hub uses the system `ssh` with your config, keys and jump hosts, and stores no keys of its own. The first connection to a new server accepts its host key and remembers it in `~/.ssh/known_hosts`; a key that changes later is refused. Connections are reused for ten minutes, so opening sessions is quick.

## The machine's page

Tap a machine for its page. **New session**, **Rename** and **Remove** are at the top. Removing a machine never touches it: *Its tmux sessions keep running on the computer.*

The tabs:

- **Sessions:** its tmux sessions and panes.
- **Setup:** what it has and what it's missing (below).
- **Config:** each agent's config files, editable, with JSON checked before saving and the last five versions kept as backups.
- **Uploads:** how much space uploaded files take, with buttons to clean older ones or delete them all.
- **Integration:** Inyon's optional Claude Code integration, and which agents are signed in.

### The Setup tab

It checks the machine and fixes what it can:

- **tmux**, and a tmux session to work in (it can keep one called `main` running).
- **Node.js**, needed for the agents installed through npm (Codex, Gemini CLI and GitHub Copilot).
- **Each agent:** installed or not, its version, and whether it's signed in.

**Install** uses the agent's official installer, or npm when there isn't one. Fixes run with the machine's package manager (apt, dnf, yum, pacman, apk, zypper or Homebrew); when one needs your password, the tab shows the command to run yourself instead.

**Sign in** runs the agent's own sign-in in a hidden tmux session and turns it into steps: a code to copy, a page to open, a menu as buttons, or a box to paste a code into. Closing the sheet stops it.

### The Claude Code integration

Turning it on gives Inyon exact session matching and live numbers (context, cost, limits) for Claude Code. It adds a small hook script and wraps your status line, backing up `~/.claude/settings.json` first, and turning it off puts everything back. [Security](security.md#what-inyon-changes-on-a-machine) lists every file.

## When a machine goes offline

The hub keeps the last thing it saw. After a minute away, the machine shows as *Offline · last seen 5 min ago*, with its sessions and recent conversations still readable, and you're notified. You can't send to it until it's back. When it reconnects you're told how long it was away, and a turn that finished while it was gone still counts as finished.

## Updating machines

A machine that joined the hub updates from its page under Machines, to the hub's own version. The hub sends a short script that checks the download first, so this works for any version.

## Removing a machine

**Remove** on its page disconnects it and revokes its token; the machine's `inyon` stops at once. To clean up the machine itself, run `inyon disconnect` (keep Inyon) or `inyon uninstall` (remove it).
