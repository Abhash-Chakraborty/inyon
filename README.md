<p align="center"><img src="apps/web/public/icon.svg" width="88" height="88" alt=""></p>

<h1 align="center">Inyon</h1>

<p align="center">
  <b>Your coding agents, from your phone.</b><br>
  Watch, answer and steer Claude Code, Codex, Gemini CLI, OpenCode and GitHub Copilot<br>
  running in tmux on your own computers. Each keeps its own account.
</p>

<p align="center">
  <a href="https://github.com/Abhash-Chakraborty/inyon/releases/latest"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/release/Abhash-Chakraborty/inyon.svg?variant=secondary&mode=dark"><img alt="Latest release" src="https://shieldcn.dev/github/release/Abhash-Chakraborty/inyon.svg?variant=secondary&mode=light"></picture></a>
  <a href="https://github.com/Abhash-Chakraborty/inyon/actions/workflows/ci.yml"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/ci/Abhash-Chakraborty/inyon.svg?workflow=ci.yml&variant=secondary&mode=dark"><img alt="CI status" src="https://shieldcn.dev/github/ci/Abhash-Chakraborty/inyon.svg?workflow=ci.yml&variant=secondary&mode=light"></picture></a>
  <a href="#quick-start"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/badge/runs%20on-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows%20%C2%B7%20Android.svg?variant=secondary&mode=dark"><img alt="Runs on Linux, macOS, Windows and Android" src="https://shieldcn.dev/badge/runs%20on-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows%20%C2%B7%20Android.svg?variant=secondary&mode=light"></picture></a>
  <a href="LICENSE"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/license/Abhash-Chakraborty/inyon.svg?variant=secondary&mode=dark"><img alt="MIT licence" src="https://shieldcn.dev/github/license/Abhash-Chakraborty/inyon.svg?variant=secondary&mode=light"></picture></a>
</p>

<p align="center">
  <a href="https://inyon.abhashchakraborty.tech/">Download</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#docs">Docs</a> ·
  <a href="https://github.com/Abhash-Chakraborty/inyon/releases">Releases</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/hero-dark.webp">
  <img src="docs/hero-light.webp" alt="Inyon on a desktop, a tablet and a phone: the overview of every agent session across four machines, a Claude Code session read as a chat, and Codex asking to run the tests">
</picture>

Walk away from your laptop while an agent works. When it asks something, answer from your phone
with a tap. Sit back down and carry on in the same terminal, because nothing changed at the
keyboard.

## See it work

Codex asks before it runs the tests. Answer from the overview, then watch the results come in.

<img src="docs/answer.webp" alt="On a desktop browser, the overview zooms in on a Codex session asking to run bun test src/auth. The cursor clicks Yes, run it, opens the session as a chat, and the reply says all 31 auth tests pass.">

On a phone, read the change an agent made, watch the tests pass and send the next instruction.

<img src="docs/phone.webp" alt="On a phone, the overview scrolls to a Claude Code session fixing a flaky checkout test. Tapping it opens the chat, the edit expands into a diff, the 50-run test suite finishes with no failures, and a reply asking for a regression test is typed and sent.">

On a tablet, sessions sit in a tree by machine. Ending one says exactly what closes.

<img src="docs/tablet.webp" alt="On a tablet, the sidebar tree of machines and sessions is zoomed in, then an OpenCode session's menu opens End session. The confirmation sheet says the agent exits and its pane closes, and a Session ended toast appears.">

## Why I built it

I run agents on a laptop and two servers, each signed in to a different account. Built-in remote
features follow one account at a time, so switching machines meant switching accounts.

Inyon never signs in anywhere. It drives the agent CLI already running in tmux, so every machine
keeps its own account, subscription or API key.

## What you can do

- Read each session as a chat: replies, tool calls, diffs, plans and to-dos. The real terminal is
  one tap away.
