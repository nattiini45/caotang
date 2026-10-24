# Comics — comic books, pages, panels and balloons (media track)

> Status: **specified, not built.** No comic node kind, page editor, lettering font or comic export exists in the current build; the decisions in §9 bind the work when it is cut.
> Scope: a comic-book track beside the storyboard: a `comic` node kind, pages with panels and balloons, a comic-script document kind, lettering rules, comic PDF, CBZ and fixed-layout EPUB exports, and the agent tools that derive pages from a script.
> Cross-refs: picture registry, import and transcoder = [pictures.md](pictures.md) §2/§4/§6 · the media-track rule (new kinds, exporters and tools, never a fork) = [media-track.md](media-track.md) §0 · storyboard (the closest precedent) = [storyboard.md](storyboard.md) · Fountain as a parsed text kind = [screenplay.md](screenplay.md) §2 · PDF fonts and fallbacks = `@caotang/pdf-fonts` · deterministic check registry = [coherence.md](coherence.md) §5.4 · timeline adapter = [timeline.md](timeline.md) §9.4.

## 1. Fit with the media track

A comic is a new *document kind + node kind + exporters + tools*, exactly like the storyboard (media-track §0). Comic panels are **not** storyboard shots: shots are film time (duration, camera move, transition), panels are page space (rectangles, reading order, balloons). The two share the picture registry, the import commands, the contact-sheet PDF machinery and the "script is the spine" posture.

### 1.1 Evidence

| # | Convention or pain point (evidence) | How the design follows it |
|---|---|---|
| D1 | There is no standard script format. Full script (DC style) and plot script (Marvel method: art first, dialogue last) both dominate; panels are labelled "Panel 1", "1.)" or "PANEL A", the page header carries the panel count, lettering items are numbered (Wikipedia "Script (comics)"; Blambot; Celtx) | The parser accepts all of these spellings (§3.1), and the model supports pages-first work as well as script → pages (D10). |
| D2 | Lettering grammar: all caps; the crossbar "I" only for the pronoun and acronyms; bold italic for stress; a double dash, never an em dash; tails aimed at the mouth ending at 50–60% of the distance; thought tails of circles; radio balloons italic; whispers dashed (Blambot "Comic Book Grammar & Tradition") | Render rules and lint (§4). |
| D3 | Comic Neue is a casual Comic Sans fix, not a lettering face: mixed case, Light/Regular/Bold with obliques, no crossbar-I logic (comicneue.com) | Comic Neue and Bangers are both **SIL OFL 1.1** (verified: comicneue.com; google/fonts `ofl/bangers/OFL.txt`). Caps transform plus a crossbar-I rule (§4); the face is a book setting, swappable later (D11). |
| D4 | Existing tools export CBZ, EPUB and PDF (Krita writes ComicInfo, ACBF and CoMet; Comic Life; Clip Studio). KDP wants comics as **fixed-layout** EPUB | Comic PDF and CBZ first; a fixed-layout EPUB as a later phase. Panel rectangles map to ACBF frames and Kindle panel view. |
| D5 | ComicInfo.xml is ComicRack's de-facto format, maintained by the Anansi project: v2.0 stable, v2.1 draft; `Manga=YesAndRightToLeft` sets RTL; `Pages/Page@Type` and `DoublePage` exist; `LanguageISO` should be BCP 47 (Anansi docs) | Write v2.0 fields only (§5). |

## 2. Model

`packages/comic`, pure, injected into the store like `@caotang/storyboard`:

