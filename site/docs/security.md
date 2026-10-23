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
- **Machines connect out, not in.** A machine running `inyon` opens an outbound connection to the hub; nothing on it listens. Each machine gets its own random token, the hub stores only its SHA-256, and removing the machine revokes it. A token no machine has used stops working after a day. `inyon` refuses to send its token over plain HTTP unless the hub is on the same machine or on a Tailscale or NetBird address (from 0.20; before, any private address or a name ending in `.local`, `.lan` or `.internal`). A hub on a certificate it made itself is pinned by the SHA-256 in its **Add a machine** command: only that certificate, only from the hub's address.
- **HTTPS on the LAN.** From 0.20 setup's *LAN* choice serves HTTPS on a certificate made for the machine, and shows its fingerprint to check in the browser. Only a VPN address gets plain http.
- **What you type stays off command lines.** From 0.20, messages, drafts, keys typed in the terminal view and API keys pasted into an agent's sign-in reach tmux on the command's input and through a file only you can read, never as a program's arguments, which other users on a shared machine could list.
- **Servers over SSH** use the hub's own `ssh` with your config and keys. The hub stores no SSH keys. It accepts a new server's host key on first contact and refuses one that changes later.
- **What it asks the internet.** Besides its own update check, from 0.17.4 the hub asks `registry.npmjs.org` for the newest version of each agent's npm package when a machine's Setup tab opens, at most once an hour per package. The request names the package and nothing else; nothing about you or your machines is sent.

## Pages

From 0.20 the hub shows the sites your agents make on its machine, such as a Blueprint plan with its mockups and progress board. An agent wrote that HTML and JavaScript, and an agent can be talked into writing anything, so the hub treats every page as untrusted.

- **Signed in to see one.** Only a signed-in browser or a paired phone can list pages or open one.
- **A link per page.** A page opens under `/v/<link>/` on the hub's own port. The link is signed with a key made from the hub's session secret, opens one page and nothing else, and lasts 12 hours. The app makes a fresh one each time you open the page.
- **No cookie under `/v/`.** Those answers never read your sign-in cookie or a phone's token, and never set a cookie. A link that is expired, revoked or altered gets "Link expired" whoever asks.
- **Ending links.** Revoking a page's links ends every link made for it so far. Removing the page does the same, from the app, with `inyon pages rm` or by editing `pages.json`, even while the hub is stopped, so a page added again under the same name doesn't open old links. Changing the hub's password ends the links of every page. A link made on a phone stops working when you forget that phone.
- **A sandbox on every answer.** Every answer under `/v/`, errors and redirects too, carries a Content-Security-Policy sandbox without `allow-same-origin`. The page runs with an origin of its own, even opened in its own tab, so it can't read the app's cookies or storage (where the app keeps the tokens of other hubs) or reach into the app's page. In its own tab the address bar still shows the hub's address, since pages share the hub's port.
- **Only its own files.** A page can load scripts, styles, images, fonts and data only from its own link's address, never from the internet or another page, and a form on it can't submit to any address. The hub also turns off DNS prefetching for it. Names starting with a dot (`.git`, `.env`, the `.inyon-page.json` marker) are never served, folders are never listed, and a file a symlink leads to outside the site's folder isn't served.
- **The API refuses framed callers.** From 0.20 a call to the hub's API that carries the sign-in cookie is refused when it comes from a page with no origin of its own (`Origin: null`) or from another site (`Sec-Fetch-Site: cross-site`), reads included. A paired phone sends its token instead of a cookie and isn't affected. `INYON_ALLOWED_ORIGINS` names origins that may still call.
- **Folders that can't be pages.** `/`, your home folder and anything under `~/.ssh` or `~/.inyon` can't be added, judged by the path and by where its symlinks lead. A page's folder needs an `index.html`.
- **Nothing in a folder can stall the hub.** The hub reads a page's `progress.json` and its `.inyon-page.json` only when each is a plain file, not a symlink or a named pipe, so a pipe an agent leaves there can't hold the hub up waiting for data. `pages.json` may be a symlink, for dotfile setups, but it too is read only when it leads to a plain file, and only up to 4 MB. When you add a page, git gets 3 seconds to name its project, so a pipe in the folder's `.git` can't hold things up either: past that, the page is grouped under its own folder. `inyon pages` and Blueprint work the same way.

What the sandbox doesn't stop:

- **A page can reach the internet without being seen.** Its script can open a WebRTC connection, make the browser look up a name in DNS, move to an outside address with data in the URL, or open a window. No header or sandbox flag blocks all of these in today's browsers, and nothing on screen has to change.
- **What it can carry out** is anything the agent that wrote it could read, and anything typed into the page. An agent whose own sandbox has no network but can read your disk could copy `~/.aws/credentials` or a GitHub token into the page's folder, and the page would send it from your browser.
- **Never type the hub password into a page.** Inyon never asks you to sign in inside one. A page opened in its own tab sits at the hub's own address, so a fake sign-in form there looks real, and a password typed into it goes to the page. Today Chrome and Firefox turn their password managers off for a page with no origin of its own, as a sandboxed page is, so they shouldn't offer a saved password there. Don't rely on that. A separate hostname for pages, so a page never shares the hub's address, is planned.

