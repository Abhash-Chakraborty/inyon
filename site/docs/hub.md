---
title: Running a hub
nav: Running a hub
description: Install a hub, sign in, reach it from your phone over a private network or HTTPS, pair the app, and keep it updated.
---

A hub is one process on a machine that stays on, such as a home server, a VPS or a desktop that doesn't sleep. It serves the full web app to any browser, reaches your other machines, and sends notifications for all of them. With only the [Android app](android.md) you don't need one.

Hubs run on Linux and macOS. On Windows, run one in WSL.

## Install

```sh
curl -fsSL https://inyon.abhashchakraborty.tech/get.sh | sh -s -- --hub
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

## First sign-in

The hub listens on `127.0.0.1:4777`. Open it, and the first visit asks you to create a password (8 characters or more), using the setup code it printed. Lost the code? `inyon hub code` shows it again.

- Sign-ins last 30 days and are renewed as you use the hub.
- Change the password in **Settings → Account**; that signs out your other browsers.
- Forgot it? `inyon hub reset-password` on the hub's machine sets a new one (it asks without showing what you type) and signs everyone out. A hub running as a service restarts to pick it up.
- Wrong passwords are slowed down and rate-limited, per address and in total.

## Reaching it from your phone

The hub listens only on its own machine until you choose otherwise, because anyone who reaches it can try your password, and it can run commands on every machine you add. Pick one way in:

### A private network

On Tailscale, Headscale, NetBird, ZeroTier or WireGuard, let the hub listen on that network's address. In `inyon setup`, choose the network under *Network*; setup writes it to `~/.inyon/hub.env`:

```sh
BIND=100.64.0.5
INYON_ALLOW_HTTP=1
```

`INYON_ALLOW_HTTP=1` allows plain `http://` on that address, which is fine on a VPN that already encrypts. Then open `http://<machine>:4777` from any device on the network. Names on Tailscale (`.ts.net`), NetBird and common home networks (`.local`, `.lan`, `.home.arpa`) are accepted automatically.

### HTTPS

HTTPS is needed for the web app installed to a phone's home screen, for notifications in a browser and for pasting images. Any of these gives you it:

- **`tailscale serve`**, where your tailnet has HTTPS: `tailscale serve --bg 4777`, then open `https://<machine>.<tailnet>.ts.net`.
- **`netbird expose`**, for a public HTTPS address through NetBird's proxy.
- **A reverse proxy** such as Caddy in front of `127.0.0.1:4777`. Add your domain to `INYON_ALLOWED_HOSTS`.
- **Its own certificate**: set `TLS_CERT` and `TLS_KEY` to PEM files.

> **Warning:** Don't open port 4777 to the internet without HTTPS. Over plain HTTP your password crosses the network readable.

### The LAN

Choose *LAN* in setup (`BIND=0.0.0.0`) to answer on every interface of a home network. Prefer a VPN if the network isn't yours alone.

## Pair the Android app

Once you're signed in, **Open on your phone** shows a QR code and a typed code. It's on the overview until a phone is paired, under Machines, and in **Settings → Other devices**. In the app, tap **Add a computer**, then **Connect to a hub**, and scan it or type the hub's address and the code.

- Only someone who signed in within the last 10 minutes can show a code, so an old tab asks for the password first.
- A code works once, for 10 minutes; five wrong tries cancel it.
- The phone gets a token of its own. **Settings → Other devices** lists paired phones; **Forget** cuts one off at once.

The phone has to reach the hub's address the same way a browser does.

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