```ts
tree[].kind: 'comic'                 // folder = issue/book (the three-tier invariant holds: pages are its children)
tree[].comic: {                      // the book's settings, additive and unknown-tolerant
  readingDirection: 'ltr' | 'rtl';   // the book's own direction; never the interface's
  letteringFace: string;             // 'comic-neue' first (D11)
  capsTransform: boolean;
  esszett: boolean;                  // German ß → SS unless the book opts into ẞ
  pageSize: 'us-comic' | 'manga-b5' | 'a4' | 'letter';
  scriptDocId?: string;              // optional link to a kind: 'comic-script' document (§3.1)
}
tree[].type: 'comic-page'            // node; ordered, so the page number is derived (the shotNumber precedent)
tree[].comicPage: {
  size: 'us-comic' | 'manga-b5' | 'a4' | 'letter';    // trim; bleed 3 mm / 0.125 in per preset
  layout?: string;                   // template id ('grid-6', 'splash', '3-tier', …): a starting point only
  panels: Panel[];                   // reading order = array order (LTR or RTL per book setting)
}
Panel   { id; rect: [x, y, w, h] /* 0..1 of the live area */; assetId?; crop?: [x, y, w, h]; border?: 'none' | 'thin' | 'bold';
          balloons: Balloon[]; script?: DialogueCoverage[] }
Balloon { id; kind: 'speech' | 'thought' | 'caption' | 'sfx' | 'whisper' | 'shout' | 'radio'; text; speaker?: codexId;
          rect; tail?: [x, y]; offPanel?: true; fontSize?; style?: 'lettering' | 'sfx' }
```

Book settings live on the `comic` folder as above; unknown keys load tolerantly (project-format §6). A panel's `assetId` is a picture-registry record ([pictures.md](pictures.md) §2.1), so a panel picture is a typed use, counted by `usesOf`.

**The script link (`scriptDocId`) is optional and explicit.** A comic book may have no script — the Marvel method starts from pages — and then `scriptDocId` is absent, not empty and not guessed. When it is present: it names a `kind: 'comic-script'` document; **at most one script per book**, and a script belongs to **at most one book**; it is set or cleared only by `comic.setScript {nodeId, scriptDocId: string | null, expect}` (write-auto, inverse undo, the link only), which refuses a document that is not a comic script, one already linked to another book, and a stale `expect` (the value the plan read, `null` when absent). **Deleting the script document clears the link** through `project.deleteNode`'s cascade, and one undo restores both the document and the link. A link whose document is gone at load is **kept and shown as broken** — "The script for this book is no longer in the project. Choose a script, or work from the pages." — with a *Choose a script…* action; it is **never** re-matched by title, by file name or by content. `comic.derive` refuses until the link is cleared or re-pointed. The timeline's comics unit (§6) follows the same link.

## 3. Script and method

### 3.1 The comic script

A comic script is `docs/<id>.md` with `kind: 'comic-script'`, the industry plain-text convention, parsed as text the way Fountain is (screenplay.md §2). No new storage format; codex mention detection works on it unchanged.

- **Accepted spellings:** `PAGE ONE` / `Page 1` / `PAGE 1 (five panels)`; `PANEL 1` / `Panel 1:` / `1.)` / `PANEL A`; lettering lines `NAME:`, `CAPTION:`, `SFX:`, optionally numbered (`3. NAME:`).
- **Modifiers:** `(OFF)` / `(OP)` → off-panel tail; `(WHISPER)` → whisper; `(BURST)` → shout; `(THOUGHT)` → thought; `(RADIO)` / `(ELEC)` → radio. Unknown modifiers are kept as text.
- **A page count in a header** is checked against the panels found, as a soft finding.

### 3.2 Both methods (D10)

- **Full script:** `comic.derive {doc}` (write-confirm, model-backed, mirrors `shots.derive`) turns a script into pages, panels and balloon text, with anchors captured fresh; it generates no images. `doc` must be the book's linked script (§2); when the book has no link, the command links that document as part of the same undo group if no other book holds it; when a different script is linked, it refuses and names it. `comic.letter` (write-auto) fills balloon text from script lines.
- **Marvel method:** a comic book can start with no script. Panels and balloons are authored on the page, and `comic.scriptFromPages` (write-confirm) writes or updates a comic-script document from the pages, capturing anchors fresh; a book with no link gets one from that command in the same undo group, and a book that already has a script updates it rather than making a second.
- `comic.balloon-coverage` (deterministic, joins the closed registry with fixtures, coherence §5.4) works in both directions: every script line lettered, every balloon's script anchor still resolving.

