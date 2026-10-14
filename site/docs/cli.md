---
title: The inyon command
nav: inyon command
description: Every command and flag, the setup screens, the status dashboard and JSON output.
---

`inyon` is the command you run on each computer. It sets the computer up, shows what it's doing, pairs phones, manages the background service and updates itself. The work happens in `inyon-engine`, which `inyon` starts and talks to for you.

If `inyon` isn't found, open a new terminal: the installers put `~/.inyon/bin` on your `PATH` from 0.17.1. Before that, or with `INYON_NO_MODIFY_PATH=1`, see [Put inyon on your PATH](install.md#put-inyon-on-your-path).

## At a glance

| Command | What it does |
|---|---|
| `inyon` | The status dashboard |
| `inyon setup` | Choose how this computer connects, then pair |
| `inyon pair` | Show the pairing QR code and code again |
| `inyon phones` | List paired phones |
| `inyon forget <phone>` | Unpair a phone |
| `inyon join <hub>` | Add this computer to a hub |
| `inyon disconnect` | Leave the hub |
| `inyon hub start` | Run a hub here, as a service |
| `inyon hub stop`, `restart` | Stop or restart the hub |
| `inyon hub code` | Show the hub's setup code |
| `inyon hub reset-password` | Choose a new hub password |
| `inyon push` | List the browsers this computer sends notifications to |
| `inyon service install`, `uninstall`, `status` | Manage the background service |
| `inyon logs` | Show the service's output |
| `inyon doctor` | Check that everything is in place |
| `inyon update` | Update to the newest release |
| `inyon uninstall` | Remove Inyon |
| `inyon version` | Show the version |

Every command takes `--json` and `-h`/`--help`. `inyon -V` prints the version.

## Status

```sh
inyon
inyon status --plain
```

In a terminal, plain `inyon` opens a dashboard that refreshes every 2 seconds. It shows this computer's role (hub, joined to a hub, paired with phones, or not set up), its addresses, the background jobs and their versions, paired phones, a hub's machines, the agents running in tmux, and the last lines of the log. Times are in this computer's time zone. At 72 columns or wider it uses two columns.

| Key | Does |
|---|---|
| `p` | Show the pairing code |
| `q`, `Esc`, `Ctrl-C` | Quit |

`--plain` prints the same as lines of text, and `--json` as one object. Outside a terminal, `inyon` prints the plain form on its own.

## Setup

```sh
inyon setup
```

Setup asks a few questions in full-screen steps, applies the answers, and ends by showing the pairing code. The installers run it for you.

### The steps

