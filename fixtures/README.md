# Test fixtures

Captured agent screens and records that the parser tests read. The hub's tests (`bun test` in
`apps/hub`) and the Rust tests (`cargo test`) read the same files, so a parser ported to Rust is
checked against exactly what the Bun one was.

## Layout

```
fixtures/
  screens/<agent>/<name>.txt         one terminal capture each
  transcripts/<agent>/<name>.jsonl   an agent's own records, one JSON value per line
  protocol/<Type>/<name>.json        messages the hub and the app send each other
  link/<part>.json                   the phone link's bytes, from packages/link/src/vectors.ts
  expected/                          what the TS readers make of the captures, for the Rust ones
```

`<agent>` is the agent's id from `packages/protocol/src/agents.ts`: `claude`, `codex`, `opencode`,
`copilot`, `gemini` or `antigravity`. The screen and transcript parsers are tested from here.

`protocol/` holds wire samples, made with the hub's own parsers and readers. `<Type>` is the name
of a type in `packages/protocol` (`ServerMsg`, `ClientMsg`, `AgentCatalog`…), and a file holds one
message or an array of them. Each must read into the Rust type and write back as the same JSON.

`link/` holds the phone link's test vectors (identity, Noise, channel, codes, pairing links, pkarr,
relay). `bun packages/link/src/vectors.ts` writes them, and both `packages/link` and `crates/inyon-link`
check their output against them.

`expected/` holds what the hub's TS readers make of the shared captures:
`expected/screens/<agent>/<name>.json` for each screen (read at its own width, at 80 and at 120
columns), and `expected/chat-screen.json`, which ties each `chat.screen` sample in `protocol/` to
the capture it came from. `bun apps/hub/src/cli/expected.ts` writes them; the hub's
`expected.test.ts` fails when they no longer match the TS readers, and `crates/inyon-core` checks
the Rust readers against them. Write them again after a reader changes on purpose or a capture is
added, and commit them with the change.

There are no transcript captures yet. The reader tests build their records in code, one at a time,
next to what each one should produce.

## Screens

A screen file holds the rows exactly as the test feeds them to the parser, joined with `\n`. The
tests read it with `.split('\n')`, so:

- Keep the bytes as captured: colour codes, trailing spaces and wide characters stay.
- Don't add a final newline the capture didn't have (it would become an extra empty row). Files
  saved straight from tmux end with one, and the tests expect that row.
- The pane width and the agent aren't stored in the file. Each test passes them, so name a capture
  after its width when that matters (`permission-wrapped` is the 80-column one).

To add one, capture the pane and save it under the agent's folder:

```sh
tmux capture-pane -p -t %12 > fixtures/screens/codex/new-menu.txt      # text only
tmux capture-pane -p -e -t %12 > fixtures/screens/opencode/new-tab.txt # with colours, when the parser needs them
```

Shorten home paths and anything private before you commit it.

## Reading them

- Bun: `fixture('screens/codex/queued.txt')` and `screenFixture('codex', 'queued')` from
  `apps/hub/src/fixtures.ts`.
- Rust: `cargo test -p inyon-protocol --test fixtures` (`crates/inyon-protocol/tests/fixtures.rs`)
  loads every file and fails on one that is out of place or doesn't parse, so the layout is checked
  from both sides.