**The comic commands and their classes** (each starts in command-bus §9 with its row; until then this table is the owning contract):

| Command | agentRisk · undo | Notes |
|---|---|---|
| `comic.createBook {parentId, title, settings?}` | write-auto · inverse | A `comic` folder and its book settings; a page-less book is valid. |
| `comic.setPage {nodeId, stored, expect}` | write-auto · inverse | The whole page value over the one it replaces, the `shot.setMeta` pattern; refuses a node that is not a comic page and a stale `expect`. |
| `comic.setScript {nodeId, scriptDocId, expect}` | write-auto · inverse | §2: the link only; validates the script kind, uniqueness in both directions, and the stale link. |
| `comic.derive {doc}` | write-confirm · compensable | Model-backed; one undo group covers the link it establishes and the pages it writes. |
| `comic.letter` | write-auto · inverse | Balloon text from script lines. |
| `comic.scriptFromPages {nodeId}` | write-confirm · compensable | Creates or updates the script document and its link as one undo group. |

None of these is in `ACCEPT_EDITS_TOOLS`: *Accept edits* asks for `comic.derive` and `comic.scriptFromPages`, *Auto* approves them as native cards, and a delegated agent may stage them but never apply them. `comic.balloon-coverage` and `comic.balloon-density` are deterministic checks, not commands and not tools.

### 3.3 Page editor

`apps/desktop/src/media/ComicPageView.tsx`: an SVG page with panel rectangles (drag and resize, snap to gutters), a picture per panel (drop or paste → `asset.import` + `comic.setPage`) and balloons (text, tail drag). Commands: `comic.createBook`, `comic.setPage {nodeId, stored, expect}` (the whole-value-with-`expect` pattern of `shot.setMeta`), `comic.setScript` (§2), and the script commands of §3.2; page create and reorder use the existing `binder.*` commands. The corkboard variant for a `kind: 'comic'` folder shows page thumbnails. Every command starts in command-bus §9 and its risk class and undo are §3.2's table.

### 3.4 Paper round trip

The storyboard's `paperFrames` idea carries over: print blank panel layouts, draw, photograph, drop the photographs back; each lands by its file-name number (`0012.jpg` = page 12) via `asset.importBatch`, one undo step, never by reading the photograph.

## 4. Lettering (render rules and lint)

- **Caps transform** with `toLocaleUpperCase(projectLanguage)`. German ß becomes "SS" unless the book opts into ẞ. Skipped for caseless scripts (Han, Kana, Arabic, Hebrew, Devanagari) and switchable per book, since mixed-case lettering is common in European and translated comics.
- **Crossbar I:** the pronoun "I" and acronyms use the serifed I; other I's do not. This needs a glyph alternate; Comic Neue's coverage is checked when D4 vendors the font, and if it has none, the rule is drawn as a substituted glyph from the same face's serifed I or left off with a note in the build log.
- **Emphasis:** `**word**` in balloon text renders as bold italic (Comic Neue Bold Oblique). `--` stays a double dash; an em dash is lint-flagged.
- **Tails:** default length 55% of the balloon-to-speaker distance. Thought tails are three circles toward the head. Radio balloons are spiky with italic text; whispers are dashed.
- **Fonts (D11):** Comic Neue for dialogue and Bangers for SFX, both OFL 1.1, vendored as `vendor/comic-lettering` (`@caotang/font-comic-lettering`) with their `OFL.txt` in THIRD-PARTY-NOTICES, built to TrueType WOFF by a pinned script with checksums like `vendor/noto-sans-cjk`. Served from the app origin (`font-src 'self'`) and loaded in Node from the package (the `@caotang/pdf-fonts/node-loader` pattern). Non-Latin balloons fall through the existing fallback chain (CJK, Arabic and Hebrew with bidi, Devanagari, emoji). Blambot's free fonts are not candidates (not OFL). Vertical manga lettering is parked.
- **`comic.balloon-density`** (deterministic, warning only): above ~25 words per balloon or ~50 per panel, the guidance script templates state.

