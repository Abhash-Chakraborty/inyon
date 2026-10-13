# Android app

`apps/mobile` wraps the same web app with Capacitor, and the phone is its own hub: it runs
Inyon's core in the app (`apps/hub/src/phone`) and reaches your computers itself. There's no
server in between and no password.

- [Any computer, from anywhere](#any-computer-from-anywhere)
- [Your own copy in a browser](#your-own-copy-in-a-browser)
- [A server over SSH](#a-server-over-ssh)
- [Getting and building it](#getting-and-building-it)

## Any computer, from anywhere

On a Mac or Linux machine, run this in a terminal (on a server, in your SSH session):

```sh
curl -fsSL https://inyon.abhashchakraborty.tech/get.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://inyon.abhashchakraborty.tech/get.ps1 | iex
```

It downloads `inyon`, checks it against the release's SHA256SUMS and prints a QR code. In the app,
tap *Add a computer*, then *Scan the code*. Scanned with the phone's camera instead, the code opens
the download page, which offers to copy the link for the app. If the SSH session is on the same
phone, use the one-time ID and 6-digit code it also prints. The code works once, for 10 minutes,
and five wrong tries cancel it.

`inyon` opens a free Cloudflare quick tunnel, so the phone reaches the computer from any network
without an account or an open port. Phone and computer talk over Noise (IK, X25519,
ChaCha20-Poly1305), so the tunnel only carries ciphertext. The computer publishes its current
addresses under its own key with [pkarr](https://pkarr.org), and a forged record fails the
signature check. `--lan` also answers on the local network, which is faster at home.

On Tailscale, Headscale, NetBird, ZeroTier or WireGuard, `inyon` also answers on that network's
address, and setup says which. The Android app on the same network connects straight to it, with
no tunnel in between. A browser copy (below) only opens `wss://`, so it keeps using the tunnel, or
an HTTPS address you publish with `--url`. With Tailscale, for example:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:4780
inyon pair --url wss://laptop.tail1234.ts.net:8443/link
inyon install    # restarts the link with the new address
```

`--no-vpn` turns the private network address off. It starts off on Windows, where the firewall
would ask about it.

Setup installs `inyon` as a background service: a systemd user unit on Linux, launchd on macOS, a
logon task on Windows, or a background process with an `@reboot` cron line where there's no
systemd. `inyon uninstall` removes it and keeps your pairings. `inyon phones` lists paired phones
and `inyon forget <name>` unpairs one.

On Windows, Inyon drives [psmux](https://github.com/marlocarlo/psmux), the native tmux for
Windows, and setup installs it with winget. Everything works as on Linux, except that the terminal
is drawn from the pane's screen, so it shows what's on screen now without the scrollback.

## Your own copy in a browser

The same phone core also builds as a static web page, for anyone who wants to serve it
themselves: `inyon-web.tar.gz` in each release, or `bun --filter @inyon/web build:hosted`.
Set `INYON_WEB_URL` on a computer to point its QR codes at your copy. The pairing code rides
after the `#` in the link, which browsers never send to a server, and the page takes it out of
the address bar before anything loads. Pairing keys stay in the browser's IndexedDB, sealed with
a key the browser won't hand out.

Once you allow notifications, the page subscribes with the browser's own push service and hands
the subscription to each paired computer over the encrypted link. When an agent's hook says it
needs you or finished, the computer sends an encrypted message straight to that push service
(RFC 8291), so alerts arrive with the page closed. This needs `inyon` 0.10 or later and today
covers Claude Code. `inyon push` lists the browsers a computer sends to.

A page can't open SSH connections, so a server without `inyon` goes through a paired computer.
On iPhone, add it to the Home Screen first and pair from there: Safari forgets a site after 7 days
unused.

## A server over SSH

If you can't install anything on a server, the phone can use SSH instead, through a native plugin
built on ConnectBot's sshlib.

1. Tap *Add a computer*, then *Can't install anything? Connect over SSH instead*, and give it
   `user@host` and a port.
2. Sign in with the phone's own key, a password, or a private key you paste. The phone's key is
   an ed25519 key made on the phone; the app gives you the one command that adds it to the
   server's `~/.ssh/authorized_keys`.
3. Compare the host key fingerprint the app shows with
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server. If it ever changes, the app
   refuses to connect until you confirm.

Passwords and keys stay in Android's encrypted storage. The phone has to reach the server, so use
the same Wi-Fi or a VPN. A server on Tailscale SSH lets the phone in with no key at all.

## Getting and building it

Every push to `main` refreshes the "Latest Android build" pre-release, and each `v*` tag attaches
the APK to its release as `inyon-X.Y.Z.apk`, which is where the app looks for updates. The app
checks the [latest release](https://github.com/Abhash-Chakraborty/inyon/releases/latest) once a
day; *Download* fetches the new APK, and Android installs it over the old one. A fork without
signing secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD`
and the `ANDROID_KEY_ALIAS` variable) gets a debug build.

To build it yourself, with Android Studio installed:

```sh
bun run build
cd apps/mobile
bun x cap sync android
bun x cap open android
```

Android freezes background apps, which drops their connections. *Stay connected* in Settings keeps
a small ongoing notification so alerts arrive right away (Android 15 caps this at 6 hours a day,
reset when you open the app). Notifications for a fully closed app aren't built yet. The iOS
project in `apps/mobile/ios` isn't built or tested.
