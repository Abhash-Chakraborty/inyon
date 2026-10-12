# Inyon

Your coding agents keep running in tmux on your machines. Inyon lets you watch them, answer
them and steer them from your phone or any browser.

It works with Claude Code, Codex, Gemini CLI, OpenCode and GitHub Copilot, on as many machines as
you have, each signed in to whatever account it already uses. Nothing about how you work at the
keyboard changes: walk away from your laptop, pick the session up on your phone, sit back down
and carry on in the same terminal.

## Why

I run agents on a laptop, a personal server and a company server. Each is signed in to a
different account, and on the company machine I only have the CLI. Built-in remote features
follow one account at a time, so switching between machines meant switching accounts.

Inyon never signs in anywhere. It drives the agent CLI that is already running in tmux on each
machine, so every machine can use its own account, subscription or API key.

## What you get

- **A real chat view** for each agent session: formatted replies, tool calls, diffs, plans and
  to-dos, instead of a terminal squeezed onto a phone. A full terminal is one tap away.
- **Prompts as buttons.** Permission requests, questions, menus and sign-in links show up as
  native controls. Answer from the overview without opening the session.
- **Live numbers:** model, reasoning effort, context window, cost, run time, lines changed, and
  the 5-hour and weekly plan limits with reset times. Codex credits too.
- **Controls:** switch model, effort and permission mode; set a goal and turn it off again; turn
  Remote Control on and off; compact, clear and rewind.
- **Everything in the background:** queued messages, background shells with live output and a
  real Stop, monitors, subagents (open their own transcripts) and artifacts.
- **A composer that knows the agent:** `/` suggestions for built-in commands, skills, plugins and
  your own commands; `@` fuzzy file search; attach, paste or drop images and files.
- **Drafts follow you.** What you type is saved and mirrored into the terminal's input box, and
  what you type in the terminal shows up in the app.
- **Each agent looks like itself.** The app is neutral; a session takes on its agent's colours,
  logo and reply font.
- **Machine setup:** checks for tmux and each agent, installs what's missing, opens sign-in, and
  can keep a tmux session running.
- **Phone, tablet and desktop**, light and dark, with haptics on phones. Installable as a web app.

## How it works

A small hub runs on one machine you trust. It talks to each machine in one of three ways:

| Machine | How the hub reaches it |
|---|---|
| The hub's own machine | Directly |
| A laptop or desktop | It runs `inyon`, which connects **out** to the hub. No open ports. |
| A server | SSH, using your existing `~/.ssh/config`, keys and jump hosts |

