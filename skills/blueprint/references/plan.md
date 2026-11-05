# The plan page, its pages, the matrix and the progress board

## One topic per page

The plan page is the way in: the lede, the board, the short version, the decisions and a card for every
other page. Anything a reader would want on its own goes on its own page, made with
`scripts/add-page.mjs <dir> <id> --title "..." --group <Group> --blurb "..."`:

- research findings on one subject, a comparison, an audit
- a release or phase in depth (scope, checks, the work list)
- a build guide, a wiring guide, a cut list, a shopping list
- anything over about three screens of reading, or with its own table of contents

Rules for pages:
- Every page is in `site.js`, in reading order. `kit/nav.js` gives each one the site bar (Back to its
  parent, the pages, a Pages sheet on a phone), the crumbs and the previous/next links, so a reader can
  always get back and move on. A page you can only reach from one inline link is a dead end.
- Group related pages (`group: 'Research'`); a group is one menu in the bar. Keep the top level to five or
  six entries. Set `parent` when Back should go somewhere other than the plan.
- Start each page with `<div data-crumbs>`, a lede and a contents box, and end it with `<div data-pager>`.
- Run `node <skill>/scripts/check-site.mjs <dir>` after adding pages. It fails on a page missing from
  `site.js`, an entry with no file, a page without the bar and an entry that leaves the folder.
- Sites made before the site bar: `add-page.mjs <dir> --adopt` writes `site.js` from the pages it finds,
  copies `kit/nav.js` and puts the bar on every page that loads the kit. Then give the pages real groups,
  titles and blurbs, and remove the back links and page buttons they drew themselves.

## index.html, top to bottom

1. **Site bar**: `<header class="site-bar"></header>`, drawn by `kit/nav.js` from `site.js`. Don't hand-write
   links to other pages here. Parts that link to the screens sit between `<!-- mockups -->` markers;
   `new-site.mjs --no-mockups` removes them and renumbers the sections.
2. **Eyebrow**: `Plan · <date> · from <current version>`.
3. **h1**: the outcome in under eight words. No product name, no colon.
4. **Lede**: two sentences. The first says what's wrong today, the second says what the plan does about it.
5. **Buttons**: Open the screens, Feature by feature.
6. **Where it stands**: the progress board. It's driven by `progress.json`, so don't edit its HTML.
   Under it, **Pages in this plan**: `<div data-page-cards>` fills itself with a card for every other page,
   using each page's `blurb` from `site.js`.
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
9. **Footer**: name and links. Detail pages end with `<div data-pager>` instead.

Writing: plain words, sentences of 8 to 18 words, real numbers with units, sentence-case headings, at most one em dash
on the page. Cut every sentence that doesn't change what the reader knows. Leave out "seamless", "robust", "leverage",
"unlock" and similar words.

## Physical builds

Robots, electronics, craft: what Abhash asked for on his cardboard and mop robot plans (Oct and Nov 2026).

- **No promises without parts.** Every feature names the part, pin or code that does it, ideally in one
  feature → part → pin table. Keep the list small for hobby or unpaid builds; extra "dance, tunes,
  explore" features were called fake promises. When he asks for more himself, add them only on parts he
  already has, each with its part and pin, and say plainly what was tested and how (simulator or the real
  build).
- **Units on every number.** "14 × 29 cm (width × height)", never a bare "14×29". Hand-built craft
  (cardboard, paper, ruler and cutter) uses centimetres, not millimetres. Give a build guide a beginner can
  follow: part codes, dimensioned drawings, one to-scale cutting slide per sheet, and step slides showing
  where each part goes. No printable PDF templates unless he asks.
- **Wiring guides for a beginner.** One full diagram of everything connected, then one per part in the same
  layout with only that part's wires highlighted. Never move a part between pictures. Real pin names, every
  wire numbered, breadboard holes named. Show only the setup he has (no battery in a test run on a
  charger), and mark pictures of other setups "for later".
