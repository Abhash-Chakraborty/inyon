# Security

Tether gives whoever signs in to the hub a shell on every connected machine, as the user the
agents run as. Treat the hub like an SSH jump host.

## How it is meant to be deployed

- **Keep the hub private.** It binds to `127.0.0.1` by default. Reach it over a private network
  (Tailscale, NetBird, WireGuard, your LAN) or put it behind HTTPS with a reverse proxy. Don't
  expose plain HTTP to the internet.
- **One strong password.** The first visit creates it; when the hub listens beyond localhost, that
  visit also needs the setup code the hub prints. The hub stores only a scrypt hash. Sign-in
  attempts are rate limited. Sessions are signed, HttpOnly cookies, and the API only accepts
  changes from the hub's own origin.
- **Laptops connect out, not in.** Machines paired with `tether-node` open an outbound connection
  to the hub. Nothing on them listens for connections, so you never open SSH on a laptop. Each
  machine gets its own random token, the hub stores only its SHA-256, and removing the machine
  revokes it. `tether-node` refuses to send its token over plain HTTP unless the hub is on a
  private address.
- **Servers can use SSH.** The hub uses your existing `ssh` config, keys and known hosts. It never
  stores SSH keys.

## The Android app

The app is its own hub, so whoever holds the unlocked phone can reach your servers, the same as
with a terminal app that has your keys.

- **Host keys are pinned.** The app shows a server's fingerprint before the first sign-in and
  stores the one you trust. A different key later stops the connection until you confirm it.
- **Secrets stay on the phone.** The app's ed25519 key, passwords and pasted keys live in
  EncryptedSharedPreferences (Android Keystore). Android backups are off for the app.
- **Nothing in between.** The app connects straight to each server over SSH. No relay or hub sees
  the traffic.

## What Tether changes on a machine

Only if you turn on the Claude integration: it writes `~/.tether/hook.sh` and
`~/.tether/statusline.sh`, registers them in `~/.claude/settings.json` (backed up first), and
keeps your original status line in `~/.tether/statusline.orig`. Turning it off restores both.
If Antigravity CLI is installed, it does the same for agy: `~/.tether/agy-statusline.sh` goes into
`~/.gemini/antigravity-cli/settings.json` (backed up first), your own agy status line is kept in
`~/.tether/agy-statusline.orig`, and turning the integration off restores it.
If the integration disappears from `settings.json` (say, a sync script replaced the file), Tether
puts it back, at most once every ten minutes. Turning the integration off stops that.
A session that was already running when its settings were replaced keeps ignoring
`settings.json`, so Tether also adds its status line to that project's
`.claude/settings.local.json`. It does this only when the project has no status line of its own,
and it adds the file to `.git/info/exclude` so git never sees it. Tether keeps a list of these
files in `~/.tether/project-statuslines` and removes the line from each one when you turn the
integration off.
Uploads go to `~/.tether/uploads` and are deleted after a retention period you choose.

## What Tether reads

For Claude plan limits, the hub runs a short script on the machine that reads Claude Code's
access token from `~/.claude/.credentials.json` (or the macOS Keychain) and asks
`api.anthropic.com` for the account's usage, as `/usage` does. The token is passed to `curl` on
stdin, so it never appears in the process list, and it never leaves that machine. Only the
percentages and reset times come back to the hub.

## Reporting a vulnerability

Please email the maintainer instead of opening a public issue, with steps to reproduce. You will
get a reply within a few days.
