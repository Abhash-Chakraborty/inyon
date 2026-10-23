---
title: Running a hub
nav: Running a hub
description: Install a hub, sign in, reach it from your phone over a private network or HTTPS, pair the app, and keep it updated.
---

A hub is one process on a machine that stays on, such as a home server, a VPS or a desktop that doesn't sleep. It serves the full web app to any browser, reaches your other machines, and sends notifications for all of them. With only the [Android app](android.md) you don't need one.

Hubs run on Linux and macOS. On Windows, run one in WSL.

## Install

```sh
curl -fsSL https://inyon.tech/get.sh | sh -s -- --hub
```

This installs `inyon`, runs `inyon setup --role hub`, and starts the hub as a user service that comes back after a reboot or a crash. It prints the address to open and a **setup code**.

On a computer that already has `inyon`, run `inyon setup` and choose *Make it a hub*, or just:

```sh
inyon hub start
```

### From source

You need [Bun](https://bun.sh) 1.3 or later, and tmux:

```sh
git clone https://github.com/Abhash-Chakraborty/inyon.git
cd inyon
bun install
bun run build
bun start
```

`deploy/inyon-hub.service` is a systemd user unit for a source install. A source install takes its settings from the environment; it doesn't read `~/.inyon/hub.env`.

A source install builds the engine it hands to machines from the checkout. For the `inyon` command it serves what `cargo` built into `apps/cli/dist`, if anything. Without that, Windows machines get the release's command from GitHub (from 0.17.1), and Linux and macOS machines get the engine, which also works as the command.

From 0.19 machines that join a hub take only the `inyon` command, which connects to the hub by itself. The hub still lists its engine for them, and a machine fetches it only with `INYON_LEGACY_ENGINE=1` set (see [Going back to the Bun engine](install.md#going-back-to-the-bun-engine)). The hub itself still runs on the Bun engine, unless you [try the hub in Rust](#trying-the-hub-in-rust).

## First sign-in

The hub listens on `127.0.0.1:4777`. Open it, and the first visit asks you to create a password (8 characters or more), using the setup code it printed. Lost the code? `inyon hub code` shows it again. From 0.20.3 the hub prints the code itself only in a terminal; in a log it prints where the code is kept, so another user who can read the log can't use it first.

- Sign-ins last 30 days and are renewed as you use the hub.
- Change the password in **Settings → Account**; that signs out your other browsers.
- Forgot it? `inyon hub reset-password` on the hub's machine sets a new one (it asks without showing what you type) and signs everyone out. A hub running as a service restarts to pick it up.
- Wrong passwords are slowed down and rate-limited, per address and in total.

## Reaching it from your phone

The hub listens only on its own machine until you choose otherwise, because anyone who reaches it can try your password, and it can run commands on every machine you add. Pick one way in:

### A private network

On Tailscale, Headscale, NetBird, ZeroTier or WireGuard, let the hub listen on that network's address. In `inyon setup`, choose the network under *Network*; setup writes it to `~/.inyon/hub.env`. On a Tailscale or NetBird address:

```sh
BIND=100.64.0.5
INYON_ALLOW_HTTP=1
```

`INYON_ALLOW_HTTP=1` allows plain `http://` on that address, which is fine on a VPN that already encrypts. Then open `http://<machine>:4777` from any device on the network. On a ZeroTier or WireGuard address, which machines can't tell apart from a LAN, setup makes a certificate as it does for [the LAN](#the-lan) (from 0.20), and the hub answers on `https://`. Names on Tailscale (`.ts.net`), NetBird and common home networks (`.local`, `.lan`, `.internal`, `.home.arpa`) are accepted automatically.

From 0.20 a machine sends its token over plain `http://` only to a Tailscale or NetBird address (`100.64.0.0/10`, or Tailscale's `fd7a:115c:a1e0::/48`), or to a name that points only there, such as the machine's `.ts.net` name. From 0.20.2 a NetBird name that also has an IPv6 address passes: NetBird picks that address at random per network, in a unique-local range (`fd…`), so it's accepted next to the name's `100.x` address, though never alone. On ZeroTier or WireGuard, whose addresses look like any LAN to the machine, setup gives the hub HTTPS, and the **Add a machine** command carries its certificate's SHA-256. See [Adding machines](machines.md#plain-http).

### HTTPS

HTTPS is needed for the web app installed to a phone's home screen, for notifications in a browser and for pasting images. Any of these gives you it:

- **`tailscale serve`**, where your tailnet has HTTPS: `tailscale serve --bg 4777`, then open `https://<machine>.<tailnet>.ts.net`.
- **`netbird expose`**, for a public HTTPS address through NetBird's proxy.
- **A reverse proxy** such as Caddy in front of `127.0.0.1:4777`. Add your domain to `INYON_ALLOWED_HOSTS`.
- **Its own certificate**: set `TLS_CERT` and `TLS_KEY` to PEM files. Setup makes one for the [LAN](#the-lan).

> **Warning:** Don't open port 4777 to the internet without HTTPS. Over plain HTTP your password crosses the network readable.

### The LAN

Choose *LAN* in setup (`BIND=0.0.0.0`) to answer on every interface of a home network. Anyone on that network can listen in, so from 0.20 the hub serves HTTPS there, never plain http. Setup makes a certificate for the machine's name (`name` and `name.local`), `localhost`, its addresses and the address you told the hub to listen on, saves it as `~/.inyon/tls/hub.crt` and `hub.key` (readable only by you), points `TLS_CERT` and `TLS_KEY` at them and removes an `INYON_ALLOW_HTTP=1` an earlier setup wrote. It prints the certificate's SHA-256 fingerprint:

```
✓ HTTPS, on a certificate made for this machine. The browser warns about it once; check that its SHA-256 fingerprint is
  3F:A1:…:9C
```

No authority vouches for that certificate, so the browser warns the first time. Open the certificate from the warning, compare its SHA-256 fingerprint with the one setup printed, and only then go on. A certificate you set in `TLS_CERT` yourself is kept, and so is setup's own when you run setup again, so the machines added with it keep working. To make a new one, for example after the machine's address changed, delete `~/.inyon/tls` and run setup again; then add the machines again.

The hub puts the certificate's SHA-256 into every **Add a machine** command (from 0.20), and the machine accepts exactly that certificate from the hub's address, and never as an authority for anything else. The Windows command can't check it yet: add a Windows machine through a VPN address, or give the hub a certificate Windows trusts. The Android app doesn't accept a certificate like this yet either, so on the LAN it connects through a VPN address or `tailscale serve`.

Before 0.20, choosing *LAN* served plain http and wrote `INYON_ALLOW_HTTP=1`. Prefer a VPN if the network isn't yours alone.

## Pair the Android app

Once you're signed in, **Open on your phone** shows a QR code and a typed code. It's on the overview until a phone is paired, under Machines, and in **Settings → Paired devices**. In the app, tap **Add a computer**, then **Connect to a hub**, and scan it or type the hub's address and the code.

- Only someone who signed in within the last 10 minutes can show a code, so an old tab asks for the password first.
- A code works once, for 10 minutes; five wrong tries cancel it.
- From 0.20.2 the code's panel also shows the **Hub ID**, and the **Certificate** when the hub serves HTTPS itself. The app shows the same before it pairs; check they match.
- The phone gets a token of its own. **Settings → Paired devices** lists paired phones; **Forget** cuts one off at once.

The phone has to reach the hub's address the same way a browser does. Over plain http that means a Tailscale or NetBird address, or a name that points to one; see [Connect to a hub](android.md#connect-to-a-hub).

## Pair a companion app

From 0.20 an app like Legato can pair too, with **Settings → Paired devices → Pair a companion app** or `inyon hub companion-code` on the hub's computer. It types a six-character code that works once, for 5 minutes, and gets four permissions: the overview, chats, answering a question and sending text. From 0.20.2 **Copy pairing link** puts the address, the code and the certificate's fingerprint in one string, for an app that takes a pasted link. See [Companion apps](companions.md).

## Adding machines

The hub reaches its own machine directly. Add the others from **Machines → Add machine**; see [Adding machines](machines.md).

## Updating

Nothing updates by itself. When a release is out, Settings shows **Update available**.

- **An installed hub** updates with **Update** in Settings, or `inyon update` on its machine. It downloads the release, checks it against the signed `SHA256SUMS`, swaps it in and restarts. If the new version doesn't start, it goes back to the old one.
- **A hub run from source** updates with **Update**, or `bun hub:update` in the checkout. It refuses local changes or a branch that can't fast-forward; otherwise it pulls, installs, builds and restarts the `inyon-hub` user unit. There's no automatic rollback.

After an update, browsers that have the app open offer **Reload**. Machines that joined the hub update from their pages under Machines.

## Running it

```sh
inyon hub restart
inyon hub stop               # stops it and removes the service; its records stay
inyon logs --role hub -f
```

The hub keeps its records in `~/.inyon` (or `INYON_DATA_DIR`): the password hash, machines, paired phones, settings, drafts, and the last state of each offline machine. [Configuration](configuration.md) lists every setting.

## Pages

From 0.20 the hub also serves the sites your agents make on its machine, such as Blueprint plans, at `/v/<link>/` on its own port. Pages are listed in `~/.inyon/pages.json`. Each link is signed, opens one page for 12 hours and needs no cookie, so a reverse proxy in front of the hub has to pass `/v/` through as it does everything else. [Security](security.md#pages) says how a page is kept away from your sign-in.

## Trying the hub in Rust

From 0.20 `inyon` carries a second hub, written in Rust, that will replace the Bun one. It's off until you turn it on, so you can test it first. It answers the web app, the Android app and joining machines as the Bun hub does, from the same records in `~/.inyon`: your password, phones and machines carry over both ways. It runs on Linux and macOS.

Turn it on in the hub's settings file and restart:

```sh
echo INYON_HUB_IMPL=rust >> ~/.inyon/hub.env
inyon hub restart
inyon doctor                 # hub engine   the Rust hub, built in (INYON_HUB_IMPL=rust)
```

With it on, `inyon` doesn't download the Bun engine (`inyon-engine`), and `inyon hub code` and `inyon hub reset-password` work as before. `INYON_HUB_IMPL=rust inyon hub start` turns it on too, and the service keeps it after that, even when you set up the link or a node later. A line in `hub.env` comes first, so while it says otherwise `inyon hub start` refuses and asks you to change it.

To go back, delete the line from `hub.env` and run `inyon hub restart`, which fetches the Bun engine first if it isn't there. If you turned it on from the shell with `inyon hub start`, the service remembers that, so deleting the line isn't enough: put `INYON_HUB_IMPL=bun` in `hub.env` and run `inyon hub restart`, or run `inyon service install hub` without the variable set. Either way the Bun engine is fetched before the hub restarts, so a failed download shows up in your terminal. `INYON_LEGACY_ENGINE=1` also puts the hub back on Bun, whatever `INYON_HUB_IMPL` says, and `inyon doctor` tells you so. A hub run from source with `bun hub` isn't affected.
