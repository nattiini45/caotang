# Rehearsal: caotang.app product pictures (#359)

Eight stills on one page, rendered at build time (no script): the hero (wide and compact), the Board (wide and compact), and the
Local-first, Binder, Export and Codex & Findings tiles. Every one is a poster: there is no motion on this page until the owner relaxes
`script-src 'none'` (PLAN.md, L2), so there are no beats, no loop and no reduced-motion difference to film.

**Motion is L2.** Caspar agreed (2026-11-02) that the landing may later run its own self-hosted script (about 100 kB) for animated demos; that is a separate follow-up, and these stills become its poster frames and no-JS fallback (each stage is rendered with `renderToString` into a `[data-stage]` root, and `stages/render.tsx` exports the `STAGES` map a client entry would hydrate).

**hero: re-check after #361 and #363.** The hero draws the ghost capsule and the agent window as the Modern spec intends them; the app
still draws Classic's bar there (#361) and the agent window is being reworked (#363). Re-film it against the app once both land, so
the picture never shows a better UI than the product.

## Gold

| Still | Gold kept | What changed |
|---|---|---|
| Hero | `hero-demo` (one hero surface, a satellite straddling its edge, the cursor resting on the payoff), `raycast` for the layout on the product's own ground | The harbour wallpaper is the page's hero band, not a plate. The page bleeds off the foot only, one gutter (40 wide, 28 compact) above and to its left; the agent window is the satellite over the page's right margin. Compact is a redesign: the page alone, no satellite (on a phone the agent is a full-screen sheet). |
| Board | `reorder` (a card lifted by its grip over the room the others made), on `static-card`'s pinned bottom bleed | Modern's medium cards; four columns with the fourth showing 70 px; the second row cut at its synopsis. Compact: two whole columns, the page off the right. |
| Local-first | `opposite-corners` (copy bottom-left, the product hung from the top-right corner) | The key field from Settings › Providers, sealed. The tile is a slice of the wallpaper's sky with the sun set outside it, under Modern's dark scrim in dark. |
| Binder | `static-card` (hard crop, quiet hierarchy), `table-edit` (the total the writing feeds) | Modern's binder rows at 44 px on the kit's Row; the chapter's goal ring met. |
| Export | `tilted-stack` (small alternating angles, only the top sheet has words) | The top sheet is a real screenplay PDF page from Caotang's renderer (`assets/README.md`); angles smaller than the gold's because a Letter page turns its edge further than a receipt. |
| Findings | `form-error` (the error on what caused it), `panel-annotation` (one leader through empty ground) | The app's own finding ("Knows before learning"), its one action. |

## Captured