## Phones paired with a hub

- Only a browser that signed in within the last 10 minutes can show a pairing code. A code works once, for 10 minutes, and five wrong tries cancel it.
- The phone gets its own random token; the hub stores only its hash. Its WebSocket connections use a single-use ticket that lasts 30 seconds, so the token never travels in a URL.
- A paired phone can use the hub's machines but not its account: it can't change the password or pair or forget other phones.
- **Settings → Paired devices → Forget** cuts a phone off at once. Changing the hub's password doesn't unpair phones; forget them separately.

## Companion apps paired with a hub

From 0.20 an app like Legato can pair with a hub. See [Companion apps](companions.md).

- Only a browser that signed in within the last 10 minutes can make a companion code, as can `inyon hub companion-code` on the hub's computer. A code is six characters, works once, for 5 minutes, and a new code ends the last one. Eight wrong codes in a minute from one address, or thirty from all of them, stop claims for the rest of that minute.
- The app gets its own random token; the hub stores only its SHA-256.
- The hub checks the app's four permissions on every route and every WebSocket message. Everything else gets `403`, and a WebSocket frame it may not send closes the connection. It never gets terminal data, the chat history, files, uploads, settings, the account or how the hub reaches a machine (SSH targets, key files, relays), and it can't send `/` or `!` commands, control characters or escape sequences. It never sees what's typed in a box and not sent, the queue, the text of sends, or Remote Control and share links.
- What it sends reaches the agent like a message you type, so the agent may act on it within its permission mode, and **Answer** approves or declines what the agent asks. Pair only apps you trust with that.
- Its token never opens `/node`, the `/v/` pages or the `/api/local` routes of the `inyon` command.
- **Settings → Paired devices → Remove** cuts it off at once and closes its connection. Changing the hub's password doesn't remove companion apps; remove them separately.

## Computers paired with the phone

A paired phone gets a shell on the computer as the user running `inyon`, the same as SSH.

- **The pairing code is the secret.** It works for 10 minutes and for one phone. Don't share a screenshot of it. `inyon forget` revokes a phone.
- **Typed codes.** The ID and the 6-digit code together pick out the computer's record on the relays, through a slow key derivation, so knowing the ID alone doesn't let anyone stand in for the computer. From 0.17.4, typing a code needs both the app and the computer on that version or newer; the QR code and the link work across versions.
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

Nothing, unless you turn on the Claude Code integration from the machine's Integration tab (or switch a Claude Code model, below). Then it:

- writes `~/.inyon/hook.sh` and `~/.inyon/statusline.sh`, and registers them in `~/.claude/settings.json`, backing that file up first to `settings.json.inyon-backup`;
- keeps your own status line in `~/.inyon/statusline.orig` and still runs it;
- does the same for Antigravity CLI in `~/.gemini/antigravity-cli/settings.json`, if it's installed;
- puts the integration back, at most once every ten minutes, if something else rewrites `settings.json`;
- for a session that was already running when its settings were replaced, adds the status line to that project's `.claude/settings.local.json` (only if it has none) and lists that file in `.git/info/exclude`, so git never sees it.

Turning the integration off undoes all of it. The hook's log holds your prompts, so `~/.inyon` is readable only by you.

On Windows, ticking *LAN* or *VPN* in setup adds one firewall rule, "Inyon link", once an administrator allows it. It lets in TCP on the link's port, to `inyon-engine.exe` only, from the local network and the VPN address ranges. From 0.19 that file is the copy of `inyon.exe` without a console, and the link runs from it even when you start it in a terminal, or when `inyon pair` starts it because none was running. `inyon uninstall` removes it.

Switching a Claude Code session's model or effort from Inyon touches `settings.json` too, with or without the integration: Claude Code saves the pick there as your default, and from 0.17.1 Inyon puts the old `model`, `effortLevel` and `modelSettings` values back (see [Controls](controls.md#model-effort-and-mode)). It only replaces the file if it hasn't changed since Inyon read it, and leaves every other byte as it was.

