# Tether

Your coding agents keep running in tmux on your machines. Tether lets you watch them, answer
them and steer them from your phone or any browser.

It works with Claude Code, Codex, Gemini CLI, OpenCode and GitHub Copilot, on as many machines as
you have, each signed in to whatever account it already uses. Nothing about how you work at the
keyboard changes: walk away from your laptop, pick the session up on your phone, sit back down
and carry on in the same terminal.

## Why

I run agents on a laptop, a personal server and a company server. Each is signed in to a
different account, and on the company machine I only have the CLI. Built-in remote features
follow one account at a time, so switching between machines meant switching accounts.

Tether never signs in anywhere. It drives the agent CLI that is already running in tmux on each
machine, so every machine can use its own account, subscription or API key.

## What you get

- **A real chat view** for each agent session: formatted replies, tool calls, diffs, plans and
  to-dos, instead of a terminal squeezed onto a phone. A full terminal is one tap away.
- **Prompts as buttons.** Permission requests, questions, menus and sign-in links show up as
  native controls. Answer from the overview without opening the session.
- **Live numbers:** model, reasoning effort, context window, cost, run time, lines changed, and
  the 5-hour and weekly plan limits with reset times. Codex credits too.
- **Controls:** switch model, effort and permission mode; set a goal and turn it off again; turn
  Remote Control on and off; compact, clear and rewind.
- **Everything in the background:** queued messages, background shells with live output and a
  real Stop, monitors, subagents (open their own transcripts) and artifacts.
- **A composer that knows the agent:** `/` suggestions for built-in commands, skills, plugins and
  your own commands; `@` fuzzy file search; attach, paste or drop images and files.
- **Drafts follow you.** What you type is saved and mirrored into the terminal's input box, and
  what you type in the terminal shows up in the app.
- **Each agent looks like itself.** The app is neutral; a session takes on its agent's colours,
  logo and reply font.
- **Machine setup:** checks for tmux and each agent, installs what's missing, opens sign-in, and
  can keep a tmux session running.
- **Phone, tablet and desktop**, light and dark, with haptics on phones. Installable as a web app.

## How it works

A small hub runs on one machine you trust. It talks to each machine in one of three ways:

| Machine | How the hub reaches it |
|---|---|
| The hub's own machine | Directly |
| A laptop or desktop | It runs `tether-node`, which connects **out** to the hub. No open ports. |
| A server | SSH, using your existing `~/.ssh/config`, keys and jump hosts |

On each machine the hub reads tmux and the agents' own records:

| What | Where it comes from |
|---|---|
| Panes and agents | `tmux` plus the process tree; live changes through a read-only tmux control client |
| Conversations | Claude Code and Codex session files, Gemini CLI chat recordings, OpenCode's local server |
| Prompts and spinners | The pane's screen, parsed into options |
| Plan limits | Claude: the account's usage, read on the machine the same way `/usage` does. Codex: token events |
| Context, cost | Claude's status line data (optional integration) and transcripts, Codex token events |
| Typing and answering | `tmux send-keys`, exactly as if you typed it |

Agents never know Tether is there. If you close Tether, nothing breaks.

## Agent support

| Agent | Chat view | Live status | Prompts | Notes |
|---|---|---|---|---|
| Claude Code | Full | Full, with the integration | Full | Hooks give exact session matching |
| Codex | Full | Context, limits, credits | Numbered prompts | Reads `~/.codex/sessions` |
| Gemini CLI | Beta | Context | Numbered prompts | Reads `~/.gemini/tmp/*/chats` |
| OpenCode | Beta | Context, cost | Through its API | Talks to the server OpenCode already runs |
| GitHub Copilot | Beta | Context and activity | Native CLI prompts | Reads the running CLI session |

## Quick start

You need [Bun](https://bun.sh) 1.3+, pnpm and tmux on the hub machine.

```sh
git clone https://github.com/Abhash-Chakraborty/tether.git
cd tether
pnpm install
pnpm build
pnpm start
```

The hub listens on `127.0.0.1:4777` and prints a generated password on first start. Change it
with `pnpm --filter @tether/hub set-password`.

Open it from your phone over a private network (Tailscale, NetBird, WireGuard or your LAN), or
put it behind an HTTPS reverse proxy. To keep it running, see `deploy/tether-hub.service`.

## Adding machines

**Laptops and desktops:** *Add a machine → This device connects to Tether.* Copy the one-line
command onto that machine. It installs a small user service (and Bun, if missing). No sudo and no
open ports.

**Servers:** *Add a machine → Connect over SSH* with `user@host` or an alias from the hub's
`~/.ssh/config`. The machine only needs tmux.

Each machine's **Setup** tab checks for tmux, Node.js and every agent, installs what's missing,
and opens sign-in for each agent in a terminal.

## Security

The hub can run commands on every connected machine, so it should be reachable only by you. It
binds to localhost by default, stores only a hash of its password, and rate-limits sign-ins.
Paired machines connect out with per-machine tokens that you can revoke. See
[SECURITY.md](SECURITY.md) for the full model and what Tether changes on a machine.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `4777` | Hub port |
| `BIND` | `127.0.0.1` | Address to listen on |
| `TETHER_DATA_DIR` | `~/.tether` | Password hash, machine list, drafts, settings |
| `TLS_CERT`, `TLS_KEY` | | Paths to a PEM certificate and key to serve HTTPS. Needed for a real installed app on phones (and clipboard images, notifications) |

## Development

```sh
pnpm dev:hub       # hub with reload
pnpm dev:web       # Vite dev server on :5173
pnpm typecheck
cd apps/hub && bun test
```

```
apps/hub           Bun server: machines, tmux, agent readers, API, WebSocket
apps/web           React + Vite app (also served by the hub)
apps/node          tether-node, the outbound connector for laptops
packages/protocol  types and the agent registry shared by hub and app
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to add an agent or fix a parser.

## Status

Tether is young. Linux and macOS work today; Windows (psmux) is next. Expect rough edges with
the beta readers.

## License

MIT. See [LICENSE](LICENSE). Agent names and logos belong to their owners; see
[NOTICE.md](NOTICE.md).

### OpenCode and GitHub Copilot

Tether wraps the installed CLIs and their sessions. New OpenCode sessions expose a loopback API
with `--hostname 127.0.0.1 --port 0`. Connected providers supply the model list and reasoning
variants; Build/Plan selects the OpenCode agent. Dashboard settings apply to the next prompt.
Use Sign in to choose a provider and complete its native login flow. Existing ambiguous sessions
in the same directory need an explicit `-s` session ID. Password-protected OpenCode servers are
not yet supported by this adapter.

Copilot uses its process locks and event log to identify the running session. Models come from
the CLI catalog and reflect account access; Auto-only plans show Auto. Manual approval and full
access are supported. Experimental assisted approval and model effort changes remain terminal
controls. Sign-in uses Copilot's device-code flow. Neither integration invents a goal API.

Start a composer message with `!` to run a shell command through Claude Code, Codex, OpenCode,
or Copilot. Its output appears in chat. The CLI owns execution and permission handling.
