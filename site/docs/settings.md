---
title: Settings
description: Every setting in the app, what it does and its default.
---

Settings live on the **Settings** tab. Display settings are saved per device; settings about machines and uploads are saved where they apply.

## Appearance

| Setting | Choices | Default |
|---|---|---|
| Theme | Light, Dark, Auto | Auto (follows the system) |
| Match the agent inside sessions | On, Off | On: a session takes its agent's colours and logo |
| Reply font | Auto, Serif, Sans, Mono | Auto: each agent's own reply font |
| Tool calls in chat | Everything, Compact | Everything |
| Haptic feedback | On, Off | On |

Under reduced motion (a system setting), nothing slides or moves; sheets and menus only fade.

## Agents

Where each agent is installed (*On laptop, server*), the command that starts it, and whether its sessions open as a chat or in the terminal.

## Live numbers

**Restart sessions that stop reporting.** If a session's live numbers stop updating, Inyon reconnects or restarts it by itself.

## Uploads and clipboard

| Setting | Choices | Default |
|---|---|---|
| Delete uploads after | 1, 7 or 30 days, Never | 7 days |
| Largest file | 25, 100 or 500 MB | 100 MB |

Uploads are stored on each machine in `~/.inyon/uploads`. The machine's page shows how much space they take, with buttons to clean older ones or delete them all.

## Notifications

**Allow**, **Send a test**, and *When an agent finishes*. On Android, also **Stay connected** and **Battery limits**. See [Notifications](notifications.md).

## Computers or Machines

A shortcut to the list. The app calls them *Computers*; a hub calls them *Machines*.

## On a hub

- **Other devices.** The hub's address with a copy button, **Show the code** to pair the Android app, and the paired phones, each with **Forget**.
- **Account.** **Change password** (8 characters or more; signs out your other browsers) and **Sign out**.

## On the Android app

- **Hubs.** The hubs this phone is paired with, each with **Forget**.
- **This phone's key.** The phone's SSH public key, and the command that adds it to a server's `~/.ssh/authorized_keys`. See [A server over SSH](android.md#a-server-over-ssh).

## Updates

What's installed and whether a newer version exists, with **Check now**:

- The Android app checks for a new release once a day and shows **Download** when there is one.
- A hub shows *Update available* with **Update**; see [Updating a hub](hub.md#updating).
- A browser copy reloads to its newest version.

## About

The version and build, the Android app's version, how the terminal is drawn, and **Copy version details** for a bug report.

## Keyboard shortcuts

| Keys | Does |
|---|---|
| `Ctrl K` / `⌘ K` | Search and jump to a session |
| `Alt N` / `⌥ N` | New session, even while typing a message (from 0.16; not in the terminal) |
| `N` | New session, when you aren't typing |
| `Enter` / `Shift Enter` | Send / new line |
| `Esc` | Stop the agent (with an empty message box), close a sheet or menu |
| `↑` `↓`, `Enter`, `Tab` | Move through and pick from menus, `/` and `@` lists |
| Any key | Focus the message box (on a computer) |
| `Ctrl V` / `⌘ V` | Paste into the terminal |

On Android, the back button closes the top sheet first, then goes back a page. A long press on a card opens its menu. On a computer, right-click for the same menus; see [Right-click menus](overview.md#right-click-menus).