## 5. Export

| Format | Behaviour |
|---|---|
| `comic-pdf` | pdf-lib (pinned 1.17.1, lazy), one PDF page per comic page at trim plus bleed. Reuses `cid-embedding.ts`, `fitPieces`, bidi and the WebP `PictureTranscoder` from `render-contact-sheet.ts`. Balloons are vector paths with the text set in the lettering face. Options: `bleed`, `cropMarks`, `readingDirection`. |
| `cbz` | A zip (fflate) of one raster per page (`0001.jpg` …) plus `ComicInfo.xml` **v2.0**: Title, Series, Number, Writer, Penciller, Letterer, PageCount, LanguageISO (BCP 47), Manga (`YesAndRightToLeft` when the book reads RTL), Pages with Type, DoublePage, ImageWidth, ImageHeight. Rasterised at 1988 px page height by default, under the iOS < 18 canvas cap. **App-only** (D12): `OffscreenCanvas` and `FontFace` with the vendored fonts, no WASM, CSP unchanged; Node refuses with a reason. |
| `comic-epub` (later phase) | Fixed-layout (pre-paginated) EPUB: one page image per spine item, the balloon text also present as hidden HTML for accessibility, panel rectangles exported as region navigation. The format KDP and Apple expect for comics. **Generated in the browser only, through the same rasterizer as the CBZ** (D12): the file is portable and readable anywhere, but the CLI, the SDK and the MCP server refuse to make one. |

**The host gate.** `comic-pdf` is written by both hosts. `cbz` and `comic-epub` rasterise pages on a canvas with the vendored `FontFace`s, so they are **browser-only**: the command line, the SDK and the MCP server refuse them **before writing anything**, with "Comic EPUB and CBZ are made in the app. Open the project in Caotang and export there." The EPUB's portability is a property of the file, not evidence of a headless generator; **no Node comic rasterizer is added**, and the refusal is a refusal, never a silently empty or cover-only file.

The formats join `EXPORT_FORMATS`, `MEDIA_FORMATS` and `BINARY_FORMATS` (`types.ts`) when their renderers land; **`cbz` joins both `isBinaryPath` regexes** (`pdf` and `epub` are already there). The exporter's current format list is read from `EXPORT_FORMATS`; this spec adds three names to it, never a restated count.

## 6. Timeline

The comic-script document is the timeline's scene-level unit: it carries `SceneMeta` like any document, and the `comic` folder can carry a folder span. The unit is the book's **linked** script (§2), never a document matched by title; a pages-first book with no script has no scene-level unit and only the folder span, and nothing is inferred. Pages appear as strips under their linked script, or under the book when it has none, with `measure` = pages ([timeline.md](timeline.md) §9.4).

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Lettering looks amateur in Comic Neue | Medium | Caps and crossbar-I rules; the face is a book setting, so D11 can swap it without a model change. |
| ComicInfo v2.1 changes | Low | Write v2.0 only; readers ignore unknown fields. |
| CBZ and comic EPUB need a canvas, so headless hosts cannot write them | Certain | Node and the MCP server refuse with the export-from-the-app remedy **before writing**; the comic PDF is the headless path, and the fixed-layout EPUB is a reading format made in the app, not a headless generator. |

## 8. Phased plan

Milestone **Comics**, epic #149. Issues: D1 #165, D2 #166, D3 #167, D4 #168, D5 #169, D6 #170, D7 #171, D8 #172, D9 #173. It comes after Pictures A1 and A4 ([pictures.md](pictures.md) §11). Every feature issue updates USER-GUIDE, CHANGELOG and ROADMAP in the same pull request and flips this spec's status line for what it builds.

