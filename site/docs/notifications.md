---
title: Notifications
description: Hear about it when an agent needs you or finishes, and when a machine drops off or comes back.
---

## What you're told about

| Event | When | Can be turned off |
|---|---|---|
| **Needs you** | An agent is waiting on a prompt, or Codex asked a question while it works (from 0.17.6). For a command, the alert says what it's for and shows its first line; for an edit, which file | No |
| **Finished** | An agent finished working, with the start of its reply. If its turn ended with subagents or shells still running, the alert waits until those have finished too, and a few seconds more, since the agent often goes on once a subagent reports back | Yes: *When an agent finishes* |
| **Offline** | A machine has been unreachable for a minute | No |
| **Back online** | A machine that was reported offline reconnected, and how long it was away | No |

Every event also lands in **Recent activity** on the overview. A notification for the session you're already looking at isn't shown, and one you answered on another device is taken back.

While the app is open, events show as small toasts at the bottom (tap to open, swipe to dismiss). While it's in the background, they're system notifications; tapping one opens the session.

## Turning them on

Open **Settings → Notifications** and tap **Allow**, then **Send a test**. Below that, the switch *When an agent finishes* turns the Finished alerts on or off.

## How they reach you

How an alert travels depends on how you use Inyon.

### The Android app

The app watches your machines itself and posts the notifications. Each kind has its own Android channel (*Needs you*, *Finished*, *Machines* and the connection notice), so you can set their sound and importance in Android's settings. *Needs you* alerts have **Open** and **Mark read** buttons.

Android pauses background apps, which would drop the connection. **Stay connected**, on by default, keeps a small ongoing notification (*Inyon is connected*) so alerts arrive right away. The first time a machine appears, the app asks once to be allowed to run without battery limits. Some Android versions still limit how long this can run each day; the app tells you when it was stopped.

A fully closed app gets no alerts yet. That needs a push server, which Inyon doesn't run.

### A hub in a browser

The hub sends standard Web Push itself, so alerts reach a closed tab or an installed web app. This needs the hub on HTTPS (a VPN's HTTPS name, a reverse proxy, or its own certificate; see [Running a hub](hub.md#https)). Each browser that allows notifications registers with the hub, and every alert goes to every registered browser.

On iPhone and iPad, web notifications only work after you add the page to the Home Screen.

### A browser copy

A [browser copy](browser-copy.md) has no hub, so each paired computer sends alerts straight to the browser's push service, encrypted for that browser (RFC 8291). This covers Claude Code (needs you, and finished) and needs `inyon` 0.10 or later on the computer. `inyon push` lists the browsers a computer sends to.

## Haptics

On a phone, Inyon taps lightly when you press something, gives two short pulses when an outcome is confirmed (the agent took your answer, a session ended, an agent needs you) and three for an error. Settings → Appearance → **Haptic feedback** turns them off.
