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
| `TLS_CERT`, `TLS_KEY` | | PEM certificate and key files, to serve HTTPS directly. From 0.20 setup's *LAN* choice makes them (`~/.inyon/tls/`) |
| `INYON_ALLOWED_HOSTS` | | Extra host names the hub answers to, comma-separated. IPs, single-label names, localhost, `.ts.net`, NetBird names and home-network names (`.local`, `.lan`, `.internal`, `.home.arpa`) always work. `*` turns the check off |
| `INYON_ALLOWED_ORIGINS` | | Extra origins allowed to call the hub, comma-separated, for a reverse proxy on another hostname |
| `INYON_DATA_DIR` | `~/.inyon` | Where the hub keeps its records |
| `INYON_HUB_NAME` | the machine's name | The name phones show for this hub |
| `INYON_DOWNLOAD` | this version's release | Where the hub fetches the files it hands to joining machines. A mirror needs `SHA256SUMS.minisig` beside `SHA256SUMS`: from 0.20 the hub checks it with the release key first |
| `INYON_HUB_IMPL` | `bun` | `rust` runs the hub built into `inyon` instead of the Bun engine's, and the Bun engine isn't downloaded (from 0.20, an opt-in test). `bun` goes back, and so does `INYON_LEGACY_ENGINE=1`. See [Trying the hub in Rust](hub.md#trying-the-hub-in-rust) |
| `INYON_DEBUG` | | Any value turns on extra log lines from the chat watcher, for a bug report |

The host check guards against DNS rebinding: a web page on another site can't reach the hub by pointing a name at its address.

## Computer settings

These are read by `inyon` on any computer, and by `inyon-engine` where it runs.

| Variable | What it does |
|---|---|
| `INYON_TOKEN` | The machine's token when joining a hub |
| `INYON_HUB` | The hub to connect to (saved by `join`) |
| `INYON_JOINED` | Written by `inyon join` into `~/.inyon/node/env` with the version that joined (from 0.20). A machine whose file lacks it was added before 0.20, and keeps connecting to a hub on plain http, with a warning. See [Plain http](machines.md#plain-http) |
| `INYON_DOWNLOAD` | Where to fetch releases from, instead of this site's copy of the newest one (`https://inyon.tech/download`) |
| `INYON_ENGINE` | Use this `inyon-engine` instead of the installed one (for the hub, or with `INYON_LEGACY_ENGINE`). It has to be the Bun engine: `inyon` itself is refused |
| `INYON_LEGACY_ENGINE` | `1` runs the link and the hub connection on the Bun engine `inyon-engine`, as 0.18 does, instead of inside `inyon` (from 0.19). `inyon service install` writes it into the service and remembers it for commands started without it. See [Going back to the Bun engine](install.md#going-back-to-the-bun-engine) |
| `INYON_NO_SIGNATURE_CHECK` | Set to `1` before running `get.sh` or `get.ps1` to let them install without checking the checksum list's signature when minisign isn't installed (from 0.20; `get.sh` also takes `--no-signature-check`). See [Without minisign](install.md#without-minisign) |
| `INYON_NO_MODIFY_PATH` | Set to `1` before running `get.sh` or `get.ps1` to keep them from putting `inyon` on your `PATH` (from 0.17.1). See [Put inyon on your PATH](install.md#put-inyon-on-your-path) |
| `INYON_WEB_URL` | The page pairing QR codes open, for your own [browser copy](browser-copy.md) |
| `INYON_ALLOW_INSECURE` | Allow sending the machine's token to a hub over plain http on an address that isn't this machine's or a Tailscale or NetBird one, such as a LAN or ZeroTier address. From 0.20 it also lets `inyon update` take a hub's own checksums when the hub has no signed list, and `inyon join` writes it into `~/.inyon/node/env` when the address needed it, so the background connection keeps the choice. Avoid it |
| `INYON_HUB_CERT` | The SHA-256 of a hub's own certificate, which its **Add a machine** command sets (from 0.20). `inyon join` saves that certificate as `~/.inyon/node/hub.crt`, and from then on the connections to that hub accept that exact certificate. It's never trusted as an authority, for the hub or anything else |
| `NODE_EXTRA_CA_CERTS` | A PEM file of certificate authorities to trust as well as the usual ones, for a hub on a certificate from your organisation's own authority. The Bun engine always read it; from 0.19 `inyon` does too |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0` turns off the check of the hub's certificate. From 0.20.3 it applies only to the hub this machine joined, never to relays, push services or downloads, and the connection's log says so each time it starts. With the Bun engine (`INYON_LEGACY_ENGINE=1`) it still turns off every check, and the log warns about that. Prefer setup's [LAN](hub.md#the-lan) choice on the hub, whose certificate the **Add a machine** command pins |
| `INYON_THEME` | `light` or `dark`: the terminal's background, so the dashboard picks greys that read on it, instead of asking the terminal (from 0.20.2) |
| `NO_COLOR` | Turn colour off in the terminal |

Every `TETHER_*` name from before the rename is still read as its `INYON_*` twin.

## The link's options

A paired computer's link options are saved in `~/.inyon/node/link.json` whenever you pass them to `inyon pair` or choose them in `inyon setup`. See [Pairing a computer](computers.md#how-the-phone-finds-it).

## App settings

Display settings (theme, reply font, haptics…) are saved per device. Upload limits and session restarts are saved on the hub, or in the app for its own computers. [Settings](settings.md) lists them all.

## Files

| Path | What's there |
|---|---|
| `~/.inyon/bin/` | `inyon`, `cloudflared`, and `inyon-engine` on a hub. On Windows from 0.19 `inyon-engine.exe` is a copy of `inyon.exe` without a console, which runs the link and the hub connection; from 0.20.3 `inyon-app.exe` is another such copy, the Inyon app, which the Start menu and the logon task open, and `inyon.ico` is its icon |
| `~/.inyon/node/` | A computer's key, paired phones, link options, hub connection, logs, update status, `hub-impl` when the hub service was set up with `INYON_HUB_IMPL=rust` set in the shell, from 0.20 `hub.crt`, the certificate of a hub joined by its SHA-256, and on Windows from 0.20.3 the Inyon app's `app.json` (what it runs), `app.log` and `app-requests/` |
| `~/.inyon/hub.env` | An installed hub's settings |
| `~/.inyon/tls/` | From 0.20, the certificate and key setup makes for a hub on the LAN (`hub.crt`, `hub.key`) |
| `~/.inyon/` | A hub's records: password hash, machines, phones, settings, drafts, saved chats, offline snapshots |
| `~/.inyon/uploads/` | Files you attached, per day and session |
| `~/.inyon/upload-policy` | From 0.17, the upload rules the hub last used on this machine, so it can tidy by itself |
| `~/.inyon/setup-code` | A new hub's setup code, until the password is set |
| `~/.inyon/pages.json` | From 0.20, the pages on this machine: each one's slug, name, folder, project, who added it and when. `inyon pages add`, Blueprint and the app write it, and the hub reads it again whenever it changes. It stays in your home folder even with `INYON_DATA_DIR` set. It can be a symlink into your dotfiles: Inyon reads through the link and writes the file it leads to, so the link stays. A file over 4 MB counts as a list Inyon can't read |
| `~/.inyon/page-epochs.json` | From 0.20, a counter per page that revoking or removing it moves on, so older links stop working. It moves with `INYON_DATA_DIR` |
| `~/.inyon/page-listed.json` | From 0.20, the pages the hub saw in `pages.json` last time, so a page removed while the hub was stopped still has its old links ended. It moves with `INYON_DATA_DIR` |
| `<site>/.inyon-page.json` | From 0.20, a marker in a page's own folder with its name and slug, which the hub uses when the page is added. Names starting with a dot are never served |

Folders are readable only by you, and the files with keys or tokens only by you.

## Ports

| Port | What listens | Where |
|---|---|---|
| 4777 | A hub | `127.0.0.1` unless you choose a network |
| 4780 | A paired computer's link | `127.0.0.1`, plus each private network's address, plus every interface with LAN on |

A computer that joined a hub listens on nothing: it connects out. The Android app listens on nothing either.
