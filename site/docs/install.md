---
title: Install
description: How to install Inyon with the one-line installers or npm, where it lives on a computer, and how to update or remove it.
---

Every computer that runs agents for you gets two programs. `inyon` is a small command (about 2 MB, written in Rust) that sets things up, shows status and keeps everything updated. `inyon-engine` does the work behind it: the link to your phone, the connection to a hub, or the hub itself. You only ever type `inyon`.

## The one-line installers

On macOS or Linux:

```sh
curl -fsSL https://inyon.abhashchakraborty.tech/get.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://inyon.abhashchakraborty.tech/get.ps1 | iex
```

To make the computer a [hub](hub.md) instead (Linux and macOS):

```sh
curl -fsSL https://inyon.abhashchakraborty.tech/get.sh | sh -s -- --hub
```

### What they do

1. Work out the system and processor: Linux or macOS on x64 or arm64, Windows on x64 or arm64. Anything else stops with a message. On Alpine and other musl systems, `get.sh` picks the engine built for musl.
2. Download the release's `SHA256SUMS`. When [minisign](https://jedisct1.github.io/minisign/) is installed, check that list's signature against Inyon's release key and stop if it doesn't match. Without minisign the installers say so and carry on; `inyon` itself always checks the signature from then on.
3. Download the `inyon` command for this system, compressed when `gzip` is available, and check it against `SHA256SUMS`, both compressed and unpacked. A mismatch stops the install before anything runs.
4. Put it in `~/.inyon/bin/inyon` (`%USERPROFILE%\.inyon\bin\inyon.exe` on Windows). On macOS it gets an ad-hoc signature so the system will run it.
5. On Alpine, add `libstdc++` and `libgcc` with `apk` when running as root (the musl engine needs them), or say how to.
6. Run `inyon setup`, which downloads and checks `inyon-engine`, installs the background service and prints the pairing QR code. With `--hub` it runs `inyon setup --role hub` and prints the hub's address and setup code instead.

Piped from `curl`, setup can't ask questions, so it takes the defaults: a computer that pairs with your phone through a free tunnel and your VPN, started at login. Run `inyon setup` again afterwards to choose differently with the [setup screens](cli.md#setup).

> **Note:** The installers don't add `~/.inyon/bin` to your `PATH`. Until you do, run the command by its full path, `~/.inyon/bin/inyon`. See [Put inyon on your PATH](#put-inyon-on-your-path).

### Installing from somewhere else

The installers download from `dl.abhashchakraborty.tech`, which holds every file of the newest release (the links on the [download page](/download/) point there too). Without `gzip`, `get.sh` takes the uncompressed `inyon`, checked against the same signed list. Installers from 0.14.1 to 0.17.0 download from this site's `/download`, which still keeps the files they need, and those from 0.14.0 and earlier from GitHub.

Both read `INYON_DOWNLOAD`, a folder URL to fetch from instead. Every release stays on GitHub, so point it at one to pin a version:

```sh
curl -fsSL https://inyon.abhashchakraborty.tech/get.sh | INYON_DOWNLOAD=https://github.com/Abhash-Chakraborty/inyon/releases/download/v0.17.0 sh
```

## With npm

From 0.17.0 the `inyon` command is also on npm, for any system above with Node.js 18 or later:

```sh
npm install -g @abhash-chakraborty/inyon
inyon setup
```

npm installs only the `inyon` command and puts it on your `PATH`. It picks the build for your system from the packages `@abhash-chakraborty/inyon-<platform>-<arch>`, which hold the same files as the release. Nothing runs at install time, so `--ignore-scripts` works. `inyon setup` then downloads and checks the engine like the installers do, and copies `inyon` into `~/.inyon/bin`, so the background service doesn't depend on npm's folder.