- Answer permission requests, questions and menus with buttons, straight from the overview.
- See the model, context, cost and lines changed, plus the 5-hour and weekly plan limits.
- Switch model, effort and permission mode, or compact, clear and rewind.
- Follow queued messages, subagents and background shells, each shell with a real Stop.
- Type with `/` commands, `@` file search and attached images. Drafts mirror into the terminal.
- Set up a new machine from the app: it installs tmux and the agents, then opens sign-in.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/phones-dark.webp">
  <img src="docs/phones-light.webp" alt="Three phones: the overview with a Codex prompt waiting for an answer, a Claude Code session as a chat with its to-do list, and the Machines page with four machines, one offline">
</picture>

Inside a session the app takes on that agent's colours, logo and reply font. Everywhere else it
stays ink on silver, in light and dark.

## How it works

<img src="docs/how-it-works-anim.webp" alt="The phone or browser talks to one hub. The hub reads its own machine directly, laptops connect out to it by running inyon, and servers are reached over SSH. The Android app can do the same without a hub.">

Inyon reads tmux, the process tree and each agent's own session files, and types answers back with
`tmux send-keys`. The agents never know it's there. There are three ways to connect a machine:

| Way | What runs on the machine | How you connect |
|---|---|---|
| Direct | Nothing but tmux | The app or a hub connects over SSH |
| Paired | `inyon`, as a small user service | Scan its QR code in the Android app |
| Hub | A hub on one machine that stays on; others join it | Open the hub in any browser |

Paired machines reach the phone through a free Cloudflare tunnel or your VPN, end-to-end
encrypted with Noise, so nothing needs an open port or an account.

## Agent support

| Agent | Chat view | Live status | Prompts |
|---|---|---|---|
| Claude Code | Full | Full, with the integration | Full |
| Codex | Full | Context, limits, credits | Numbered prompts |
| Gemini CLI | Beta | Context | Numbered prompts |
| OpenCode | Beta | Context, cost | Through its API |
| GitHub Copilot | Beta | Context and activity | Native CLI prompts |

[How Inyon reads each agent](docs/agents.md) has the details.

## Quick start

**With the Android app**, nothing is hosted anywhere:

1. Install the APK from the [download page](https://inyon.abhashchakraborty.tech/).
2. On each computer, run one line. It prints a QR code.

   ```sh
   curl -fsSL https://inyon.abhashchakraborty.tech/get.sh | sh      # macOS, Linux
   irm https://inyon.abhashchakraborty.tech/get.ps1 | iex           # Windows, PowerShell
   ```

3. In the app, tap *Add a computer* and scan it.

Since 0.13 that line installs `inyon`, a 2 MB command, and its setup fetches the engine (about
85 MB, with Bun inside) next to it as `inyon-engine`. The command draws the setup, the status
screen and the pairing code; the engine runs the link and the hub. A 0.11 or 0.12 install crosses
over on its next update, and an older one needs the line above again. The split is in beta for
this release.

**From a browser**, run a hub on a machine that stays on, then open the address it prints:

```sh
curl -fsSL https://inyon.abhashchakraborty.tech/get.sh | sh -s -- --hub
```

The hub listens only on localhost until you choose a network. [Running a hub](docs/hub.md) covers
the rest, and [SECURITY.md](SECURITY.md) explains why it matters.

## Docs

- [Android app](docs/android.md): pairing, private networks, servers over SSH, building the APK
- [Running a hub](docs/hub.md): install, sign-in, reaching it from a phone, updates, configuration
- [Adding machines](docs/machines.md): laptops, servers and what happens when one goes offline
- [How Inyon reads each agent](docs/agents.md)
- [Security](SECURITY.md): the threat model and what Inyon changes on a machine
- [Contributing](CONTRIBUTING.md): development setup, tests, adding an agent

## Status

Inyon is young and moving fast. Linux, macOS and Windows (through psmux) work today. The Gemini,
OpenCode and Copilot readers are in beta, and the iOS app isn't built yet.

The name comes from 인연 (*inyeon*), the Korean word for a bond between people. 연 on its own also
means kite, which is the mark.

## License

MIT. See [LICENSE](LICENSE). Agent names and logos belong to their owners; see
[NOTICE.md](NOTICE.md).
