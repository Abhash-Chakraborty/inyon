---
title: The terminal
nav: Terminal
description: The real tmux pane, with a key bar for the keys a phone keyboard lacks.
---

The terminal view is the session's real tmux window, live. Open it with **Chat · Terminal** in the session header, or **Open terminal** from a session card. A plain shell, or any program Inyon doesn't read as an agent, opens here directly.

Inyon attaches to just that one window, without tmux's status bar or prefix key, so what you see is the program and nothing else. It keeps 5,000 lines of scrollback.

## The key bar

On a phone, a bar above the keyboard has the keys it lacks:

| Key | Does |
|---|---|
| `esc`, `tab` | Escape and Tab |
| `ctrl`, `alt` | Hold for the next key (they stay down until you press one) |
| `↑` `↓` `←` `→` | Arrows |
| `^C` | Interrupt |
| `^R` | Search shell history |
| `\|` `/` `-` `~` `` ` `` | Characters that are awkward on a phone keyboard |
| Copy, Paste | Copy the selection; paste the clipboard |
| Smaller, Larger | Text size (13 px to start) |
| Keyboard | Show or hide the phone's keyboard |

## Scrolling, copying and pasting

- **Scroll** by dragging on a touch screen, or with the wheel. It scrolls tmux's own history, so you can read back past what fits on screen.
- **Paste** with `Ctrl V` (`⌘ V`) or the key bar. Text goes in as a bracketed paste, so a multi-line paste doesn't run line by line. Pasting an image uploads it to the machine and types its path.
- **Copy** by selecting text, then Copy on the key bar or your usual shortcut.

## Colours and drawing

The terminal takes the agent's colours inside a session. Text too faint to read against its background is darkened or lightened until it is, and Inyon carries its own font for the media symbols (`⏵⏵`, `⏸`) that phone fonts often lack. It draws with WebGL where the device supports it, and falls back to ordinary page drawing; Settings → About → *Terminal drawing* says which. From 0.16.1 it also falls back when WebGL would draw at the wrong scale, which on some high-resolution screens showed a few giant lines instead of the whole screen.

## When the terminal closes

If the connection drops, the view says *Terminal closed* with **Reconnect**. If no agent is running, it offers buttons to start one.

## Windows

On Windows, Inyon drives [psmux](https://github.com/marlocarlo/psmux), the native tmux for Windows. The terminal is drawn from the pane's screen, so it shows what's on screen now, without scrollback, and the window takes the phone's size while it's open. Everything else works as on Linux.
