# How Inyon reads each agent

On each machine Inyon reads tmux and the agents' own records. The agents never know it's there.
Close it and nothing breaks.

| What | Where it comes from |
|---|---|
| Panes and agents | `tmux` plus the process tree; live changes through a read-only tmux control client |
| Conversations | Claude Code and Codex session files, Gemini CLI chat recordings, OpenCode's local server |
| Prompts and spinners | The pane's screen, parsed into options |
| Plan limits | Claude: the account's usage, read on the machine the same way `/usage` does. Codex: token events |
| Context, cost | Claude's status line data (optional integration) and transcripts, Codex token events |
| Typing and answering | `tmux send-keys`, exactly as if you typed it |

## Agent notes

**OpenCode.** Sessions that Inyon starts expose a loopback API (`--hostname 127.0.0.1 --port 0`).
Their providers supply the model list and reasoning variants, and Build/Plan picks the OpenCode
agent. A session sharing a folder with another needs an explicit `-s` session ID, and
password-protected OpenCode servers aren't supported yet.

**GitHub Copilot.** Copilot is found through its process locks and event log. Its models come from
the CLI's catalog, so they match what your account can use. Assisted approval and effort changes
stay in the terminal, and sign-in uses Copilot's device-code flow.

**Shell commands.** Start a message with `!` to run a shell command through Claude Code, Codex,
OpenCode or Copilot. The agent runs it and handles permissions, and the output shows up in the
chat.

To add an agent or fix a parser, see [CONTRIBUTING.md](../CONTRIBUTING.md).
