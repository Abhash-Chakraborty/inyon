---
title: Configuration
description: Every setting for a hub and for inyon, the files they live in, and the ports Inyon uses.
---

Most people never set anything by hand: `inyon setup` writes what it needs. This page lists everything you can set.

## Hub settings

An installed hub reads `~/.inyon/hub.env`, one `NAME=value` per line, and `inyon setup` writes it for you. Variables set in the environment win over the file. A hub run from source reads only the environment.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4777` | The port to listen on |
| `BIND` | `127.0.0.1` | The address to listen on. Anything but localhost needs `TLS_CERT` and `TLS_KEY`, or `INYON_ALLOW_HTTP=1`; otherwise the hub refuses to start |
| `INYON_ALLOW_HTTP` | | `1` serves plain http on a network address, for a VPN that encrypts on its own |
| `TLS_CERT`, `TLS_KEY` | | PEM certificate and key files, to serve HTTPS directly |
| `INYON_ALLOWED_HOSTS` | | Extra host names the hub answers to, comma-separated. IPs, single-label names, localhost, `.ts.net`, NetBird names and home-network names (`.local`, `.lan`, `.internal`, `.home.arpa`) always work. `*` turns the check off |
| `INYON_ALLOWED_ORIGINS` | | Extra origins allowed to call the hub, comma-separated, for a reverse proxy on another hostname |
| `INYON_DATA_DIR` | `~/.inyon` | Where the hub keeps its records |
| `INYON_HUB_NAME` | the machine's name | The name phones show for this hub |
| `INYON_DOWNLOAD` | this version's release | Where the hub fetches the files it hands to joining machines |

The host check guards against DNS rebinding: a web page on another site can't reach the hub by pointing a name at its address.

## Computer settings

These are read by `inyon` on any computer, and by `inyon-engine` where it runs.

| Variable | What it does |
|---|---|
| `INYON_TOKEN` | The machine's token when joining a hub |
| `INYON_HUB` | The hub to connect to (saved by `join`) |
| `INYON_DOWNLOAD` | Where to fetch releases from, instead of this site's copy of the newest one (`https://inyon.abhashchakraborty.tech/download`) |
| `INYON_ENGINE` | Use this `inyon-engine` instead of the installed one (for the hub, or with `INYON_LEGACY_ENGINE`). It has to be the Bun engine: `inyon` itself is refused |
| `INYON_LEGACY_ENGINE` | `1` runs the link and the hub connection on the Bun engine `inyon-engine`, as 0.18 does, instead of inside `inyon` (from 0.19). `inyon service install` writes it into the service. See [Going back to the Bun engine](install.md#going-back-to-the-bun-engine) |
| `INYON_NO_MODIFY_PATH` | Set to `1` before running `get.sh` or `get.ps1` to keep them from putting `inyon` on your `PATH` (from 0.17.1). See [Put inyon on your PATH](install.md#put-inyon-on-your-path) |
| `INYON_WEB_URL` | The page pairing QR codes open, for your own [browser copy](browser-copy.md) |
| `INYON_ALLOW_INSECURE` | Allow sending the machine's token to a hub over plain http on a public address. Don't |
| `NO_COLOR` | Turn colour off in the terminal |

Every `TETHER_*` name from before the rename is still read as its `INYON_*` twin.

## The link's options

A paired computer's link options are saved in `~/.inyon/node/link.json` whenever you pass them to `inyon pair` or choose them in `inyon setup`. See [Pairing a computer](computers.md#how-the-phone-finds-it).

## App settings

Display settings (theme, reply font, haptics…) are saved per device. Upload limits and session restarts are saved on the hub, or in the app for its own computers. [Settings](settings.md) lists them all.

## Files

| Path | What's there |
|---|---|
| `~/.inyon/bin/` | `inyon`, `cloudflared`, and `inyon-engine` on a hub. On Windows from 0.19 `inyon-engine.exe` is a copy of `inyon.exe` without a console, which the logon task starts |
| `~/.inyon/node/` | A computer's key, paired phones, link options, hub connection, logs, update status |
| `~/.inyon/hub.env` | An installed hub's settings |
| `~/.inyon/` | A hub's records: password hash, machines, phones, settings, drafts, saved chats, offline snapshots |
| `~/.inyon/uploads/` | Files you attached, per day and session |
| `~/.inyon/upload-policy` | From 0.17, the upload rules the hub last used on this machine, so it can tidy by itself |
| `~/.inyon/setup-code` | A new hub's setup code, until the password is set |

Folders are readable only by you, and the files with keys or tokens only by you.

## Ports

| Port | What listens | Where |
|---|---|---|
| 4777 | A hub | `127.0.0.1` unless you choose a network |
| 4780 | A paired computer's link | `127.0.0.1`, plus each private network's address, plus every interface with LAN on |

A computer that joined a hub listens on nothing: it connects out. The Android app listens on nothing either.