Uploads go to `~/.inyon/uploads` and are deleted after the period you choose. From 0.17 a computer also deletes them by itself when no hub does, and an upload that broke off halfway is deleted after an hour. Files with secrets (the integration's settings, a pasted prompt, a token file) are written readable only by you from the first byte, and a temporary file is removed even when the write is interrupted.

## Removing a machine cleans it up

From 0.17, removing a machine that can be reached takes back what Inyon put there before it goes: the Claude Code and Antigravity integration (your own status line comes back), the uploads, the prompt log and the SSH connection the hub kept open to it. Removing a server the phone reached with its phone key also takes that key out of the server's `~/.ssh/authorized_keys`, and nothing else in the file changes. Removing a paired computer from the phone unpairs the phone on that computer too. A machine that's off or out of reach is removed anyway; run `inyon uninstall --purge` on it later, or delete the files by hand.

## What Inyon reads

For Claude's plan limits, the hub runs a short script on the machine that reads Claude Code's access token from `~/.claude/.credentials.json` (or the macOS Keychain) and asks `api.anthropic.com` for the account's usage, as `/usage` does. The token goes to `curl` on stdin, so it never appears in the process list, and it never leaves that machine. Only the percentages and reset times come back.

From 0.17 the **Files** tab and **Changes → Working tree** read the session's folder on the machine while you have them open: a folder listing, one file, or `git status` and one file's diff. Nothing is kept on the hub or the phone. **Commit all** and **Push** run only when you press them, as your user, with git's own hooks and signing.

From 0.17.6, OpenCode's providers are OpenCode's own business. Connecting one runs `opencode auth login -p <provider>` on that machine, in a tmux session of its own: a key you type in the app is typed into that command and goes nowhere else, is never logged, and Inyon never reads `auth.json`, where OpenCode keeps it. Listing providers runs `opencode auth list`, which prints names and kinds, never values; when no OpenCode session of Inyon's is running on the machine, it also starts `opencode serve` on `127.0.0.1` for a few seconds in an empty folder to read the provider catalogue, and stops it. Disconnecting runs `opencode auth logout`.

## Downloads

Every release ships a `SHA256SUMS` file, and from 0.14 a minisign signature of it, `SHA256SUMS.minisig`, made with Inyon's release key:

```
RWRTvQv/ifQnD3jarY1oarS0AKdhogH+mdgn/o0NzT/Ro8L43nFqqfp6
```

- `inyon update` and `inyon setup` refuse a list without a good signature before they download anything. The key is built into `inyon`, so an environment variable can't swap it for the real releases, on this site or on GitHub.
- Installs and updates download from this site. Its `latest.json`, which names the newest version, isn't signed, so it only chooses what to fetch: `inyon update` also checks that the signed list names that version's APK, and refuses an old or altered copy. This ties each release to its Android build: if that build fails, machines stay on the version they have until the release is complete, rather than take one that isn't.
- From 0.20 the installers this site serves at `/get.sh` and `/get.ps1` carry the sha256 of the list the site checked when it published the release, and trust no other list. That one line is all that differs from the copies in `/download/` and on the release. Anywhere else they check the signature with `minisign` and that the list names the APK of the version they asked for, so an older release's list is refused. Without `minisign` they stop, unless told to go on with `--no-signature-check`. Either way they check every download against the list before running it.
- A hub hands its own version's files to its machines, so a machine always runs what its hub runs. The **Add a machine** command carries the checksum of the hub's list. From 0.20 the hub itself checks the release's signature with the same built-in key before it hands out or lists any file, including from a mirror set with `INYON_DOWNLOAD`, and answers 502 when the signature is missing or wrong.
- From 0.20 a machine that updates from its hub, or fetches its engine there, checks what it downloads against the release's signed `SHA256SUMS`, which the hub passes on with its signature, never against a checksum only the hub gives. The list has to name the APK of the version the hub says it runs, as `inyon update` asks of this site, so an older release's list can't be passed off as the hub's; the hub holds the release it fetches to the same rule. A hub from before 0.20, or one running from a checkout, has no signed list, and the machine changes nothing until the hub is updated or `INYON_ALLOW_INSECURE=1` says to take the hub's checksums.
- From 0.19 a computer that isn't a hub downloads one program, `inyon`, and no longer the Bun engine. On Windows, `inyon-engine.exe` is made on the computer from the checked `inyon.exe`, with one header field changed so it opens no console.
- The files on this site are copied from the release. The site's build checks the signature and every file's checksum, and publishes nothing if one fails. From 0.20 the installers are in the signed list too; for an older release the site takes them only when they're byte for byte the ones in the commit the release is tagged on. A new release appears here only once its APK is listed in the signed list.
- In the release workflows, only the jobs that publish can change a release. They install nothing but Ubuntu's `minisign` package, to sign, and never install or run the project's dependencies. The Android build lists its APK in `SHA256SUMS` and signs it again only after the list's own signature checks out against the release key, and only once the APK on the release is the one it built.
- The npm packages (`@abhash-chakraborty/inyon` and one per system) are published only by the release workflow on GitHub, through npm's trusted publishing, so no npm token is stored for them. The workflow copies the programs from the release after checking the signature and every checksum, and each version carries a provenance statement naming the run that published it. `npm audit signatures` checks that after installing.
- `cloudflared` is pinned to one version and checked against a known hash.

[Checking a download](/download/#verify) shows how to check a file by hand.

## Reporting a vulnerability

Please report it privately through [GitHub's vulnerability reporting](https://github.com/Abhash-Chakraborty/inyon/security/advisories/new) rather than in a public issue, with steps to reproduce. You'll get a reply within a few days.
