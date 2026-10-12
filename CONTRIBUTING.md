# Contributing

Thanks for helping. A few notes before you open a pull request.

## Setup

```sh
bun install
bun dev:hub      # hub on :4777 with reload
bun dev:web      # Vite on :5173, proxies to the hub
```

Requires [Bun](https://bun.sh) 1.3 or later and tmux. Bun is the package manager too: there's
no npm or pnpm step.

## Checks

```sh
bun run typecheck
cd apps/hub && bun test
cd apps/web && bun test
cd apps/node && bun test
cd packages/link && bun test
```

The screen parser (`apps/hub/src/claude/screen.ts`) is tested against real captures from the
agents' terminal apps. If you change it, add a capture to `screen.test.ts` that shows the case.

## Adding an agent

Most of what Inyon knows about an agent lives in one place: `packages/protocol/src/agents.ts`
(how to detect it, its colours, commands, models and config files). A chat view also needs a
reader that turns the agent's session files or API into chat items; see `apps/hub/src/agents/`
for Codex, Gemini CLI and OpenCode.

## Look and feel

The app is ink on warm silver, with a graphite dark mode and no accent colour. The colours live as
CSS variables in `apps/web/src/styles.css`; an agent session swaps them for that agent's skin from
`packages/protocol/src/agents.ts`. A few rules hold everywhere, and `design.test.ts` and
`skins.test.ts` check the ones code can show:

- No gradients and no blur. Depth comes from a hairline border and a faint top highlight.
- Nothing smaller than 12px. Mono is for data: paths, models, costs, times.
- Status chips stay neutral and the dot carries the state. Colour means something needs you
  (amber) or went wrong (red); green only marks added lines.
- Every agent skin keeps muted text, links and button labels at 4.5:1 or better.

Every icon, splash screen and favicon is drawn from `apps/web/public/icon.svg`. Change that file,
then run `bun --filter @inyon/mobile icons`.

## Style

Match the code around you. Keep comments for the why, not the what.
