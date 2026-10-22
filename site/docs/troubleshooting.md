---
title: Troubleshooting
description: What to check when a computer won't pair, a hub won't answer, or a session doesn't update.
---

Start with `inyon doctor` on the computer. It checks the engine, tmux, the agents, the service, the ports, the networks and the last update, one line each; a line starting with `!` is the problem. `inyon logs` shows what the service has been saying.

## inyon: command not found

The installers put it in `~/.inyon/bin`. From 0.17.1 they add that to your `PATH` too, but only new terminals see it: open one, or run `~/.inyon/bin/inyon`. With an older installer or `INYON_NO_MODIFY_PATH=1`, [add it to your PATH](install.md#put-inyon-on-your-path).

## Something stopped working after updating to 0.19

From 0.19 the link and the hub connection run inside `inyon` rather than in the Bun engine. If a computer did something in 0.18 that it doesn't in 0.19, set `INYON_LEGACY_ENGINE=1` and run `inyon service install` to go back to the Bun engine while it gets fixed. On Linux and macOS that writes the variable into the service, and the Bun engine downloads when the service starts; on Windows `inyon service install` downloads it. [Going back to the Bun engine](install.md#going-back-to-the-bun-engine) has the steps for each system, and `inyon doctor` shows which engine runs. Please [open an issue](https://github.com/Abhash-Chakraborty/inyon/issues) with what broke.

## The phone reached the computer once, then couldn't

Before 0.17.2, `inyon pair` on Windows could miss the link already running in the background and start a second one. The second one published its own address, and when it ended with the terminal, the phone was left pointing at it. Update both sides; from 0.17.2 `pair` sees a running link by its port too. Until then, `inyon service install link` restarts the background link, which publishes the right address again.

## The tray menu opens an empty window (Windows)

In 0.17.1, **Open Inyon** and **Pair a phone…** in the tray menu opened a window that closed at once. Run `inyon` or `inyon pair` in a terminal instead, or update to 0.17.2.

## Inyon isn't in Settings → Apps (Windows)

Setup and `inyon update` list it there from 0.17.2. An install from 0.17.1 appears after its next `inyon update` or `inyon setup`. `inyon uninstall --purge` works either way.

## The phone won't pair with a computer

- **The code expired.** Codes last 10 minutes and work once. Run `inyon pair` for a fresh one.
- **Five wrong typed codes** cancel the typed code. Scan the QR code instead, or run `inyon pair` again.
- **The link isn't running.** `inyon service status` should show `link` running. If not, `inyon service install link`.
- **"Busy saving its files".** The computer was in the middle of writing its pairings, from `inyon pair` or `inyon forget` in another window, and the phone doesn't wait more than a second for that. Try again. If it keeps saying so, a stuck `inyon` process is holding the lock on `~/.inyon/node/files.lock`: `inyon service install link` restarts the link, and ending the stuck process frees it. From 0.20 the lock goes away by itself the moment the process holding it ends, however it ended.
- **The tunnel can't start.** Some networks block Cloudflare's tunnel. `inyon doctor` shows whether `cloudflared` is there; `inyon logs` shows its errors. On a VPN, the phone can connect on the VPN's address instead.
- **The code had no address (0.19.0).** `inyon pair` could show a code before the tunnel was up, most often the first time, while it downloaded `cloudflared` (a download that could hang for minutes on an unreachable GitHub address). The phone then said it couldn't find the computer online. From 0.20 downloads give up on a dead address after a few seconds and try the next, setup fetches `cloudflared` ahead of time, and `inyon pair` waits for the tunnel. On 0.19.0, wait a minute and run `inyon pair` again.

## The phone can't reach a paired computer

The computer shows as connecting and never arrives.

- Check the computer is on and the service is running (`inyon service status`).
- Quick tunnels have no uptime promise. If Cloudflare is having a bad moment, a private network (Tailscale, NetBird, ZeroTier, WireGuard) is the steadier route; turn it on in `inyon setup`.
- On a VPN, make sure the phone is connected to it too.
- On Windows, the firewall blocks the LAN and the VPN unless the rule "Inyon link" is there, and both are off by default, so the computer is reachable only through the tunnel. From 0.20 `inyon doctor` says so on its `reach` line. Run `inyon setup` again with *LAN* or *VPN* ticked and allow it when Windows asks, or see [The firewall on Windows](cli.md#the-firewall-on-windows).
- On Windows in 0.19, **Quit Inyon** left the tunnel's `cloudflared` running, and `inyon status` still listed the tunnel's address after the link had stopped. From 0.20 Quit stops the tunnel too, and status lists addresses only while the link runs. On 0.19, **Restart** from the tray menu starts the link and a fresh tunnel.

## "Couldn't pair with the hub"

The app explains what it found:

- **It timed out.** The phone can't reach the hub's address. Is it on the hub's network (the VPN or the Wi-Fi)?
- **Failed to fetch** on a plain `http://` address: update the app to 0.13.3 or later, which allows plain addresses.
- Check that the address opens in the phone's browser. If it doesn't, the app can't reach it either.
- The code expired, was used, or was mistyped five times. Show a new one with **Open on your phone**.

## The hub won't open

- **From another device:** the hub listens only on its own machine until you choose a network. See [Reaching it from your phone](hub.md#reaching-it-from-your-phone).
- **"Refusing to serve plain http"** in the log, with a network `BIND`: set `TLS_CERT` and `TLS_KEY`, or `INYON_ALLOW_HTTP=1` on a VPN. For the LAN, run `inyon setup` and choose *LAN*, which makes a certificate.
- **"Refusing to send the token over plain http"** on a machine: from 0.20 plain http only goes to a Tailscale or NetBird address. A machine added before 0.20 still connects and warns with **"Sending the token over plain http"** instead. See [Plain http](machines.md#plain-http).
- **"doesn't hand out Inyon's signed list of checksums"** from `inyon update` on a machine: update the hub first. See [Security](security.md#downloads).
- **"couldn't hand out Inyon's signed list of checksums"** from `inyon update` on a machine: the hub couldn't fetch its release's list from GitHub, or the list it got isn't the one for its version. The hub's log says which. Try again later; the machine changes nothing meanwhile.
- **"This hub doesn't answer to that address"** under a domain name: add it to `INYON_ALLOWED_HOSTS`. Behind a proxy on another hostname, add the origin to `INYON_ALLOWED_ORIGINS`.
- **A port-forwarding rule** (say, port 80 to 4777) only applies to traffic arriving from other machines. Opening the name from the hub's own machine reaches whatever else listens on port 80 there.
- **Forgot the password:** `inyon hub reset-password`. **Lost the setup code:** `inyon hub code`.

## A machine shows as offline

- A joined machine: is it on, and is `inyon service status` showing `node` running? `inyon logs --role node` shows why it can't connect.
- The log says the hub's certificate isn't trusted, and the hub's certificate comes from your organisation's own authority: put that authority's certificate in a PEM file and set `NODE_EXTRA_CA_CERTS` to its path, for the service too (see [Computer settings](configuration.md#computer-settings)).
- The hub removed it, or its pairing command expired unused (after 24 hours): use **New pairing command** on its page.
- An SSH server: check you can `ssh` to it from the hub's machine as the hub's user, without a password prompt.

## A session doesn't appear

- Inyon shows agents running in **tmux**. An agent started outside tmux isn't visible.
- The machine's **Setup** tab shows whether tmux and the agent are found.
- Give it a few seconds; machines are checked every few seconds.

## Messages stay on "Sending"

- The machine may be offline or reconnecting; the chat says so. Messages that failed because the connection dropped are sent again when it's back.
- The agent may be showing a prompt. While a question is open, answer it first.
- Open the terminal view to see what the agent is doing.

## Live numbers stopped updating

For Claude Code, the numbers come from the integration. Turn it on, or **Update** it, from the machine's **Integration** tab. A session that stops reporting offers **Reconnect** or **Restart**; Settings → **Restart sessions that stop reporting** does it by itself.

## Notifications don't arrive

- **Android:** keep **Stay connected** on and allow the app to run without battery limits. A fully closed app gets no alerts yet.
- **Browser:** the hub must be on HTTPS, and on iPhone the page must be on the Home Screen. Use **Send a test** in Settings.

## Updates

- `inyon update` says nothing changed but you expected a new version: it compares against the latest release; check the [changelog](changelog.md).
- **"The release's signed checksum list isn't the one for Inyon …"**: the site was between two releases. Nothing was changed; try again in a few minutes.
- A machine joined to a hub updates to the hub's version, so update the hub first.
- A hub run from source says **Building the web app failed**, and `~/.inyon/hub-update.log` ends in `Unknown file extension ".ts"`: that hub is from before 16 October 2026 and built the app with whatever Node.js its service found. Run `git pull` and then `bun hub:update` in the checkout once; from then on the build runs on Bun alone.
- `cat ~/.inyon/node/update-status` shows the last background update's result, and `~/.inyon/node/update.log` its log.

## Still stuck

Open an issue on [GitHub](https://github.com/Abhash-Chakraborty/inyon/issues) with the output of `inyon doctor --json` and **Settings → About → Copy version details**. Leave out tokens, codes and addresses you don't want public.