- **Shopping lists remember.** A "need" tick and a "got it" tick per row, saved in `localStorage` (wrapped
  in try/catch, since a sandbox may have none) with a reset button, and totals for still to buy and spent.
  Every tick is his to undo, and defaults come from data. Don't strike bought rows through: Got it hides
  that row's Need tick and buy link. Spent uses the real receipt, tax included. Drop controls with nothing
  left to do. Each of these is its own page (`add-page.mjs`), not a section of the plan.

## matrix-data.js

Each row is `[area, feature, want, status, today, release, phone, desktop, screen, note, url]`. A row is
any item the plan tracks: a feature, a part, a task.
- `want`: the item, as the brief, the reference product or the user describes it.
- `status`: a `v` from `MATRIX_STATUSES`. A skipped row gives the reason in `note`.
- `today`: what exists now, checked in the code. Empty for a new item.
- `release`: a `v` from `MATRIX_RELEASES` (a version, a store, a phase), or `''`.
- `screen`: a mockup id. The row then links to it in the viewer.
- `url`: an outside link (a store page, an issue). It shows as ↗ in the row and the details, and as
  "Open link" in the row's menu.

`MATRIX_STATUSES` is a list of `{ v, l, mark?, tone? }` in display order. Without it the page uses
have, partial, new and skipped. `mark` is `full`, `half`, `ring` or `dash`; left out, marks follow the
list order. `tone` is `ok`, `warn` or `bad` and colours the mark. Leave it out unless the state needs
attention. The summary has one tile per status plus the total, and the tiles fill their rows.

`MATRIX_RELEASES` is `[{ v, name }]` and `MATRIX_AREAS` sets the area order.

`MATRIX_LABELS` holds the page's words. `want` (the column title, for example "In <reference app>"),
`sub`, `subShort` and `foot` (the source and the date it was checked) are the usual ones. The rest default
to the software wording:

| Key | Default |
|---|---|
| `title`, `one`, `many`, `search` | Feature matrix, feature, features, Search features |
| `area`, `feature`, `status`, `statusName`, `release` | Area, Feature, `<BRAND>`, Status, Release |
| `today`, `todayNone`, `todaySkipped` | `<BRAND>` today, Nothing yet, Not planned |
| `phone`, `desktop`, `note`, `link` | On the phone, Desktop and browser, Note, Link |
| `menuShow`, `menuHide`, `menuMockup`, `menuLink` | Show details, Hide details, Open mockup, Open link |
| `menuArea`, `menuRelease`, `allAreas`, `menuCopy` | Only {area}, Only release {release}, All areas, Copy as text |
| `copied`, `copyFailed`, `sortNone` | Copied, Could not copy, Inventory |

A label set to `''` leaves out its column or field: `area`, `want`, `status`, `today`, `release`,
`phone`, `desktop` and `note`. "Copy as text" uses the same labels.

A parts list, for example:

```js
window.MATRIX_STATUSES = [{ v: 'have', l: 'In the drawer' }, { v: 'ordered', l: 'Ordered' }, { v: 'buy', l: 'To buy', tone: 'warn' }];
window.MATRIX_RELEASES = [{ v: 'Reichelt', name: 'Passives and power' }, { v: 'Mouser', name: 'Pot and caps' }];
window.MATRIX_LABELS = { title: 'Parts list', one: 'part', many: 'parts', search: 'Search parts', feature: 'Part',
  want: 'Spec', status: 'Status', release: 'Store', menuRelease: 'Only {release}', today: '', phone: 'Quantity', desktop: 'Price each' };
// row: ['Regulator', 'LM317T', 'Adjustable regulator, TO-220.', 'have', '', 'Reichelt', '2', '0.48 €', '', '', 'https://…']
```

The matrix loads `mockups/screens.js` only when some row has a `screen`. A site made with `--no-mockups`
sets `window.MATRIX_MOCKUPS = false`, which turns mockup links off.

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

The board shows everything in the file as text, and a task's `link` only when it is http(s) or relative.
Inyon can push a fresh copy into the page with `{type:'bp-progress', data}`, which the board accepts only
from the page it is framed in; keep `render(d)` and that listener if you rework the board.
