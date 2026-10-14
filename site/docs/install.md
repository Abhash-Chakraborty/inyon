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
6. Put `inyon` on your `PATH` (from 0.17.1), so a new terminal finds it by name. See [Put inyon on your PATH](#put-inyon-on-your-path).
7. Run `inyon setup`, which downloads and checks `inyon-engine`, installs the background service and prints the pairing QR code. With `--hub` it runs `inyon setup --role hub` and prints the hub's address and setup code instead.

Piped from `curl`, setup can't ask questions, so it takes the defaults: a computer that pairs with your phone through a free tunnel and your VPN, started at login. Run `inyon setup` again afterwards to choose differently with the [setup screens](cli.md#setup).

> **Note:** The terminal you installed from doesn't see the new `PATH` yet. Open a new one, or run `export PATH="$HOME/.inyon/bin:$PATH"` first. Until then the command is `~/.inyon/bin/inyon`.

### Installing from somewhere else

The installers download from this site's [/download](/download/), which holds the newest release. Without `gzip`, `get.sh` takes the uncompressed `inyon` from the same release on GitHub instead, checked against the same signed list. Installers from 0.14.0 and earlier download from GitHub.

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

From 0.17.1 the installers do this for you, once, when `~/.inyon/bin` isn't on your `PATH` already:

| Shell | What `get.sh` adds |
|---|---|
| zsh | a line in `~/.zshrc` (in `$ZDOTDIR` when that's set) |
| bash | a line in `~/.bashrc`, and on macOS in `~/.bash_profile` too |
| fish | the file `~/.config/fish/conf.d/inyon.fish` |
| anything else | a line in `~/.profile` |

Each line ends with `# added by Inyon`, and running the installer again doesn't add another. On Windows, `get.ps1` puts `%USERPROFILE%\.inyon\bin` on your user `Path`, and on the window you ran it in. `inyon uninstall` takes all of it back out, and nothing else in those files.

To leave your shell's files and `Path` alone, set `INYON_NO_MODIFY_PATH=1` before installing:

```sh
curl -fsSL https://inyon.abhashchakraborty.tech/get.sh | INYON_NO_MODIFY_PATH=1 sh
```

Then add it yourself, or run the command by its full path, `~/.inyon/bin/inyon`. With an installer from 0.17.0 or earlier, add it by hand:

```sh
echo 'export PATH="$HOME/.inyon/bin:$PATH"' >> ~/.zshrc    # or ~/.bashrc
```

```powershell
[Environment]::SetEnvironmentVariable("Path", "$env:USERPROFILE\.inyon\bin;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
```

npm puts `inyon` on your `PATH` itself, so the installers' line isn't needed there.

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

### On Windows

From 0.17.1 the task starts `inyon-engine.exe` itself. It has no console, so no window opens when you sign in, and its output goes to `%USERPROFILE%\.inyon\node\link.log` (`node.log` for a computer that joined a hub). An install from an earlier version moves to this the next time it updates.

While it runs, the Inyon icon sits in the notification area of the taskbar. Click it for a menu:

| Item | Does |
|---|---|
| Open Inyon | The status screen, in a terminal window |
| Pair a phone… | A pairing code, in a terminal window (computers paired with the phone) |
| Show the log | Opens the log file |
| Restart | Starts it again |
| Quit Inyon | Stops it until you next sign in. `inyon service install` starts it sooner |

If Windows hides the icon under the arrow beside the clock, drag it onto the taskbar to keep it in view.

## Updating

```sh
inyon update
```

It reads the newest version from this site's `latest.json` and checks that the release's `SHA256SUMS` carries a good signature from Inyon's release key and lists that version's APK. Then it downloads the new `inyon` and `inyon-engine`, checks both against that list, and only then swaps them in. Every running role restarts on the new version. If the new version doesn't stay up for a few seconds, the old files go back and the roles restart on them.

Versions after 0.14.0 update from this site; 0.14.0 and earlier from GitHub. A computer that joined a hub updates from the hub instead, so it always matches the hub's version. The hub can update it for you from its page under Machines. See [Updating hubs and machines](hub.md#updating).

`inyon update --background` does the same without keeping your terminal open, which is how the app and the hub start an update remotely.

If you installed the command with npm, update that copy with npm too. See [With npm](#with-npm).

## Uninstalling

```sh
inyon uninstall            # remove the services and the programs, keep pairings
inyon uninstall --purge    # also delete ~/.inyon: pairings, keys, a hub's records
```

From 0.17.1 both also take `inyon` back off your `PATH`: the lines marked `# added by Inyon`, Inyon's fish file, or the entry on the Windows user `Path`.

On Windows from 0.17.1, uninstalling first stops everything that runs from `~/.inyon/bin` (the engine, the tunnel and the tray icon), since Windows can't delete a program that's running. `inyon.exe` itself goes a moment after the command ends. If a file still can't be removed, it says which one. It also removes the firewall rule "Inyon link" when setup added one, which Windows asks an administrator to allow.

From 0.17, `--purge` first gives Claude Code and Antigravity their own status line back and drops Inyon's hooks from their settings, so they never call scripts that are gone. It also removes folders older versions left: `~/.tether`, `~/.tether-node` and `~/.cache/inyon-ssh`.

To stop being part of a hub but keep Inyon installed, use `inyon disconnect`. To unpair one phone, use `inyon forget <phone>`.

## Coming from tether-node

Inyon was called Tether before 0.7.0, and its computer program was `tether-node`. Run the installer again, because those versions updated from a release address that no longer exists. Nothing else needs redoing: its files move from `~/.tether-node` to `~/.inyon/node` (leaving a link behind) the first time the new program runs, and `inyon` moves the old service to its new name the next time it updates or sets the machine up. Settings named `TETHER_*` are still read as `INYON_*`.

Before 0.13, `inyon` was the Bun program itself. It's now the small Rust command, and the Bun program is `inyon-engine`. Two things changed for people who type it:

- Plain `inyon` now shows a [status dashboard](cli.md#status). Setup is `inyon setup`.
- `inyon install` and `inyon uninstall <role>` became `inyon service install` and `inyon service uninstall`. The old forms still work.