- **Update the command** with `npm install -g @abhash-chakraborty/inyon@latest`. From 0.17.1, `inyon update` run from npm's copy updates `~/.inyon/bin`, which the service runs, and leaves npm's copy to npm.
- **Remove it** with `inyon uninstall` first, then `npm uninstall -g @abhash-chakraborty/inyon`.
- **Check it** with `npm audit signatures` after installing. Every release from 0.17.0 is published by the release workflow on GitHub with a provenance statement, and the [npm page](https://www.npmjs.com/package/@abhash-chakraborty/inyon) links to the run that built it.

## Supported systems

| System | `inyon` | `inyon-engine` | Can be a hub |
|---|---|---|---|
| Linux x64, arm64 | Yes | Yes | Yes |
| Alpine and other musl Linux, x64, arm64 | The same static build | Built for musl; needs `apk add libstdc++ libgcc` | Untested |
| macOS Apple silicon, Intel | Yes | Yes | Yes |
| Windows x64 | Yes | Yes | No (use WSL) |
| Windows arm64 | Yes | Runs the x64 engine | No |

Every computer also needs tmux, or [psmux](https://github.com/marlocarlo/psmux) on Windows. The setup tab in the app can install it, and the agents, for you. See [Computers](computers.md#windows).

## Put inyon on your PATH

On Linux or macOS with bash or zsh:

```sh
echo 'export PATH="$HOME/.inyon/bin:$PATH"' >> ~/.zshrc    # or ~/.bashrc
```

Open a new terminal and `inyon` works from anywhere. On Windows, in PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("Path", "$env:USERPROFILE\.inyon\bin;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
```

## Where things live

| Path | What it holds |
|---|---|
| `~/.inyon/bin/` | `inyon`, `inyon-engine`, and `cloudflared` once a tunnel is first used |
| `~/.inyon/node/` | This computer's identity key, paired phones, link settings, hub connection, logs (only you can read it) |
| `~/.inyon/` | A hub's own records: password hash, machines, settings, `hub.env` |

`INYON_DATA_DIR` moves the hub's records elsewhere. The [Configuration](configuration.md) page lists every setting.

## The background service

Setup runs Inyon as a service of your own user, so it starts on its own and comes back after a crash. It never needs `sudo`.

| System | How it runs | Starts at | After a crash |
|---|---|---|---|
| Linux | systemd user unit `inyon-link`, `inyon-node` or `inyon-hub` | Boot (lingering is turned on) | Restarts after 5 s |
| macOS | LaunchAgent `tech.abhashchakraborty.inyon.<role>` | Login | Restarts |
| Windows | Scheduled task "Inyon link" or "Inyon node" | Login | Retried every minute |
| Linux without user systemd | A background process, plus an `@reboot` cron line | Boot, when cron exists | No |

The role is `link` for a computer paired with your phone, `node` for one that joined a hub, and `hub` for a hub. `inyon service status` shows what's installed and running, and `inyon logs` shows its output.

## Updating

```sh
inyon update
```

It reads the newest version from `latest.json` on `dl.abhashchakraborty.tech` and checks that the release's `SHA256SUMS` carries a good signature from Inyon's release key and lists that version's APK. Then it downloads the new `inyon` and `inyon-engine`, checks both against that list, and only then swaps them in. Every running role restarts on the new version. If the new version doesn't stay up for a few seconds, the old files go back and the roles restart on them.

From 0.17.1 it updates from `dl.abhashchakraborty.tech`. Versions 0.14.1 to 0.17.0 update from this site's `/download`, and 0.14.0 and earlier from GitHub. A computer that joined a hub updates from the hub instead, so it always matches the hub's version. The hub can update it for you from its page under Machines. See [Updating hubs and machines](hub.md#updating).

`inyon update --background` does the same without keeping your terminal open, which is how the app and the hub start an update remotely.

If you installed the command with npm, update that copy with npm too. See [With npm](#with-npm).

## Uninstalling

```sh
inyon uninstall            # remove the services and the programs, keep pairings
inyon uninstall --purge    # also delete ~/.inyon: pairings, keys, a hub's records
```

From 0.17, `--purge` first gives Claude Code and Antigravity their own status line back and drops Inyon's hooks from their settings, so they never call scripts that are gone. It also removes folders older versions left: `~/.tether`, `~/.tether-node` and `~/.cache/inyon-ssh`.

To stop being part of a hub but keep Inyon installed, use `inyon disconnect`. To unpair one phone, use `inyon forget <phone>`.

## Coming from tether-node

Inyon was called Tether before 0.7.0, and its computer program was `tether-node`. Run the installer again, because those versions updated from a release address that no longer exists. Nothing else needs redoing: its files move from `~/.tether-node` to `~/.inyon/node` (leaving a link behind) the first time the new program runs, and `inyon` moves the old service to its new name the next time it updates or sets the machine up. Settings named `TETHER_*` are still read as `INYON_*`.

Before 0.13, `inyon` was the Bun program itself. It's now the small Rust command, and the Bun program is `inyon-engine`. Two things changed for people who type it:

- Plain `inyon` now shows a [status dashboard](cli.md#status). Setup is `inyon setup`.
- `inyon install` and `inyon uninstall <role>` became `inyon service install` and `inyon service uninstall`. The old forms still work.
