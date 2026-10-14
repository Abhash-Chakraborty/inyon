---
title: Security
description: What Inyon can do on your machines, how each connection is protected, what it changes and what it reads.
---

Inyon gives whoever reaches it a shell on your machines, as the user your agents run as. A paired phone can do on a computer what you could do over SSH, and a signed-in hub can do it on every machine it reaches. Treat both like an SSH key.

## A hub

- **It stays private by default.** It listens on `127.0.0.1` until you choose a network. Reach it over a VPN or your LAN, or put it behind HTTPS. Don't expose plain HTTP to the internet.
- **One strong password.** The first visit creates it, with the setup code the hub prints. The hub stores only a scrypt hash. Sign-in attempts are slowed and rate-limited per address and in total.
- **Sessions** are signed, HttpOnly cookies that last 30 days. Changing the password signs out every browser. The API only accepts changes from the hub's own origin.
- **Only its own names.** The hub doesn't answer a browser that reaches it under a public domain it wasn't told about (`INYON_ALLOWED_HOSTS`), so a web page can't point its own domain at your hub (DNS rebinding) and use it from your browser.
- **Machines connect out, not in.** A machine running `inyon` opens an outbound connection to the hub; nothing on it listens. Each machine gets its own random token, the hub stores only its SHA-256, and removing the machine revokes it. A token no machine has used stops working after a day. `inyon` refuses to send its token over plain HTTP unless the hub is on a private address.
- **Servers over SSH** use the hub's own `ssh` with your config and keys. The hub stores no SSH keys. It accepts a new server's host key on first contact and refuses one that changes later.

## Phones paired with a hub

- Only a browser that signed in within the last 10 minutes can show a pairing code. A code works once, for 10 minutes, and five wrong tries cancel it.
- The phone gets its own random token; the hub stores only its hash. Its WebSocket connections use a single-use ticket that lasts 30 seconds, so the token never travels in a URL.
- A paired phone can use the hub's machines but not its account: it can't change the password or pair or forget other phones.
- **Settings → Other devices → Forget** cuts a phone off at once. Changing the hub's password doesn't unpair phones; forget them separately.

## Computers paired with the phone

A paired phone gets a shell on the computer as the user running `inyon`, the same as SSH.

- **The pairing code is the secret.** It works for 10 minutes and for one phone. Don't share a screenshot of it. `inyon forget` revokes a phone.
- **End-to-end encrypted.** Phone and computer run Noise IK (X25519, ChaCha20-Poly1305, SHA-256). The phone already knows the computer's key from the code, so a tunnel, relay or network in between can't read or change the traffic, or pretend to be the computer. The computer only lets in phone keys it has paired.
- **The tunnel is public; the listener isn't open.** The Cloudflare quick tunnel gives the computer a public address, but it only reaches the link on `127.0.0.1`, which answers nothing until the handshake proves a paired phone. The link also listens on private-network addresses (not on Windows) with the same handshake; `--no-vpn` turns that off.
- **Addresses are signed.** The computer publishes where it can be reached as a pkarr record signed by its own key. The record names addresses only.
- **Keys** live in `~/.inyon/node/`, readable only by you.

## The Android app

The app is its own hub, so whoever holds the unlocked phone can reach your computers and servers, as with a terminal app that has your keys.

- **Host keys are pinned.** The app shows a server's fingerprint before the first sign-in and stores the one you trust. A different key later stops the connection until you confirm it.
- **Secrets stay on the phone.** The app's ed25519 key, passwords and pasted keys live in Android's encrypted storage. Android backups are off for the app.
- **Nothing in between.** SSH goes straight from the phone to the server.

## Notifications

- **A hub** sends Web Push to the browsers registered with it.
- **A computer** sending to a [browser copy](browser-copy.md) keeps that browser's push subscription in `~/.inyon/node/push.json`, readable only by you. Each message is encrypted to that browser (RFC 8291), so the push service (Google, Mozilla or Apple) sees only ciphertext. `inyon forget` drops that phone's subscriptions.

