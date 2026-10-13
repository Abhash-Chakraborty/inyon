---
title: The Android app
nav: Android app
description: Install the app, pair computers and hubs, reach servers over SSH, and keep it connected.
---

The Android app runs Inyon's core on the phone itself. It pairs with your computers and reaches them directly, so there's no server in between and no password. It can also pair with a hub, and reach servers over SSH with nothing installed on them.

## Install

Download the APK from the [download page](/download/) and open it. Android asks once to allow installs from your browser.

The app checks for a new release once a day (and whenever you open Settings). When one is out, it tells you once, and **Settings → Updates → Download** fetches the new APK, which Android installs over the old one. Your pairings stay.

## Add a computer

Tap **Add a computer** (or **+** on the Computers tab). There are four ways in, side by side:

### Scan its code

Run the installer, or `inyon pair` if it's already installed, on the computer. Tap **Scan the code** and point the camera at the QR code. The app asks *Pair with &lt;name&gt;?*; tap yes. The camera is on only while the scanner is open, and nothing is recorded.

If you scan with the phone's own camera app instead, the code opens this website, which offers to copy the pairing link for the app.

### Type a code

When the terminal is on the same phone, tap **Type a code** and enter the ID (like `K7Q4-MX2T`) and the 6-digit code printed under the QR code. It pairs as soon as both are complete. Or tap **Paste the link** and paste the link the computer printed.

A code works once, for 10 minutes, and five wrong tries cancel it.

### Connect to a hub

If you run a [hub](hub.md), sign in to its web app and choose **Open on your phone** (on the overview, under Machines, or in Settings). In the app tap **Connect to a hub**, then scan the code, or type the hub's address and the ID and code it shows.

The hub's machines then appear next to the phone's own computers. The phone talks to the hub with a token of its own. A hub that's out of reach shows its machines as connecting until it answers, and one that forgets the phone drops out with a message. **Settings → Hubs** lists them, each with **Forget**.

The phone has to reach the hub's address: over your VPN, your LAN, or an HTTPS address. Plain `http://` addresses work from the app (0.13.3 and later).

### Connect over SSH

For a server you can't install on. See [A server over SSH](#a-server-over-ssh) below.

## How the phone reaches a computer

When you pair, the computer and the phone swap long-term keys. After that, nothing about the connection depends on where either one is:

1. **Its address.** The computer opens a free Cloudflare quick tunnel and publishes its current addresses on [pkarr](https://pkarr.org), signed with its own key. The phone looks them up and checks the signature, so a forged address fails.
2. **A private network.** On Tailscale, Headscale, NetBird, ZeroTier or WireGuard, the computer also answers on that network's address, and the phone connects straight to it with no tunnel. Setup says which networks it found.
3. **The local network**, if you turned on LAN.

The phone tries the addresses it knows first, then fresh ones from pkarr. Whichever answers, the two run a Noise IK handshake (X25519, ChaCha20-Poly1305), so a tunnel or network in between only ever carries ciphertext. [Pairing a computer](computers.md) has the details and the options.

## A server over SSH

If you can't install anything on a server, the phone can use SSH, through a native plugin built on ConnectBot's sshlib. The server only needs tmux and your agents.

1. Tap **Add a computer**, then **Connect over SSH**, and give it `user@host` and the port.
2. Choose how to sign in:
   - **Phone key:** an ed25519 key made on the phone. The app gives you one command that adds it to the server's `~/.ssh/authorized_keys`. It's also in **Settings → This phone's key**.
   - **Password.**
   - **Key:** paste a private key.
3. The app shows the server's host key fingerprint. Compare it with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server, then confirm. If the key ever changes, the app refuses to connect and warns you until you check it again.

You can also connect *from a paired computer*: the phone asks that computer to SSH onward, using its own `~/.ssh/config`, keys and aliases.

Passwords and keys stay in Android's encrypted storage, and the app's data is excluded from backups. The phone has to reach the server itself, so use the same Wi-Fi or a VPN. A server on Tailscale SSH lets the phone in with no key at all.

## Staying connected

Android pauses apps in the background, which drops their connections. **Settings → Notifications → Stay connected**, on by default, keeps a small ongoing notification so your sessions stay live and alerts arrive at once. The notification has **Open** and **Stop**.

The first time a machine appears, the app asks once to run without battery limits; **Battery limits** in Settings asks again. If Android stops the service, the app says why when you come back.

A fully closed app gets no alerts yet. See [Notifications](notifications.md#the-android-app).

## Phone conveniences

- The back button closes the top sheet first, then goes back a page.
- Pasting an image from the keyboard attaches it, as on a computer.
- Long-press a session card for its menu.
- `inyon://pair` and `inyon://hub` links open the app at the right sheet.

## Building it yourself

`apps/mobile` wraps the web app with Capacitor. With Android Studio installed:

```sh
bun install
bun run build
cd apps/mobile
bun x cap sync android
bun x cap open android
```

Every push to `main` refreshes the *Latest Android build* pre-release on GitHub, and each version tag attaches `inyon-X.Y.Z.apk` to its release. A fork without the signing secrets gets a debug build.

## iPhone

There's no iPhone app yet. On an iPhone or iPad, use a [hub](hub.md) in Safari, or a [browser copy](browser-copy.md). Add either to the Home Screen first: Safari forgets a site's data after 7 days without a visit, and only Home Screen apps get notifications.
