# Running a hub

A hub lets you use Inyon from any browser, and gives you one place that reaches all your machines.
It's one Bun process on a machine that stays on, such as a home server, a VPS or a desktop that
doesn't sleep. It serves the web app itself, so there's nothing to deploy anywhere else. With only
the [Android app](android.md) you don't need one.

## Install

On Linux or macOS, this installs it and keeps it running as a user service:

```sh
curl -fsSL https://inyon.abhashchakraborty.tech/get.sh | sh -s -- --hub
```

It prints the address to open and a setup code. Settings like `PORT`, `BIND` or `TLS_CERT` go in
`~/.inyon/hub.env`, one `NAME=value` per line.

To run it from source you need [Bun](https://bun.sh) 1.3+ and tmux:

```sh
git clone https://github.com/Abhash-Chakraborty/inyon.git
cd inyon
bun install
bun run build
bun start
```

`deploy/inyon-hub.service` keeps a source install running.

## First sign-in

The hub listens on `127.0.0.1:4777`. The first visit asks you to create a password, using the
setup code the hub prints when it starts; `inyon hub code` shows it again. Change the password
later in Settings, or choose a new one for a forgotten one with `inyon hub reset-password`.

## Reaching it from your phone

Use a private network (Tailscale, Headscale, NetBird, ZeroTier, WireGuard or your LAN), or put it
behind an HTTPS reverse proxy. `inyon hub install` looks for these networks and prints what to run
for each: `tailscale serve` where the tailnet has HTTPS, `netbird expose` for a public HTTPS
address through NetBird's proxy, and otherwise `BIND` on the network's address. Behind a proxy on
a public domain, add that domain to `INYON_ALLOWED_HOSTS`.

- In a browser, the hub's address is the app: `http://my-server:4777` over Tailscale or NetBird,
  or `https://inyon.example.com` behind a reverse proxy.
- Installed on a phone from the browser, with system notifications, it needs HTTPS. Use Caddy or
  `tailscale serve`, or set `TLS_CERT` and `TLS_KEY`. The hub then sends Web Push itself, so
  alerts reach a closed tab or installed app, for every agent and for machines going offline.
- Other machines host nothing. They run tmux and your agents, and join the hub as described in
  [Adding machines](machines.md).
- The Android app can pair with the hub and reach it itself, with no browser in between. See
  [Pair the app with the hub](#pair-the-app-with-the-hub).

Don't open port 4777 to the internet without HTTPS. The hub can run commands on every machine you
add, so anyone who reaches it gets to try your password.

## Pair the app with the hub

Once you're signed in, *Open on your phone* (on the overview until a phone is paired, under
Machines, and in Settings) shows a QR code and a typed code. In the app, tap *Add*, then *Connect
to a hub*, and scan it, or type the hub's address and the code. The phone then talks to the hub
with a token of its own, and the hub's machines show next to the computers the phone pairs with
directly.

The hub hands a code only to someone who signed in within the last ten minutes, so an old tab
asks for the password again first. A code works once, for ten minutes, and five wrong tries
cancel it. Settings on the hub lists the paired phones; *Forget* cuts one off at once. The phone
needs to reach the hub's address, so the same rules as a browser apply: a private network, or
HTTPS.

## Updating

Nothing updates by itself. When a release is out, Settings shows *Update available*.

- A hub installed with `get.sh --hub` updates with *Update* or `inyon update`. It downloads the
  release, checks it against SHA256SUMS, swaps it in and restarts, and goes back to the old one if
  the new one doesn't start.
- A hub run from source updates with *Update*, or `bun hub:update` in the checkout. It refuses
  local changes or a branch that can't fast-forward; otherwise it pulls, installs, builds and
  restarts the `inyon-hub` user unit.

## Checking a download

Every file in a release is listed in `SHA256SUMS`, and from 0.14 that list is signed with
[minisign](https://jedisct1.github.io/minisign/) by this key:

```
RWRTvQv/ifQnD3jarY1oarS0AKdhogH+mdgn/o0NzT/Ro8L43nFqqfp6
```

The `inyon` command checks the signature itself before it updates or fetches the engine, and
`get.sh` does when minisign is installed. To check a download by hand, get `SHA256SUMS` and
`SHA256SUMS.minisig` from the release, then:

```sh
minisign -Vm SHA256SUMS -P RWRTvQv/ifQnD3jarY1oarS0AKdhogH+mdgn/o0NzT/Ro8L43nFqqfp6
sha256sum -c --ignore-missing SHA256SUMS
```

On Linux the engine comes built against glibc and, for Alpine, against musl. The musl build needs
`apk add libstdc++ libgcc`, which `get.sh` runs when it can. Windows on ARM gets its own `inyon`
command and runs the x64 engine under it.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `4777` | Hub port |
| `BIND` | `127.0.0.1` | Address to listen on. Anything but localhost needs `TLS_CERT`/`TLS_KEY`, or `INYON_ALLOW_HTTP=1` |
| `INYON_ALLOW_HTTP` | | `1` serves plain http on a network `BIND`, for a VPN address that encrypts on its own |
| `INYON_DATA_DIR` | `~/.inyon` | Password hash, machine list, drafts, settings |
| `INYON_ALLOWED_ORIGINS` | | Extra comma-separated origins allowed to call the hub, for a reverse proxy on another hostname |
| `INYON_ALLOWED_HOSTS` | | Extra comma-separated host names the hub answers to. IPs, single-label names, localhost and Tailscale/NetBird names always work. `*` turns the check off |
| `TLS_CERT`, `TLS_KEY` | | A PEM certificate and key for HTTPS, needed for an installed phone app, clipboard images and notifications |
