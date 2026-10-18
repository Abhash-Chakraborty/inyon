# The plan page, matrix and progress board

## index.html, top to bottom

1. **Top bar**: logo, name, links to Screens and Feature matrix, theme button. Keep it as is.
2. **Eyebrow**: `Plan · <date> · from <current version>`.
3. **h1**: the outcome in under eight words. No product name, no colon.
4. **Lede**: two sentences. The first says what's wrong today, the second says what the plan does about it.
5. **Buttons**: Open the screens, Feature by feature.
6. **Where it stands**: the progress board. It's driven by `progress.json`, so don't edit its HTML.
7. **Contents**: one link per numbered h2.
8. **Sections**, numbered `01`, `02` and so on. Pick from these and keep the order:
   - *Short version*: three or four `.short` items (icon, a bold sentence, one more line), then four `.stats`
     (features mapped, screens, releases, and the one number the plan moves).
   - *What changes*: a Today / After table.
   - *How it works*: a figure with a caption that tells the story on its own, then a `.call` box for the main trade-off.
   - *Screens*: one sentence, then `#gallery`, which fills itself from `SCREENS` and the stills in `shots/`.
   - *Releases*: the `R` array in the page script. Each release gets `v`, `r` (the id progress.json uses), `t` (title),
     `s` (one-line subtitle) and the lists `scope` and `check` ("Done when"). Use `{ phase: 'Name' }` rows to group them.
   - *Bugs we won't ship*, *Compatibility*, *Risks*: tables. Use risks only if they're real, each with what you'll do.
   - *Decisions*: `.dec` cards tagged `Decided`, `Question`, `Trade-off`, `Flag` or `Gap`. Put open questions here, so
     the reader can answer them.
9. **Footer**: name and links.

Writing: plain words, sentences of 8 to 18 words, real numbers with units, sentence-case headings, at most one em dash
on the page. Cut every sentence that doesn't change what the reader knows. Leave out "seamless", "robust", "leverage",
"unlock" and similar words.

## matrix-data.js

Each row is `[area, feature, want, status, today, release, phone, desktop, screen, note]`.
- `want`: the feature, as the brief, the reference product or the user describes it.
- `status`: `have` | `partial` | `new` | `skipped`. A skipped row gives the reason in `note`.
- `today`: what the product does now, checked in the code. Empty for `new`.
- `release`: a `v` from `MATRIX_RELEASES`, or `''`.
- `screen`: a mockup id. The row then links to it in the viewer.
`MATRIX_AREAS` sets the area order. `MATRIX_LABELS` has `want` (the column title, for example "In <reference app>"),
`sub`, `subShort` and `foot` (the source and the date it was checked).

## progress.json

```json
{ "updated": "ISO time", "now": "what is being worked on",
  "releases": [ { "v": "2.4", "r": "R1", "title": "…", "status": "todo|doing|done|blocked",
                  "tasks": [ { "id": "r1-x", "title": "…", "status": "todo", "note": "optional", "link": "optional URL" } ] } ],
  "log": [ { "t": "ISO time", "text": "…" } ] }
```

Give each task an id that's unique across the file, and end each release with a "Release X" task. Let
`progress.py` set the release status and the timestamps; don't edit them by hand while workers run. The
board opens the first release that's in progress. The newest log line goes first, and only 200 are kept.