1. **Role.** *Pair it with the phone* (the default), *Make it a hub* (Linux and macOS), or *Add it to a hub*.
2. **Network.** For a computer paired with your phone, tick any of:
   - *Tunnel*: a free Cloudflare tunnel, so the phone reaches it from any network. On by default.
   - *LAN*: also answer on the local network. Off by default.
   - *VPN*: also answer on Tailscale, Headscale, NetBird, ZeroTier or WireGuard. Setup lists the networks it found, and the computer answers on all of them. On by default, except on Windows, where it needs a firewall rule (see [below](#the-firewall-on-windows)).
   - *Own address*: a `wss://` address you publish yourself.
   - *Port*: 4780 by default.

   For a hub, pick where it listens: *This machine only*, the LAN, or one of the VPN networks found, or type an address. The port is 4777. To join a hub, type the hub's address.
3. **Background.** *Run in the background* (a service that starts at login or boot), or *Only while this window is open*.
4. **Sign in** (hub only). How you'll create the hub's password from the browser.
5. **Summary.** What will happen, with every network it will answer on. Press Enter to set it up.

While you answer, setup downloads and checks `inyon-engine` in the background, with the progress in the footer.

| Key | Does |
|---|---|
| `↑` `↓`, `Tab`, `j` `k` | Move between rows |
| `Space` | Choose the row, or tick and untick a box |
| `Enter` | Go on. On a step with one choice (Role, Background, a hub's network) it picks the row first; ticked boxes stay as they are |
| `→` / `←` | Next or previous step |
| `Esc`, `Ctrl-C`, `q` | Quit without changing anything |

A mouse click chooses a row.

### The firewall on Windows

Windows Firewall lets nothing in to a program it hasn't been told about, and it counts VPNs such as NetBird as public networks. So when you tick *LAN* or *VPN* on Windows, setup from 0.17.1 adds a firewall rule named "Inyon link", and Windows asks an administrator to allow it. The rule lets in TCP on the link's port, to `inyon-engine.exe` only, from the local network and the VPN ranges (`100.64.0.0/10` and Tailscale's `fd7a:115c:a1e0::/48`).

If you say no, phones can only connect through the tunnel, and setup prints the command to add the rule later from PowerShell run as administrator. `inyon uninstall` removes the rule.

### Without the screens

With `--yes`, or without a terminal (as when piped from `curl`), setup takes flags and defaults instead of asking:

| Flag | Meaning |
|---|---|
| `-y`, `--yes` | Don't ask |
| `--role hub`, `node` or `join` | What this computer is. `node` pairs with your phone; `join` needs `--hub` |
| `--network <list>` | For a node: any of `tunnel`, `lan`, `vpn` and one `wss://` address, comma-separated. For a hub: `localhost`, `lan`, `vpn` or an address |
| `--port <n>` | The port to listen on |
| `--autostart`, `--no-autostart` | Install the background service, or not. A hub without it runs in the foreground |
| `--hub <url>` | The hub to join. The machine's token goes in `INYON_TOKEN` |

```sh
inyon setup --yes --role node --network tunnel,vpn
inyon setup --yes --role hub --network vpn
INYON_TOKEN=… inyon setup --yes --hub https://hub.example.ts.net
```

## Pairing phones

```sh
inyon pair
```

Shows the QR code, the one-time ID and 6-digit code, and the link. A code works once, for 10 minutes, and five wrong tries cancel it. Any link options you add are saved, the same ones `inyon link` takes:

| Option | Default | Meaning |
|---|---|---|
| `--tunnel`, `--no-tunnel` | On | Use a free Cloudflare quick tunnel |
| `--lan`, `--no-lan` | Off | Answer on the local network |
| `--vpn`, `--no-vpn` | On (off on Windows) | Answer on a private network's address |
| `--url <wss://…/link>` | | An address you publish yourself (repeatable); `--no-url` clears them |
| `--port <n>` | 4780 | The link's local port |

```sh
inyon phones                 # paired phones, with when each was last seen
inyon forget pixel           # unpair by name or key prefix
```

[Pairing a computer](computers.md) explains how the phone finds the computer and keeps the connection private.

## Hubs

```sh
inyon hub start              # install and start the hub service
inyon hub stop               # stop it and remove the service; its records stay
inyon hub restart
inyon hub code               # the setup code for the first sign-in
inyon hub reset-password     # asks for the new password without showing it, then restarts the hub
```

`hub start` waits until the hub answers, then prints its address and setup code. Hubs run on Linux and macOS. Plain `inyon hub` runs one in the foreground.

```sh
INYON_TOKEN=… inyon join https://hub.example.ts.net
inyon disconnect
```

`join` saves the hub's address and this machine's token (readable only by you), fetches the matching engine from the hub, and installs the `node` service. You rarely type it: the hub's *Add a machine* gives you a one-line command that does this. `disconnect` removes the service and the saved hub.

## Notifications to browsers

```sh
inyon push
```

Lists the browsers this computer sends alerts to directly, for [browser copies](browser-copy.md) of the app. `inyon push test` sends a test.

## The background service

```sh
inyon service status
inyon service install [link|node|hub]
inyon service uninstall [link|node|hub]
```

Without a role, `install` picks `node` if a hub is saved and `link` otherwise. [Install](install.md#the-background-service) has the details for each system.

## Logs

```sh
inyon logs                   # the last 50 lines
inyon logs -f                # follow
inyon logs --role hub -n 200
```

On Linux the service's output is in the systemd journal, and `inyon logs` reads it from there. Elsewhere it reads `~/.inyon/node/<role>.log`.

## Doctor

```sh
inyon doctor
```

Checks, one line each: the engine and the command, tmux (psmux on Windows), which agents are on the `PATH`, each service, leftovers from tether-node, the link's and the hub's ports, the private networks found, `cloudflared`, the clock and the last update. A line starting with `!` needs attention. With `--json`, `ok` is `false` when any check failed.

## Update and uninstall

```sh
inyon update
inyon update --background
inyon uninstall
inyon uninstall --purge
```

See [Updating](install.md#updating) and [Uninstalling](install.md#uninstalling).

## JSON output

`--json` makes every command answer one JSON object, for scripts. Success looks like `{"v":1,"ok":true,…}` and a failure like `{"v":1,"ok":false,"error":"…"}`, with exit code 1.

```sh
inyon status --json | jq '.phones[].name'
inyon pair --json | jq -r '.link'
```

## Environment

| Variable | Meaning |
|---|---|
| `INYON_TOKEN` | The machine's token when joining a hub |
| `INYON_DOWNLOAD` | Where to fetch releases from, instead of this site's copy of the newest one (`https://inyon.abhashchakraborty.tech/download`) |
| `INYON_ENGINE` | Use this `inyon-engine` instead of the installed one |
| `INYON_DATA_DIR` | Where a hub keeps its records (default `~/.inyon`) |
| `INYON_WEB_URL` | The web page pairing QR codes point to, for your own [browser copy](browser-copy.md) |
| `NO_COLOR` | Turn colour off |

Every `TETHER_*` name from before the rename is still read. [Configuration](configuration.md) lists the hub's settings.
