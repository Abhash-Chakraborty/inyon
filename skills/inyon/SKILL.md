---
name: inyon
description: Work on a computer that runs Inyon, the tmux and coding-agent remote (the `inyon` command). Use it whenever the user mentions Inyon, a hub, a joined or paired machine, the Inyon app or Pages, or asks you to set Inyon up, add a machine or phone, show them a site, find out what this computer is in their setup, or say which address to open; and before you guess anything about Inyon from its files or processes.
---

# Inyon

Inyon lets someone run coding agents in tmux and follow them from a phone or browser. Every computer
in their setup runs the `inyon` command, and each one plays one role. Find out which before you do
anything, then read the page of the docs that covers the task. The docs ship inside the program, so
they match the version installed.

## Where am I?

```sh
inyon status --json
```

| `role` | What this computer is | What you can do here |
|---|---|---|
| `hub` | Runs the hub: the web app people sign in to, which reaches every other machine | Add pages, show the setup code, list the machines that joined it (`nodes`) |
| `joined` | Joined to the hub named in `hub`. It connects out, so the hub shows its sessions | Add pages (the hub shows them from 0.22). The hub's other machines and sessions aren't visible from here |
| `node` | Paired straight with the Android app over its own link, no hub | Pair another phone with `inyon pair` |
| `none` | Not set up yet | Tell the user to run `inyon setup`, which asks questions in their terminal |

The same object has `machine` (this computer's id), `jobs` (what runs and its version), `agents` (the
agents in tmux here), `hints` and `docs`. A note in `note` means something needs attention, such as
the hub being unreachable.

## Read the docs

```sh
inyon docs                 # every page with one line on what it covers
inyon docs machines        # one page as Markdown, with its address on inyon.tech
inyon docs add machine     # a name, the start of one, or words from its title all work
```

| For | Topic |
|---|---|
| Installing, the first run | `install`, `quick-start` |
| Which setup to pick: paired, hub or SSH | `setups` |
| Running a hub, reaching it from a phone | `hub` |
| Adding a laptop or server to a hub | `machines` |
| Pairing a computer with the phone | `computers` |
| Showing a site in the app | `pages` |
| Every command and flag | `cli` |
| What each agent supports | `agents` |
| Something doesn't work | `troubleshooting` |

Give the user the page's inyon.tech address when they'd rather read it themselves.

## Common tasks

**Show the user a site you built** (a plan, a report, mockups): a folder with an `index.html`.

```sh
inyon pages add <folder> --name "Readable name"
```

It answers with where the page sits in the app (Pages, then machine, then project). Hand that over,
not a URL: a link that opens a page is made by the app and lasts 12 hours. A hub before 0.22 shows
pages from its own computer only; on a joined machine `add` then says the page can't open, and the
user needs a newer hub, or the folder on the hub's computer. Don't serve the folder on a public
address. The `blueprint` skill builds and publishes plan sites this way.

**Add a computer to a hub.** The hub makes the command: **Machines → Add a machine** in its app gives a
one-line command with a token for that one machine. Ask the user to run it on the new computer. Never
make up a token or ask the user to paste one into the chat.

**Pair a phone.** `inyon pair` prints a QR code and a code to type. The user scans it in the app.

**Run a hub.** `inyon hub start` on Linux or macOS. On Windows the hub runs inside WSL.

**Clean up temp files agents left.** `inyon temp` lists them. Once the user agrees, `inyon temp clean
--older-than 7d --yes` deletes the old ones (without a terminal it deletes nothing unless you pass `--yes`).

## Rules

- Every command takes `--json`. A failure is `{"v":1,"ok":false,"error":"…"}` with exit code 1. Read
  the error out to the user rather than retrying blindly.
- Ask before anything that cuts the user off from their own machines: `inyon stop`, `disconnect`,
  `uninstall`, `forget`, `hub stop`, `hub reset-password`. Don't restart the hub while they're using
  it.
- Never print or copy what's in `~/.inyon` (the machine's key and token, `hub.env`, the hub's
  records). Read state through `inyon status --json`.
- If your sandbox can't write to `~/.inyon`, the command says so. Give the user the exact line to run
  in their own terminal.
- Never type into the user's own tmux sessions to test something. Make a throwaway session.