The Android app works without a hub. It runs the same core on the phone and connects to your
servers over SSH by itself (see [Android app](#android-app)).

On each machine the hub reads tmux and the agents' own records:

| What | Where it comes from |
|---|---|
| Panes and agents | `tmux` plus the process tree; live changes through a read-only tmux control client |
| Conversations | Claude Code and Codex session files, Gemini CLI chat recordings, OpenCode's local server |
| Prompts and spinners | The pane's screen, parsed into options |
| Plan limits | Claude: the account's usage, read on the machine the same way `/usage` does. Codex: token events |
| Context, cost | Claude's status line data (optional integration) and transcripts, Codex token events |
| Typing and answering | `tmux send-keys`, exactly as if you typed it |

Agents never know Inyon is there. If you close Inyon, nothing breaks.

## Agent support

| Agent | Chat view | Live status | Prompts | Notes |
|---|---|---|---|---|
| Claude Code | Full | Full, with the integration | Full | Hooks give exact session matching |
| Codex | Full | Context, limits, credits | Numbered prompts | Reads `~/.codex/sessions` |
| Gemini CLI | Beta | Context | Numbered prompts | Reads `~/.gemini/tmp/*/chats` |
| OpenCode | Beta | Context, cost | Through its API | Talks to the server OpenCode already runs |
| GitHub Copilot | Beta | Context and activity | Native CLI prompts | Reads the running CLI session |

## Quick start

On Linux or macOS, this installs the hub as one program and keeps it running as a user service:

```sh
curl -fsSL https://github.com/Abhash-Chakraborty/inyon-releases/releases/latest/download/get.sh | sh -s -- --hub
```

It prints the address to open and the setup code. Settings like `PORT`, `BIND` or `TLS_CERT` go
in `~/.inyon/hub.env`, one `NAME=value` per line.

To run it from source instead, you need [Bun](https://bun.sh) 1.3+ and tmux:

```sh
git clone https://github.com/Abhash-Chakraborty/inyon.git
cd inyon
bun install
bun run build
bun start
```

The hub listens on `127.0.0.1:4777`. Open it and the first visit asks you to create a password,
with the setup code the hub prints when it starts (also in `~/.inyon/setup-code`). Change the
password later in Settings, or reset a forgotten one with `bun apps/hub/src/cli/set-password.ts`.

Open it from your phone over a private network (Tailscale, NetBird, WireGuard or your LAN), or
put it behind an HTTPS reverse proxy. Behind a proxy on a public domain, add that domain to
`INYON_ALLOWED_HOSTS`. To keep it running, see `deploy/inyon-hub.service`.

## Updating

Nothing updates by itself. When a new release is out, Settings shows *Update available* under
Updates. A hub installed with `get.sh --hub` updates with *Update* or `inyon update`: it
downloads the release, checks it against SHA256SUMS, swaps it in and restarts, and goes back to
the old one if the new one doesn't start. A hub installed from source updates with *Update* too, or
run this in the folder you cloned:

```sh
bun hub:update
```

It refuses a checkout with local changes or one that can't fast-forward. Otherwise it pulls,
runs `bun install`, builds the web app and restarts the `inyon-hub` systemd user unit. Without
that unit it tells you to restart the hub yourself. Browsers that still have the old app open
offer a reload once the hub is back.

The Android app checks [inyon-releases](https://github.com/Abhash-Chakraborty/inyon-releases)
once a day and when you open Settings. *Download* opens the new APK in your browser; open the
file when it's done and Android installs it over the old one.

## Where everything runs

For the browser there's one thing to host: the hub. It's a single Bun process on a machine that
stays on, like a home server, a VPS or a desktop that doesn't sleep. The hub serves the web app
itself, so there's nothing to deploy to Vercel or a CDN. The Android app needs nothing hosted.

- **In a browser**, the hub's address is the app: `http://my-server:4777` over Tailscale or
  NetBird, or `https://inyon.example.com` behind a reverse proxy. The same page works on a phone.
- **Installed on a phone** from the browser ("Add to Home Screen"), with system notifications, it
  needs HTTPS. Put the hub behind Caddy or `tailscale serve`, or set `TLS_CERT` and `TLS_KEY`.
- **The Android app** comes from the GitHub release and talks to your servers directly over SSH.
  No hub, no password, nothing to keep running.
- **Other machines** don't host anything. They run tmux and your agents, and the hub reaches them
  as described below.

Don't open port 4777 to the internet without HTTPS. The hub can run commands on every machine
you add, so anyone who can reach it gets to try your password. Settings shows the address to use
on your other devices.

## Adding machines

**Laptops and desktops:** *Add a machine → This device connects to Inyon.* Copy the one-line
command onto that machine. It downloads the `inyon` program from the hub, checks it, and runs it as
a small user service. No sudo and no open ports.

**Servers:** *Add a machine → Connect over SSH* with `user@host` or an alias from the hub's
`~/.ssh/config`. The machine only needs tmux.

Each machine's **Setup** tab checks for tmux, Node.js and every agent, installs what's missing,
and opens sign-in for each agent in a terminal.

## When a machine drops off

Machines on different networks drop off at different times: a server over NetBird, a laptop over
Tailscale. The hub keeps the last thing it saw from each one on disk. An offline machine stays in
the list as "Offline · last seen 5m ago", with its sessions and their recent conversation still
readable. Sending is paused until it's back.

When a machine has been gone for a minute you get a notification, and another when it reconnects.
The hub then picks up each conversation where it left off.

## Android app

`apps/mobile` wraps the same web app with Capacitor, but the phone is its own hub. The app runs
Inyon's core in the app (`apps/hub/src/phone`) and reaches your machines itself, in one of two
ways. There's no server in between and no password.

### Any computer, from anywhere

Most people have a laptop and an internet connection, not a VPN. On a Mac or Linux machine, run
this in a terminal (on a server, in your SSH session):

```sh
curl -fsSL https://github.com/Abhash-Chakraborty/inyon-releases/releases/latest/download/get.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://github.com/Abhash-Chakraborty/inyon-releases/releases/latest/download/get.ps1 | iex
```

On Windows, Inyon drives [psmux](https://github.com/marlocarlo/psmux), the native tmux for
Windows, and setup installs it with winget if it's missing. Sessions, chats, sending, approvals,
sign-in and the terminal work as they do on Linux. psmux runs each session in its own server, so
the terminal there is drawn from the pane's screen instead of a second tmux client. It shows what
is on screen now; the laptop's own scrollback stays on the laptop.

It downloads `inyon`, checks it against the release's SHA256SUMS and prints a QR code. In
the app, tap *Add a computer*, then *Scan the code*. The computer stays paired until you remove it.

Can't scan it, say because the SSH session is on the same phone? The terminal also prints a
one-time ID and a 6-digit code: tap *Type a code* and enter them. The ID stands for a throwaway key,
and the computer publishes a record under it naming its real key and addresses, so the phone finds
it without a VPN. The code travels inside the encrypted channel, works once for 10 minutes, and
five wrong tries cancel it.

Setup also installs `inyon` as a background service, so it comes back after a restart: a systemd
user unit on Linux, launchd on macOS and a logon task on Windows. A box without systemd user
services gets a background process and an `@reboot` cron line instead. `inyon uninstall` removes
the service and leaves your pairings alone.

To update, run `inyon update`. It downloads the newest release, checks it against SHA256SUMS,
swaps it in and restarts the background service. If the new version doesn't start, the old one
comes back. When a computer's inyon is behind, its page in the app shows *Update*, which runs the
same command; nothing updates without that tap.

Before 0.7.0 the program was called `tether-node`. A computer set up then updates the same way. A
few minutes after the new version starts, it moves its service to inyon's name and its files from
`~/.tether-node` to `~/.inyon/node`. A version from before `tether-node update` existed updates by
running the setup command once more.

A machine paired with a hub updates from that hub instead, with the same command or the *Update*
button on its page under *Machines*. The button works for any version, even one without the
command: the hub sends a short script that checks the download against the hub's checksum before
it replaces anything. A Linux or macOS machine added with tether-node before 0.7.0 ran it as a Bun
script; run the *Add a machine* command there once more instead.

`inyon` opens a free Cloudflare quick tunnel, so the phone reaches the computer from any
network without an account or an open port. Phone and computer talk over Noise (the IK pattern,
X25519 and ChaCha20-Poly1305), so the tunnel only ever carries ciphertext. The tunnel's address
changes when it restarts, so the computer publishes its current addresses under its own key with
[pkarr](https://pkarr.org) and the phone looks them up by the computer's id; a forged record fails
the signature check. `--lan` also answers on the local network, which is faster at home.

The binaries for Linux, macOS and Windows are built by `.github/workflows/node.yml` and published
to [inyon-releases](https://github.com/Abhash-Chakraborty/inyon-releases). From a checkout,
`bun apps/node/inyon.ts pair` does the same. `inyon phones` lists paired phones and
`inyon forget <name>` unpairs one.

### A server over SSH

If you can't install anything on a server, the phone can reach it over SSH instead. The app opens
SSH connections with a native plugin (`InyonSshPlugin`, built on ConnectBot's sshlib).

1. Tap *Add a computer*, then *Can't install anything? Connect over SSH instead*. Give it
   `user@host` and a port.
2. Pick how it signs in: the phone's own key, a password, or a private key you paste.
3. The phone's key is an ed25519 key made on the phone the first time you need it. Copy the
   command the app offers and run it once on the server; it adds the key to
   `~/.ssh/authorized_keys`. The private half never leaves the phone.
4. The app shows the server's host key fingerprint before it signs in for the first time. Compare
   it with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server and trust it. If the
   key ever changes, the app refuses to connect until you confirm the new one.

Passwords, pasted keys and the phone's key are kept in Android's encrypted storage. The server
list and the chat history the app has seen stay in the app's own storage. The phone has to reach
the server, so use the same Wi-Fi or a VPN like Tailscale or NetBird. A server on Tailscale SSH
lets the phone in with no key or password. The servers only need tmux and your agents, the same
as with the hub.

GitHub Actions builds it (`.github/workflows/android.yml`). Every push to `main` replaces the
"Latest Android build" pre-release with a fresh APK, and a `v*` tag makes a release with the APK
attached. On the phone, open the release, download the APK and install it. Later builds install
over it and keep your servers. Each release's APK also goes to
[inyon-releases](https://github.com/Abhash-Chakraborty/inyon-releases) as `inyon-X.Y.Z.apk`
(uploaded by hand), which is where the app looks for updates.

Builds are signed with your own key: the secrets `ANDROID_KEYSTORE_BASE64` (the keystore, base64)
and `ANDROID_KEYSTORE_PASSWORD`, plus `ANDROID_KEY_PASSWORD` for a JKS with a separate key
password, and the repository variable `ANDROID_KEY_ALIAS`. Keep a backup of the keystore: Android only installs an
update signed with the same key. Without the secrets, a fork gets a debug build.

To build it yourself you need Android Studio:

```sh
bun run build
cd apps/mobile
bun x cap sync android
bun x cap open android
```

The iOS project is in `apps/mobile/ios` but isn't built or tested yet, and it has no SSH plugin.

Android freezes apps in the background, which drops their connections. Turn on *Stay connected*
in Settings and the app keeps a small ongoing notification so it stays alive and alerts arrive
right away; Android 15 caps this at 6 hours a day, reset each time you open the app. Without it,
the app checks every connection the moment you come back instead of waiting out a retry timer.
Push notifications for a closed app need a Firebase project (four repository secrets, see
`.github/workflows/android.yml`) and a relay that sends them, which isn't built yet.

Images from the keyboard (Gboard's clipboard, stickers, screenshots) paste into the message box
as attachments. CI runs the SSH plugin's tests against a real sshd (the `ssh-plugin` job).

To use a hub from your phone instead, open its address in the phone's browser.

## Security

The hub can run commands on every connected machine, so it should be reachable only by you. It
binds to localhost by default, stores only a hash of its password, and rate-limits sign-ins.
Paired machines connect out with per-machine tokens that you can revoke. See
[SECURITY.md](SECURITY.md) for the full model and what Inyon changes on a machine.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `4777` | Hub port |
| `BIND` | `127.0.0.1` | Address to listen on. Anything but localhost needs `TLS_CERT`/`TLS_KEY`, or `INYON_ALLOW_HTTP=1` |
| `INYON_ALLOW_HTTP` | | Set to `1` to serve plain http on a network `BIND`, for a VPN address that encrypts on its own |
| `INYON_DATA_DIR` | `~/.inyon` | Password hash, machine list, drafts, settings |
| `INYON_ALLOWED_ORIGINS` | | Extra comma-separated origins allowed to call the hub, for a reverse proxy on another hostname |
| `INYON_ALLOWED_HOSTS` | | Extra comma-separated host names the hub answers to. IP addresses, single-label names, localhost and Tailscale/NetBird names always work; add a public domain your proxy uses. `*` turns the check off |
| `TLS_CERT`, `TLS_KEY` | | Paths to a PEM certificate and key to serve HTTPS. Needed for a real installed app on phones (and clipboard images, notifications) |

## Development

```sh
bun dev:hub        # hub with reload
bun dev:web        # Vite dev server on :5173
bun run typecheck
cd apps/hub && bun test
```

```
apps/hub           Bun server: machines, tmux, agent readers, API, WebSocket
                   (src/phone runs the same core inside the Android app)
apps/web           React + Vite app (also served by the hub)
apps/node          the inyon program: the phone link, the hub connection, and the hub itself
apps/mobile        Capacitor shell for the Android and iOS apps
packages/protocol  types and the agent registry shared by hub and app
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to add an agent or fix a parser.

## Status

Inyon is young. Linux, macOS and Windows (through psmux) work today. Expect rough edges with
the beta readers.

## License

MIT. See [LICENSE](LICENSE). Agent names and logos belong to their owners; see
[NOTICE.md](NOTICE.md).

### OpenCode and GitHub Copilot

Inyon wraps the installed CLIs and their sessions. New OpenCode sessions expose a loopback API
with `--hostname 127.0.0.1 --port 0`. Connected providers supply the model list and reasoning
variants; Build/Plan selects the OpenCode agent. Dashboard settings apply to the next prompt.
Use Sign in to choose a provider and complete its native login flow. Existing ambiguous sessions
in the same directory need an explicit `-s` session ID. Password-protected OpenCode servers are
not yet supported by this adapter.

Copilot uses its process locks and event log to identify the running session. Models come from
the CLI catalog and reflect account access; Auto-only plans show Auto. Manual approval and full
access are supported. Experimental assisted approval and model effort changes remain terminal
controls. Sign-in uses Copilot's device-code flow. Neither integration invents a goal API.

Start a composer message with `!` to run a shell command through Claude Code, Codex, OpenCode,
or Copilot. Its output appears in chat. The CLI owns execution and permission handling.