- Widths 1440 (wide stages) and 390 (compact stages and the tiles at one column), light and dark: `film.mjs --still --gate` on each,
  24 runs, in Firefox (Playwright 1.63, the skill's `browser.mjs` swapped for a Firefox launcher; Chromium does not run in the sandbox).
- Each still held beside its gold at the same width (sheets of gold, light, dark).
- Close-ups: the Board's lifted card (`--zoom 200,0,220,180`), the Export stack (`--zoom 0,0,333,278`).
- The page itself at 1440 and 390, light and dark (fold and the Local-first and Export tiles in place).

## Film

| Line | Frame | Fix or why it stands |
|---|---|---|
| `kit override:` ×6 on every stage | every still | The kit's own CSS and ours were minified into one `stages.css`, so film read every kit rule as an override. The build now writes the kit's CSS apart as `kit/stageshow.css`. One real override was under it: the binder set `.ss-row__title`'s font size, now left to the kit's `--ss-row-title` token. |
| `framing:` Board card 10 px at the right, 16 px past the foot | board-wide | Cards 176 wide: the fourth column shows 70 px. Stage 272 tall: the second row is cut at its synopsis (92 px shown). Compact shows two whole columns instead of an 18 px third. |
| `touching:` bar 4–6 px from a glyph | board, binder | Gap 8 between the grip or folder and the title. |
| `uneven inset:` indented binder row | binder | The depth (18 px a level, as the app's binder) moved from the row's padding into a spacer at the head of its lead; the row keeps 12 px at both ends and the selected pill still spans the row, as in the app. The picture is unchanged. |
| `framing:` back sheet 6 px from the top | export | The pile moved 8 px down, the stage 8 px taller, so no words were lost at the foot. |
| `tight inset:` title, count, Apply 6 px from their capsule | hero | Each label sits in its own span inside its pill or button, so it is measured from the pill it is on (18 px). Nothing moved. |
| `fat row:` the paragraphs read as one-line rows | hero | The selected paragraph and its draft are wrapped as one passage. It is a multi-line paragraph whose highlight is one inline box; the check took it for one line. |
| `framing:` compact page 8 px from the sides with a 40 px top | hero-compact | One gutter: page at 28 / 28, 302 wide; the title capsule takes the page's width so its sides line up with the page's. |
| `near-tangent:` lifted card 3 px from a neighbour | board | The lifted card is carried further right, over the next card's edge, as a card in the hand would be. |
| `squeezed:` the ⋯ button | hero-compact | `flex: none`. |
| **`uneven gutters:` the selection and the ghost inside the page (stands)** | hero-wide, hero-compact, both looks | Not fixed. The check is for a card set on a tile; these are a highlighted paragraph (one inline box over five ragged lines) and the draft block in the page's text flow, at the text column's own 88 / 88 (18 / 18 compact) margins, with the page running on under them to the capsule and off the foot. Looked at again in every hero frame: they read as text on a page, not as cards floating on a plate. This is why the hero gate does not end `rehearsal passed`. |
| `near aligned:` agent name and status pill (not gating) | hero-wide | The name now sits on the same edge as the words in the pill and the turn (12 px). The check compares the pill's box edge with the name's text. |

Gate at hand-over: Board (wide, compact), Local-first, Binder, Export and Findings end `rehearsal passed` at 1440 and 390, light and
dark. The hero (wide, compact) stops at the two `uneven gutters` lines above in both looks.

## Review (fresh-eye pass, review.md, done by the builder with the frames and golds only)

1. Framing. Hero: the page bleeds off the foot with one gutter, the satellite sits over the margin, not the words. Tiles: each runs
   its product off the tile's edges; no plate under anything. Nothing worded is cut. The Local-first tile's statement no longer sits
   on the sun (it did in dark at 1440 and 390; the frame showed a bright disc behind "No server.").
2. Hierarchy. The Board's first glance is the lifted card; the Binder's is the goal ring and its total (scenes are now one weight
   step under the chapter, which had read as six bold lines); Findings' is the warning title on the card under the leader.
3. Polish. The Board's lifted card showed beige wedges across it in Firefox: an inset 1 px shadow on a turned, rounded box. It is a
   border now; the close-up shows a clean edge. The wallpaper's blurred haze shows a faint horizontal band in the Local-first tile at
   390 in light (the SVG's own blur region); the app shows the same wallpaper and it is left as the product draws it.
4. Export: the top sheet's 1-inch top margin reads as a band of white above the scene heading. It stays: the stack is told by its top
   edges, and the margin is the page's own.

## Assumptions

- The hero shows the Modern spec's ghost capsule (modern-interface.md §7.3) and agent window, not today's app (see the top).
- Cursor positions in the hero and Board stills are fixed in CSS from the built layout (the page runs no script to measure them).

## Unresolved

- The hero's two `uneven gutters` lines (above).

## Not checked

- Chromium and WebKit rendering of the page (Firefox only here; CI does not film the landing).
- A real phone (390 is a desktop Firefox viewport).
- Reduced transparency and forced colours on the landing (the page has no such switch; the pictures use the system's colour scheme only).
- Motion: none exists yet.
