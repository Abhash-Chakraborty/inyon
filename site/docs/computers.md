---
title: Pairing a computer
nav: Paired computers
description: How a computer pairs with your phone, how the phone finds it from any network, and the options.
---

A paired computer runs `inyon` as a small background service and talks to your phone directly. There's no hub, no account and no open port. Pairing takes one command and one scan; see the [quick start](quick-start.md).

## Pairing

```sh
inyon pair
```

prints a QR code, an ID like `K7Q4-MX2T` with a 6-digit code, and a link. Scan the QR code in the app, or type the ID and code, or paste the link.

- A code pairs one phone, once, within 10 minutes.
- Five wrong typed codes cancel the typed code (the QR code still works until it expires).
- `inyon phones` lists paired phones by maker and model (such as *Nothing A142*) and when each was last seen; `inyon forget <name>` unpairs one at once. From 0.17, removing the computer in the app unpairs the phone on the computer too.

Pair as many phones as you like, and pair the same phone with as many computers as you like.

## How it stays private

- **Keys.** Each computer has an ed25519 key made on it, stored in `~/.inyon/node/identity.json` and readable only by you. Its public half is the computer's ID. Pairing tells the phone that key, and tells the computer the phone's.
- **The handshake.** Every connection starts with a Noise IK handshake (X25519, ChaCha20-Poly1305) between those two keys. Only a phone the computer has paired, or one holding a live pairing code, gets through. Everything after the handshake is encrypted end to end.
- **The tunnel.** A Cloudflare quick tunnel reaches only the computer's link port on `127.0.0.1`, and carries only ciphertext.
- **Addresses.** The computer publishes where it can be reached on [pkarr](https://pkarr.org), signed with its key, every 30 minutes. A record that isn't signed by that key is ignored.

[Security](security.md) covers the whole model.

## How the phone finds it

The computer can answer in several ways at once, and the phone races them:

| Way | Default | Option |
|---|---|---|
| Free Cloudflare quick tunnel | On | `--tunnel`, `--no-tunnel` |
| Private network: Tailscale, Headscale, NetBird, ZeroTier, WireGuard | On (off on Windows) | `--vpn`, `--no-vpn` |
| Local network | Off | `--lan`, `--no-lan` |
| An address you publish yourself | None | `--url wss://…/link` |

Pass options to `inyon pair`, or choose them in `inyon setup`; they're saved. The link listens on port 4780 (`--port` changes it). `cloudflared`, which runs the tunnel, is downloaded on first use into `~/.inyon/bin`, pinned to a known version and checked.

The tunnel works from any network but has no uptime promise: if Cloudflare's quick tunnels are slow, a private network is the steadier route. The private network is off by default on Windows, because Windows Firewall blocks it until a rule allows it. When you turn it on in `inyon setup`, setup adds that rule with an administrator's permission (see [The firewall on Windows](cli.md#the-firewall-on-windows)).

### Your own HTTPS address

To publish the link at an address of your own, such as through `tailscale serve`:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:4780
inyon pair --url wss://laptop.tail1234.ts.net:8443/link
inyon service install link    # restart the link with the new address
```

## Windows

On Windows, Inyon drives [psmux](https://github.com/marlocarlo/psmux), the native tmux for Windows. The machine's Setup tab installs it with winget. Everything works as on Linux, except that the terminal shows the current screen without scrollback.

psmux numbers panes per session, so every session has a pane `%1`. Before 0.17.1, two Claude Code sessions on one Windows machine shared the integration's files and the app lost their live model, context and limits. From 0.17.1 each session keeps its own; the app asks you to *Update* the integration once.

## Moving to a hub later

A paired computer can join a [hub](hub.md) instead: run the hub's *Add a machine* command on it. To stop pairing directly afterwards, `inyon service uninstall link` removes the link.
