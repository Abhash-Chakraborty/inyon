# Contributing

Thanks for helping. A few notes before you open a pull request.

## Setup

```sh
pnpm install
pnpm dev:hub     # hub on :4777 with reload
pnpm dev:web     # Vite on :5173, proxies to the hub
```

Requires [Bun](https://bun.sh) 1.3 or later, pnpm, and tmux.

## Checks

```sh
pnpm typecheck
cd apps/hub && bun test
```

The screen parser (`apps/hub/src/claude/screen.ts`) is tested against real captures from the
agents' terminal apps. If you change it, add a capture to `screen.test.ts` that shows the case.

## Adding an agent

Most of what Inyon knows about an agent lives in one place: `packages/protocol/src/agents.ts`
(how to detect it, its colours, commands, models and config files). A chat view also needs a
reader that turns the agent's session files or API into chat items; see `apps/hub/src/agents/`
for Codex, Gemini CLI and OpenCode.

## Style

Match the code around you. Keep comments for the why, not the what.