| # | Title | Scope | Done when | Needs |
|---|---|---|---|---|
| D1 | `docs(architecture): specify the comic track` | This spec; ARCHITECTURE §6 row | Spec merged | — |
| D2 | `feat(comic): comic books, pages, panels and balloons` | `packages/comic`, the node kind, `comic.createBook`, `comic.setPage`, `comic.setScript` with the optional one-script link, its uniqueness in both directions, deletion cleanup and the broken-link notice, the comic-script kind and parser (all spellings, modifiers, page-count check), Marvel method and `comic.scriptFromPages` | Pages persist with panels and balloons; unknown-tolerant load; parser fixtures for each spelling; a script written from pages round-trips; a deleted script clears its link and one undo restores both; a missing script shows the broken link and is never inferred by title; a pages-first book loads and exports with no script | D1, Pictures A1 |
| D3 | `feat(comic): a page editor for panels and balloons` | `ComicPageView.tsx`, the corkboard variant | Lay out a six-panel page with art and balloons, each step undoable | D2, Pictures A4 |
| D4 | `build(fonts): vendor an OFL lettering font and an SFX face` | `vendor/comic-lettering` (Comic Neue, Bangers), pinned build script, licences in THIRD-PARTY-NOTICES; caps, crossbar-I and emphasis rules | Checksums pinned; app and Node loaders; a caps-transform fixture per locale rule | D1 |
| D5 | `feat(export): comic PDF with trim, bleed and lettering` | `render-comic-pdf.ts`, format registration | pdf-lib read-back tests (pages, sizes, images, ToUnicode) | D2, D4 |
| D6 | `feat(export): CBZ with ComicInfo.xml` | Canvas rasterizer (app), ComicInfo v2.0 fields, `cbz` in **both** `isBinaryPath`, Node refusal | A CBZ opens in a reader with RTL set when the book is RTL; Node refuses with a reason | D5 |
| D7 | `feat(comic): derive pages and panels from a comic script, and a balloon coverage check` | `comic.derive`, `comic.letter`, `comic.balloon-coverage` | Mock-provider evals; coherence fixtures in both directions | D2, Pictures C2 |
| D8 | `feat(export): fixed-layout EPUB for comic books` | `comic-epub`: pre-paginated, hidden balloon text, region navigation, made in the browser through the CBZ rasterizer; CLI, SDK and MCP refuse before writing | epubcheck-clean fixed-layout book; each page one spine item; the Node refusal names the export-from-the-app remedy and writes no file | D5 |
| D9 | `feat(coherence): balloon density and lettering lint` | `comic.balloon-density`, em-dash and caps lint | Warning fixtures over and under the thresholds | D2 |

## 9. Decisions

Recorded on 2026-10-23: the owner approved the recommended option of each decision. The numbering continues [pictures.md](pictures.md) §12, which these were designed with. One-line versions are in [decisions.md](../decisions.md).

| # | Decision | Rejected alternative and why |
|---|---|---|
| D9 | **Comic panels are a separate `comic` kind**, not storyboard shots. | Shots with a page layout on top: film time and page space are different models. |
| D10 | **Both full script and Marvel method** (pages first plus `comic.scriptFromPages`) from D2. | Full script only: both methods dominate the industry. |
| D11 | **Comic Neue plus Bangers** (OFL verified), with caps and crossbar-I rules; the face is a book setting. | Searching for a dedicated OFL all-caps lettering face before D4 ships: delays the track for a swappable setting. |
| D12 | **CBZ and the fixed-layout comic EPUB (D8) are made in the app only**, through the same canvas rasterizer; both files are portable once written, and the CLI, SDK and MCP server refuse them with the export-from-the-app remedy. | A Node rasterizer: a native or WASM dependency for two formats, and "the EPUB is portable" is not a reason to add one. |

## 10. Sources

en.wikipedia.org/wiki/Script_(comics) · blambot.com/pages/comic-book-grammar-tradition · anansi-project.github.io/docs/comicinfo/documentation · comicneue.com · github.com/google/fonts/blob/main/ofl/bangers/OFL.txt · kdp.amazon.com/en_US/help/topic/G75V4YX5X8GRGXWV. Krita, Comic Life and Clip Studio export behaviour and Celtx's comic elements come from search excerpts only and are not relied on for specifics.