## What Inyon changes on a machine

Nothing, unless you turn on the Claude Code integration from the machine's Integration tab. Then it:

- writes `~/.inyon/hook.sh` and `~/.inyon/statusline.sh`, and registers them in `~/.claude/settings.json`, backing that file up first to `settings.json.inyon-backup`;
- keeps your own status line in `~/.inyon/statusline.orig` and still runs it;
- does the same for Antigravity CLI in `~/.gemini/antigravity-cli/settings.json`, if it's installed;
- puts the integration back, at most once every ten minutes, if something else rewrites `settings.json`;
- for a session that was already running when its settings were replaced, adds the status line to that project's `.claude/settings.local.json` (only if it has none) and lists that file in `.git/info/exclude`, so git never sees it.

Turning the integration off undoes all of it. The hook's log holds your prompts, so `~/.inyon` is readable only by you.

Uploads go to `~/.inyon/uploads` and are deleted after the period you choose. From 0.17 a computer also deletes them by itself when no hub does, and an upload that broke off halfway is deleted after an hour. Files with secrets (the integration's settings, a pasted prompt, a token file) are written readable only by you from the first byte, and a temporary file is removed even when the write is interrupted.

## Removing a machine cleans it up

From 0.17, removing a machine that can be reached takes back what Inyon put there before it goes: the Claude Code and Antigravity integration (your own status line comes back), the uploads, the prompt log and the SSH connection the hub kept open to it. Removing a server the phone reached with its phone key also takes that key out of the server's `~/.ssh/authorized_keys`, and nothing else in the file changes. Removing a paired computer from the phone unpairs the phone on that computer too. A machine that's off or out of reach is removed anyway; run `inyon uninstall --purge` on it later, or delete the files by hand.

## What Inyon reads

For Claude's plan limits, the hub runs a short script on the machine that reads Claude Code's access token from `~/.claude/.credentials.json` (or the macOS Keychain) and asks `api.anthropic.com` for the account's usage, as `/usage` does. The token goes to `curl` on stdin, so it never appears in the process list, and it never leaves that machine. Only the percentages and reset times come back.

From 0.17 the **Files** tab and **Changes → Working tree** read the session's folder on the machine while you have them open: a folder listing, one file, or `git status` and one file's diff. Nothing is kept on the hub or the phone. **Commit all** and **Push** run only when you press them, as your user, with git's own hooks and signing.

## Downloads

Every release ships a `SHA256SUMS` file, and from 0.14 a minisign signature of it, `SHA256SUMS.minisig`, made with Inyon's release key:

```
RWRTvQv/ifQnD3jarY1oarS0AKdhogH+mdgn/o0NzT/Ro8L43nFqqfp6
```

- `inyon update` and `inyon setup` refuse a list without a good signature before they download anything. The key is built into `inyon`, so an environment variable can't swap it for the real releases, on this site or on GitHub.
- Installs and updates download from this site. Its `latest.json`, which names the newest version, isn't signed, so it only chooses what to fetch: `inyon update` also checks that the signed list names that version's APK, and refuses an old or altered copy. This ties each release to its Android build: if that build fails, machines stay on the version they have until the release is complete, rather than take one that isn't.
- The installers check the signature when `minisign` is installed, and say so when it isn't. Either way they check every download against the list before running it.
- A hub hands its own version's files to its machines with their sha256 in the command, so a machine always runs what its hub runs.
- The files on this site are copied from the release. The site's build checks the signature and every program's checksum, and publishes nothing if one fails. A new release appears here only once its APK is listed in the signed list.
- `cloudflared` is pinned to one version and checked against a known hash.

[Checking a download](/download/#verify) shows how to check a file by hand.

## Reporting a vulnerability

Please report it privately through [GitHub's vulnerability reporting](https://github.com/Abhash-Chakraborty/inyon/security/advisories/new) rather than in a public issue, with steps to reproduce. You'll get a reply within a few days.
