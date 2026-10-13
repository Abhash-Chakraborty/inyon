---
title: Troubleshooting
description: What to check when a computer won't pair, a hub won't answer, or a session doesn't update.
---

Start with `inyon doctor` on the computer. It checks the engine, tmux, the agents, the service, the ports, the networks and the last update, one line each; a line starting with `!` is the problem. `inyon logs` shows what the service has been saying.

## inyon: command not found

The installers put it in `~/.inyon/bin` without adding that to your `PATH`. Run `~/.inyon/bin/inyon`, or [add it to your PATH](install.md#put-inyon-on-your-path).

## The phone won't pair with a computer

- **The code expired.** Codes last 10 minutes and work once. Run `inyon pair` for a fresh one.
- **Five wrong typed codes** cancel the typed code. Scan the QR code instead, or run `inyon pair` again.
- **The link isn't running.** `inyon service status` should show `link` running. If not, `inyon service install link`.
- **The tunnel can't start.** Some networks block Cloudflare's tunnel. `inyon doctor` shows whether `cloudflared` is there; `inyon logs` shows its errors. On a VPN, the phone can connect on the VPN's address instead.

## The phone can't reach a paired computer

The computer shows as connecting and never arrives.

- Check the computer is on and the service is running (`inyon service status`).
- Quick tunnels have no uptime promise. If Cloudflare is having a bad moment, a private network (Tailscale, NetBird, ZeroTier, WireGuard) is the steadier route; turn it on in `inyon setup`.
- On a VPN, make sure the phone is connected to it too.

## "Couldn't pair with the hub"

The app explains what it found:

- **It timed out.** The phone can't reach the hub's address. Is it on the hub's network (the VPN or the Wi-Fi)?
- **Failed to fetch** on a plain `http://` address: update the app to 0.13.3 or later, which allows plain addresses.
- Check that the address opens in the phone's browser. If it doesn't, the app can't reach it either.
- The code expired, was used, or was mistyped five times. Show a new one with **Open on your phone**.

## The hub won't open

- **From another device:** the hub listens only on its own machine until you choose a network. See [Reaching it from your phone](hub.md#reaching-it-from-your-phone).
- **"Refusing to serve plain http"** in the log, with a network `BIND`: set `TLS_CERT` and `TLS_KEY`, or `INYON_ALLOW_HTTP=1` on a VPN.
- **"This hub doesn't answer to that address"** under a domain name: add it to `INYON_ALLOWED_HOSTS`. Behind a proxy on another hostname, add the origin to `INYON_ALLOWED_ORIGINS`.
- **A port-forwarding rule** (say, port 80 to 4777) only applies to traffic arriving from other machines. Opening the name from the hub's own machine reaches whatever else listens on port 80 there.
- **Forgot the password:** `inyon hub reset-password`. **Lost the setup code:** `inyon hub code`.

## A machine shows as offline

- A joined machine: is it on, and is `inyon service status` showing `node` running? `inyon logs --role node` shows why it can't connect.
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
- A machine joined to a hub updates to the hub's version, so update the hub first.
- `cat ~/.inyon/node/update-status` shows the last background update's result, and `~/.inyon/node/update.log` its log.

## Still stuck

Open an issue on [GitHub](https://github.com/Abhash-Chakraborty/inyon/issues) with the output of `inyon doctor --json` and **Settings → About → Copy version details**. Leave out tokens, codes and addresses you don't want public.
