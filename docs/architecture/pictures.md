# Pictures and attachments — one picture registry, links, inline pictures in prose

> Status: **built except where a section names a remaining gap.** The registry, app surfaces, exports, agent tools and transcription flow run in the current build; §0 is the historical starting point, not a status list. The comic-book track that shares this registry is its own spec, [comics.md](comics.md).
> Built (the store, the bus, the app's picture surfaces and the agent's picture tools): `packages/pictures`, the pure domain core, wired into the manifest, the codecs and the command bus as the `asset.*` commands of §2.4 plus `asset.storeWorkingCopies`, with a backfill of records for the images an older project uses. The core: the model of §2.1, tolerant readers and strict validators, link operations, `usesOf`/`linksOf`, hash dedup and the backfill planner, the §6.1 limits and header reading, the §6.4 EXIF strip, and paragraph-identity capture (§2.3). Clarifications it settles: `width`/`height` are the **display** size (EXIF orientation applied); every limit is strictly greater-than (exactly 16 MiB, 50,000,000 px, 24,000,000 px or 8 MiB passes that step); `asset.setMeta` carries record fields only, a link's `note` belongs to a separate link patch; a `card` link is valid only on a `node` target, and moving the card turns the old one into a `reference` rather than dropping it; an understood link does not block `asset.delete` (it goes with the record), an unknown role or target kind does; the strip rewrites EXIF in place, zeroes every removed byte, cuts only a zero tail, returns a file with nothing to remove unchanged, and refuses EXIF it cannot walk safely; XMP and IPTC are stripped too (§6.4 step 4). **What the integration settles:** a staged picture is reserved, not taken, so a failed or cancelled write (a full quota included) publishes no record and leaves the bytes staged for the retry; the strip runs before the hash, so two copies that differ only in a location or an author are one picture; an import whose bytes match a file in `assets/` that has no record adopts that file; a batch is all or nothing and asks the large-photo question once; the records and the caller's references are published together, and an undone import leaves its file for the next import to adopt; an `assets[]` or `assetLinks[]` entry this build cannot read, and a field it does not know, go through a save unchanged; `asset.import` and `asset.importBatch` are **write-confirm**, as `shot.importImage` is, because the writer chose the file; the cover and the shot's image keep their commands, names and refusal texts and run on the same engine without the dedup (`project.importAsset`) or with it only against what the project already holds (`shot.importImages`). HEIC remains not built. **The app's side of §5 is built** (the picture board, the Inspector's strip and the corkboard's card picture): the board is the **Pictures** choice of the centre switch, with *Choose pictures…*, drop and paste as one `asset.importBatch` each (the large-photo question is asked once per batch, *Cancel* writes nothing, and a full disk keeps the chosen files for *Try again*); S, M and L thumbnails; filters by tag, placement, source, unused, lost paragraph and (only once a picture has one) transcription; a batch of selected pictures tagged or placed together (one command and one undo step per picture); a details panel for caption, alt text, decorative, tags, "Used in" and placements with their notes; a delete that asks first and lists the placements that go with the picture (a typed use refuses it, with the uses listed); the bytes-and-pixels meter with the ten largest; and the lightbox of the shot board, reused. A picture without a caption goes by the name of the file the writer chose, kept as the `source` label. The Inspector's strip lists the pictures placed on the selected item with a note on each, makes one the card picture, links a picture the project holds or imports new ones onto the item, and opens a picture on the board. A medium or large corkboard card shows its card picture; a picture dragged from the board, or files dropped from the desktop (imported, then placed), become the card picture, and **Card picture…** in the card's menu is the keyboard route. A `card` placement onto a picture the item already holds as a `reference` promotes that placement in place (its note and order stay) rather than being refused as a duplicate. **Also built:** *Store working copies* as a bulk action on pictures already imported (with the confirm that says the originals stay until Undo), and attaching a picture to one paragraph — the strip's *Attach to this paragraph* captures the paragraph anchor from the editor's selection, offered only while the editor shows this document, a range is selected, and the store holds the text the caret is in. The lost-paragraph surfaces offer *Re-pin* and *Make document-level*. Re-pin shares *Attach to this paragraph*'s live selection, document and saved-text guards and runs `asset.repin` as one undoable command, leaving the old link and undo history untouched on refusal. *Make document-level* runs the internal `asset.makeDocumentLevel` compound command: it links the picture to the item and removes the orphaned placement in one state replacement and one undo step, or only removes the lost placement when the item already holds the picture. The picture-aware eviction banner, monthly bundle reminder and optional pre-export sweep of §6.5/§6.6 are built. The board's own rendered component tests remain a gap (its model and browser flows are covered, its isolated markup is not).
> Scope: pictures attached at project, chapter (folder), page (document) and paragraph level; pictures placed in prose and carried into every export; the import pipeline (HEIC, size, EXIF); vision input for the agent; MCP in both directions; handwriting transcription (#146); MCP image content blocks (#145).
> Cross-refs: asset files and ids = [storyboard.md](storyboard.md) §2.2 · additive manifest keys = [project-format.md](project-format.md) §2 · anchors and the resolve ladder = [edit-anchors.md](edit-anchors.md) · editor schema (`image` node) = [editor-engine.md](editor-engine.md) §3.1/§3.3 · compile hosts = [exporter.md](exporter.md) · storage posture and the eviction banner = [ui-modules.md](ui-modules.md) §5.3 · harness rows = [agent-harness.md](agent-harness.md) §10 · MCP = [extensibility.md](extensibility.md) · timeline consumer = [timeline.md](timeline.md) §9.1 · comics = [comics.md](comics.md).

## 0. What exists today (the ground this builds on)

| Piece | Where | What it does |
|---|---|---|
| Asset files | `assets/a_XXXXXXXXXX.<png\|jpg\|webp>` in the project folder (storyboard.md §2.2; project-format.md §2 media note) | Flat, opaque random ids (`ASSET_ID_PATTERN` in `packages/storyboard/src/ids.ts`, `parseAssetFileName` in `assets.ts`). Loaders ignore unknown files, so the directory is additive. |
| References | `manifest.project.coverAssetId`, `tree[].shot.image`, `codex[].visualRefs[]` (`packages/store/src/manifest.ts`) | Three typed, per-kind pointers to asset ids. **There is no registry**: no caption, tags, hash, size or source; an asset exists only because a file exists. |
| Import commands | `project.importAsset` (cover), `shot.importImage(s)` (`commands-shot-image.ts`, `descriptors-shot-image.ts`) | Bytes are **staged** (`AssetStaging`, never a JSON param), sniffed by leading bytes (`sniffCoverImage`), capped at `COVER_MAX_BYTES` = 16 MB, written through `ProjectAssetPort.writeBytes`, **then** the reference is set. Undo restores the reference; the file stays (a harmless orphan). A batch is all-or-nothing, one undo group. |
| Byte storage | `apps/desktop/src/app/project-assets.ts` over `packages/store/src/runtime/asset-store.ts` | Read order memory → IndexedDB `caotang-assets` (v1, store `assets`, key `[projectId, path]`) → attached folder. Dangling references are dropped only against an *authoritative* listing. |
| Bundle | `packages/store/src/zip.ts` (`assets` option) | Pictures ride in the project zip. |
| Exporter | `prose.ts` `case 'image'` → **alt text only**; `render-text.ts` `renderMarkdown` writes each scene body as the writer wrote it; `render-epub.ts` carries only the cover; `render-contact-sheet.ts` embeds PNG/JPEG and transcodes WebP through the `PictureTranscoder` port | The prose model that TXT, Word and EPUB share reduces every inline picture to alt text today. **Markdown does not:** the body's Markdown is preserved byte for byte, so an inline picture survives as its own spelling and its `../assets/` destination does not resolve from `exports/`. There is **no prose PDF**; `pdf` is the screenplay PDF. |
| Editor | `packages/editor/src/schema.ts` | `image` is an inline node (`src`, `alt?`, `title?`), parse and serialise only, no insert UI. **No block ids**; the only durable position is a `TextAnchor` resolved by the ladder in `edit-anchors.ts` (`CONTEXT_MATCH_FLOOR = 0.8`, `FUZZY_SIMILARITY_FLOOR = 0.85`). `diff-match-patch@1.0.5` is already pinned. |
| Gateway | `packages/gateway/src/types.ts` | `ModelCaps.vision` is declared and filled, but **nothing reads it**; `ChatMessage.content` is a `string`. |
| MCP client | `packages/mcp-client/src/invoke.ts`, `images.ts` | Image content blocks are checked, staged and shown to the model as a stub, never as text (§8.3). |
| Hosted | `packages/remote-store` | No asset support. |
| File inputs | `IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp'` | Leaves out `image/heic`, which is what makes iOS Safari transcode HEIC to JPEG for us (§6.4). It must stay that way. Folder attach needs `showDirectoryPicker`, which Safari lacks. |

Constraints carried through: IndexedDB `caotang-app` is never renamed and never holds project bytes. The CSP is `img-src 'self' data: blob:`, `font-src 'self' data:`, no `wasm-unsafe-eval`, so browser-side decoding is canvas-only; Node may use WASM (the `@jsquash/webp` precedent). Every new binary export extension joins **both** `isBinaryPath` regexes (`packages/exporter/src/emit.ts`, `apps/desktop/src/app/exports.ts`) and `BINARY_FORMATS`.

## 1. Evidence: prior art and the pain points this design avoids

| # | Pain point (evidence) | How the design avoids it |
|---|---|---|
| A1 | Project bloat from imported research; Scrivener's answer, external links, breaks on move (L&L blog, L&L forum #133672) | Hash dedup (§6.2), a per-project size meter, and a once-per-batch "keep originals / store 4096 px working copies" prompt (§6.4). No external links. |
| A2 | Compile-time scaling by DPI is confusing and lossy (Scrivener produced 1×1 px images) | Export sizes by pixels per target, never by DPI metadata; one resampling path (§4). |
| A3 | Plain-Markdown export drops images (Ulysses) | `exports/<name>.assets/` copy is the default, pinned by a test that every exported image resolves. |
| A4 | Export scales display size but not file size; caption doubles as alt (Ulysses) | Export resamples; `alt` is separate from `caption` (§2.2). |
| A5 | Links break when files are renamed outside the app (Obsidian forum #91670) | Immutable random file names; load-time "renamed outside Caotang: re-link?" by `sha256` (§6.3). |
| A6 | Remote image URLs expire (Notion: one hour) | A remote URL is never the source of truth; MCP and web images are saved as bytes. |
| A7 | Hosted quotas and silent recompression (World Anvil) | Local-first; no recompression unless the writer opts in. |
| A8 | Ebook tools emit only what every reader handles (Vellum: JPEG/PNG/GIF, 800–1600 px) | EPUB targets JPEG/PNG at ≤ 1600 px by default (§4). |
| B1 | Orphans must stay visible (Hypothesis "Unanchored" tab) | `orphaned` links stay, listed under "Lost their paragraph" with the old quote struck through. |
| B2 | Fuzzy fallback re-anchors silently to a lookalike (hypothesis/client #7571) | Paragraph links **map through the edit**; the ladder is a guarded fallback (§2.3). |
| B3 | Paragraph splits break node-relative positions (y-prosemirror #204) | Plain-text offsets mapped through a diff; a split is an inserted `\n\n`. |
| B4 | Anchors tied to internal block ids are opaque to outside tools (Google Docs `kix` ids) | Quote anchors, so agents and MCP clients can create one from a quote. |
| C1 | WebP is EPUB 3.3 core but renders blank on Kobo e-ink (kobolabs/epub-spec #74; w3c/epubcheck #1484) | EPUB transcodes WebP to JPEG/PNG by default; keep-WebP is opt-in. |
| C2 | Kindle: no transparency, sRGB only, alt required, captions as HTML (KDP guidelines) | Flatten alpha onto white, sRGB, `figure`/`figcaption`, `alt` plus `decorative`. |
| C3 | WebP in Word depends on the version | DOCX transcodes to JPEG for photos, PNG for alpha or lossless sources. |
| C4 | Pandoc resolves relative paths against the working directory (pandoc #8099, #3752) | Document `--resource-path`; exported Markdown uses a sibling folder with no `..`. |
| E1 | Safari deletes script-writable storage after 7 days without interaction (WebKit storage policy) | Picture-aware eviction banner and bundle reminder (§6.6). |
| E2 | Quotas are best-effort; writes fail with `QuotaExceededError` (MDN) | The import keeps the file staged and offers "attach a folder / export a bundle"; never silent. |
| E3 | HEIC decodes only in Safari 17+; adding `image/heic` to `accept` makes Safari convert other formats (caniuse; WebKit #267277) | `IMAGE_ACCEPT` stays without HEIC; a dropped `.heic` is decoded where possible, otherwise refused with a remedy. |
| E4 | iOS canvas area caps (16.7 MP before iOS 18) produce blank canvases; 48 MP phone photos exist | Resize on decode (`createImageBitmap` with `resizeWidth`), blank-output check, pixel budget. |
| E5 | Phone photos carry EXIF GPS; only some iOS paths strip it (WebKit #257534) | Strip the GPS IFD **at import** (§6.4). |
| F1 | Vision LLMs are weaker on non-English and historical hands (arXiv 2503.15195) | Plan-card warning; no automatic self-correction loop. |
| F2 | MLLMs hallucinate plausible text; proper nouns and numbers dominate errors (arXiv 2502.20295) | Codex names as a vocabulary hint, `[?word?]` marks, per-page review, optional second read. |
| F3 | Incumbents index first and convert second; re-transcribing overwrites edits (Goodnotes, Rocketbook) | A "searchable only" mode; re-transcription never overwrites approved text. |

Sources are listed in §13.

## 2. Data model

### 2.1 One registry plus links, not per-kind images

Per-kind pointers cannot carry a caption, tags, a hash or a transcription, and three more kinds (document, paragraph, comic panel) would multiply the dangling-reference, undo and export logic. So: **one registry (`assets[]`) and one list of links (`assetLinks[]`)**, both additive top-level arrays in `caotang.json` (D4). The three existing pointers stay as they are on disk (no shape migration, no `formatVersion` bump); they are read as *typed uses* of a record, and a backfill gives every existing file a record (§6.2). The links are not called `attachments`: `CodexEntry.attachments` already means codex ↔ node links.

```ts
interface AssetRecord {
  id: string;                 // a_XXXXXXXXXX: the existing id space and file name
  file: string;               // 'a_….png' under assets/ (extension from the sniff)
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  sha256: string;             // hex, of the bytes as stored; the dedup key (§6.2)
  bytes: number;
  width?: number; height?: number;
  caption?: string;           // ≤ 2000; default caption for a new placement
  alt?: string;               // ≤ 500; default alt text for a new placement
  decorative?: true;          // exports write alt=""
  tags?: string[];            // ≤ 32 × 64 chars, the keywords rule
  source?: { kind: 'import' | 'paste' | 'mcp' | 'scan' | 'agent'; label?: string; server?: string; tool?: string; url?: string };
  transcription?: { docId?: string; anchor?: TextAnchor; text?: string; model?: string; at: string };   // §8.4
  workingCopy?: { fromBytes: number; fromWidth: number; fromHeight: number };                         // §6.4
  createdAt: string; updatedAt?: string;
}

type AssetTarget =
  | { kind: 'project' }
  | { kind: 'node'; nodeId: string }        // folder = chapter, document = page, shot, comic page
  | { kind: 'paragraph'; nodeId: string; anchor: ParagraphAnchor; orphaned?: true; moved?: true };

interface ParagraphAnchor extends TextAnchor { blockHash: string; ordinal: number }   // §2.3 tie-breakers

interface AssetLink {
  id: string;                 // l_…
  assetId: string;
  target: AssetTarget;
  role: 'reference' | 'card' | 'source';   // card = the node's corkboard/timeline thumbnail (≤ 1 per node); source = a transcription's page
  order: number;              // gap-encoded, like tree[].order
  note?: string;              // ≤ 2000
  when?: { dayOffset?: number; label?: string };   // a picture that marks a moment; semantics owned by timeline.md §9.1
}
```

- **Inline placement is not a link.** A picture in prose is a Markdown image in the body (§3), so it moves with the text. The registry learns about it by scanning bodies (a derived "used in" index).
- **Uses are derived, never stored:** cover, `shot.image`, `codex.visualRefs`, inline images, comic panels ([comics.md](comics.md) §2) and `assetLinks`. One pure selector, `usesOf(assetId)`, lives in a new pure package `packages/pictures` (types, validation, selectors, anchor mapping, file-name helpers moved from `@caotang/storyboard`). `usesOf` and `linksOf` take **structural snapshots** — the manifest's tree, codex and link arrays — and the parsed image references the caller supplies; the package imports neither the store nor the editor, so the dependency runs pictures ← store ← bus.
- **Load rules** (project-format §6 discipline): a record whose file is absent from an *authoritative* listing is kept and marked missing, **not dropped**, because it carries the writer's caption and transcription. A link to a deleted node goes with the node (`project.deleteNode` cascades; undo restores it). An unknown `role` or `target.kind` is kept as a string.

### 2.2 Caption and alt; placement-level text in the body

`alt` and `caption` are separate fields. An inline placement keeps its own text in the body, `![alt](../assets/a_….png "caption")`, using Markdown's standard alt and title slots, so the body still renders everywhere. The registry values are the defaults a new placement starts from; the same sketch can carry different captions in different chapters, and the exporter reads the body first. With no alt anywhere, the caption is used as alt and the compile log notes it. With `decorative`, export writes `alt=""`.

#### 2.2.1 The placement title suffix, versioned and escaped (v1)

A placement's decoration flag and size hint are not registry facts — the same picture can be decorative in one chapter and a figure in another — so they live in the placement, in the Markdown title slot. **The default spelling is unchanged:** a placement with a caption and no decoration or non-default size writes exactly `![alt](../assets/a_….png "caption")`, and a body with no suffix loads and saves byte for byte.

The title slot is `"<caption><suffix>"`, where the suffix is present only when metadata differs from the default:

```
![alt](../assets/a_XXXXXXXXXX.png "The lighthouse, 1891 [caotang-image v1;size=half;decorative]")
```

- **Grammar.** A suffix is an unescaped space followed by `[caotang-image vN;` and zero or more `key=value` pairs separated by `;`, closed by `]`. The caption is everything before that space, or empty when the suffix opens the title — an empty caption writes the title as exactly `[caotang-image v1;…]`, with no leading space. Version 1's keys are `size` (`full`, `half`, `inline`; absent is `full`) and `decorative` (a bare `decorative` means true; absence means false). Unknown keys, unknown values and values outside a key's domain are preserved verbatim; they do not change display and are re-encoded after the known entries in their original relative order. A value outside a key's domain is also reported once on load and rendered as the default.
- **Encoding is deterministic.** A canonical placement decodes and re-encodes byte-identically. The canonical order is `size` when it is not `full`, then `decorative` when it is true, then every preserved unknown entry in its original relative order. `size=full` is omitted, and a false `decorative` is omitted.
- **Escaping is part of the format, in both the caption and the values.** `\` is written `\\`, `"` is written `\"`, and a literal `[caotang-image ` in the caption is written `\[caotang-image `; the decoder reverses exactly those three escapes. A caption that literally ends in a marker-like string therefore round-trips as a caption, never as metadata.
- **Decoding is right to left and conservative.** Only an **unescaped** suffix at the end of the title with a version this build knows is decoded. An unknown version (`v2`, `v99`) is **preserved verbatim**: the title keeps every byte, the placement is treated as uncaptioned metadata this build does not interpret, the caption for export is the whole title as written, and the next save writes it back unchanged. An unbalanced escape, a missing `]` or a key without `=` is likewise left whole as the caption, with one load note: never guess.
- **Export reads the decoded caption, with one explicit exception.** The suffix is metadata, never caption text: the EPUB `figcaption`, the DOCX caption paragraph, the Markdown title and the plain-text `[Picture: …]` line all carry the decoded caption. **The exception is an unknown suffix version:** this build cannot decode it, so the whole title is preserved verbatim — the Markdown export keeps that title byte for byte, every other format prints the whole title as written — and the compile log names the placement.
- **Markdown export rewrites the image construct only.** The image construct is the only part of a Markdown body that export rewrites: its destination becomes `<name>.assets/a_….png` and its title becomes the decoded caption, with the title omitted entirely whenever the decoded caption is empty, whatever the size hint or decorative flag (metadata is never exported); an unknown suffix version cannot be decoded, so the Markdown export keeps that title byte for byte (§2.2.1). Every other byte of the body is preserved exactly. The editor's opacity guarantee is about the project body, not the exported file (§4).
- **The editor writes the suffix; hand-edited bodies are read.** The placement popover (B1) encodes the title on every change, so a writer who never types the marker still gets escaping. The codec is a pure module in `packages/pictures`, used by the editor, the exporter and the body scan, so all three agree on what the caption is.
- **Fixtures are pinned before the editor changes:** caption only (byte-identical round trip); a caption with `"`, `\` and a literal `[caotang-image v1;size=half]`; a decorative-only placement with an empty caption; `size=half`; both keys; `v2` preserved and re-saved unchanged; an unbalanced suffix left as caption; a legacy body with no suffix unchanged; export of each taking the decoded caption and never the metadata; a suffix in the **alt** slot is not metadata (the alt slot is never parsed for the suffix). **Determinism fixtures:** an empty caption encodes as `[caotang-image v1;…]` with no leading space; a bare `decorative`; an unknown key and an out-of-domain value kept verbatim after the known entries in their original relative order; the canonical key order (`size`, then `decorative`); a canonical placement decoding and re-encoding byte-identically; the unknown-version exception on export (whole title kept, compile log naming it). **Markdown export fixtures:** a body with `"caption [caotang-image v1;size=half]"` exports with title `caption`, its destination rewritten to `<name>.assets/a_….png`, and every unrelated Markdown byte identical; a captionless `size=half` export writes no title; a captionless placement with a default suffix exports with no title; an unknown `v2` title is preserved whole.

### 2.3 Paragraph anchors: map through the edit, then verify

The editor has no block identity and in-prose markers are rejected (edit-anchors §1). A paragraph anchor is a `TextAnchor` over the paragraph's text: `exact` is the block's first ≤ 200 characters, prefix and suffix of 32, the capture revision, plus `blockHash` (FNV of the normalised paragraph) and `ordinal` as tie-breakers. It snaps to the containing top-level block (blank-line split of the body projection).

**One body-write boundary, not the current `captureBody`.** Today's `captureBody` in `packages/store/src/commands.ts` is called by every body write and holds **the old body and its revision only**; it is a snapshot sink, and the new body is not available there. P9 introduces an explicit **old/new body-write boundary** — one function every body mutation and recovery goes through, carrying `{docId, oldBody, newBody, revision, priorLinks}` — and the store captures that document's links **independently** of the snapshot sink, so one undo restores body and links together. A recovery that replaces a body (a pending-journal put-back, an encoding conversion, a snapshot restore, an external-write adoption) passes the same boundary and captures the same prior links. Follow-through happens in the same command:

1. `diffs = diff_main(old, new)`, semantically cleaned, computed once per write. Each link's `[start, end)` maps through `diff_xIndex`.
2. **Verify.** The mapped block's text must score ≥ `FUZZY_SIMILARITY_FLOOR` against the captured `exact`, or the mapped range must overlap surviving characters of the old block. On success the anchor is rewritten (offsets, `exact`, prefix, suffix, `capturedRevision`).
3. **Deleted region.** When the old block's characters are all gone, try the ladder once, with two extra guards: it refuses when the runner-up scores within 0.05 of the best, and any non-`exact` result sets `moved: true` ("moved, please confirm"; cleared on confirm or *Re-pin*). Otherwise the link is marked `orphaned`, kept and listed, never dropped and never guessed.
4. **Edits made outside the app** (a folder change, a reload without an old body) start at step 3.

The store cannot import `@caotang/editor`, so the resolver is injected as an `AnchorPort` on `ProjectCommandOptions` (the `ShotCommandPort` pattern). Its one operation takes the document id, the old body, the new body, the revision and **that document's links**, and returns the mapped links plus explicit `orphaned` and `moved` outcomes — never a silently dropped link. The store keeps the prior links for undo; the port never mutates state. `diff_main` runs with `Diff_Timeout`; a timeout falls back to step 3. Cost: one diff per write, only for documents that have paragraph links. While a document is open, a ProseMirror decoration mapped by `mapping` shows a margin pin; that is view state only.

Fixtures: paragraph edited in place, moved, split, deleted (→ orphaned), whole-document agent rewrite, **parallel lookalike paragraphs** (the #7571 witness), a **repeated sentence start**, and an **external rewrite**. Landing in the wrong paragraph fails the build; orphaning instead passes.

### 2.4 Commands (`packages/bus/src/descriptors-pictures.ts`, `packages/store/src/commands-pictures.ts`)

| Command | agentRisk / undo | Notes |
|---|---|---|
| `asset.import {stagingId, links?: AssetTarget[], caption?, alt?, source?, largePhotos?}` | write-confirm · compensable: undo removes record and links, **the file stays** | Runs the import pipeline (§6.4). Hash first; a match returns the existing id. `project.importAsset` and `shot.importImage(s)` are re-implemented on it, keeping their names and params. **This is the staging consumer, registered explicitly:** the host stages the bytes and names them, the command never takes bytes as params, and the harness tool `pictures.import` (§8.1) maps onto this command under its own stable tool name (as `notes.replace` maps onto `notes.set`). An unknown or already-consumed staging id is refused as not-found and nothing is written. |
| `asset.importBatch {items[], largePhotos?}` | write-confirm · compensable, one undo group | All-or-nothing, as `shot.importImages`. The large-photo prompt is asked once per batch. |
| `asset.setMeta {assetId, patch, expect?}` | write-auto · compensable | caption, alt, decorative, tags, source label. |
| `asset.transcribe {into, pages, title?}` | write-confirm · compensable, one undo group | Publishes the reviewed pages of §8.4. Each of 1–100 pages is `{assetId, text, model?, expect}`, where `expect` is the complete current `AssetRecord.transcription` or `null`; a repeated asset or changed expectation refuses the whole batch. `into: 'searchable'` stores the text on the records and creates no document. `into: 'new-document'` creates one Research document from the pages in order, adds each page's `source` paragraph link and points its record's transcription back to that document and anchor; `title` is optional and otherwise comes from the first line. One undo restores the document, links and records together. |
| `asset.setLinkMeta {linkId, patch, expect?}` | write-auto · compensable | A placement's `note`, apart from the record. |
| `asset.link {assetId, target, role?, note?}` / `asset.unlink {linkId}` / `asset.reorderLinks {target, orderedIds}` / `asset.repin` / `asset.makeDocumentLevel {linkId}` | write-auto · compensable | `repin` re-captures an orphaned or moved paragraph anchor from a selection. `makeDocumentLevel` is the lost-paragraph view's compound move to the binder item, with one compensation for the whole gesture. |
| `asset.relink {pairs[]}` | write-auto · inverse | Load-time "renamed outside Caotang" re-link (§6.3), one batch. |
| `asset.delete {assetId}` | write-confirm · compensable | Removes record and links; the file stays until the sweep. Refused while a typed use exists, with the uses listed. |
| `asset.sweep` | **confirm, not undoable** (destructive class) | Deletes files with no record and no use that no **retention root** still references — the complete inventory is §6.6.1, not only cover, shot, codex and live links. An incomplete or unknown root refuses the sweep. Writer-confirmed, and **not a model tool**: no harness row exists for it. |

Each command starts in command-bus §9 and lands with its row; `test/registry.test.ts` holds the parity. Command-bus §9 tabulates every command above and `asset.storeWorkingCopies`; all are built. The permission gate reads the risk classes unchanged ([agent-harness.md](agent-harness.md) §4): a `write-auto` tool rides a native card, which *Auto* approves, *Accept edits* approves only when every write row is in `ACCEPT_EDITS_TOOLS`, and *Plan only* refuses; a `write-confirm` tool needs the approved plan or a confirm card. **The write-auto picture tools are in `ACCEPT_EDITS_TOOLS`** (`pictures.annotate`, `pictures.attach`), so *Accept edits* approves them as shown; `pictures.import` (its command is write-confirm, because the writer chose the file), `pictures.place` and `pictures.transcribe` are `write-confirm` and not in the list, so *Accept edits* asks for them and *Auto* approves them as native cards. A delegated agent may stage a picture step, never apply it. `pictures.place` maps onto the existing, never-exposed `editor.insert` primitive rather than a new bus command; it is `write-confirm`, and its undo is the containing document's body snapshot in the same group. `asset.sweep` is the destructive class: confirm, not undoable, no tool.

## 3. Inline pictures in prose

**Stored spelling (portable Markdown, D5):** `![alt](../assets/a_XXXXXXXXXX.png "caption")` in `docs/<id>.md`. It renders in Obsidian, VS Code and GitHub from the folder as-is, and the editor schema already round-trips it losslessly. Pictures are block-level by convention (a paragraph holding only the image); an image inside a sentence is tolerated and exported as a block figure. A `src` outside `../assets/` is kept and exported as alt text with a log line; a hand-written `http` image gets a "Download into project" action, which saves bytes (A6). A decoration flag or a size hint (full width, half, inline) is stored in the title only when it is not the default, through the **versioned, escaped title suffix of §2.2.1**, so a caption-only body stays exactly as written and a caption containing marker-like text, quotes or backslashes still round-trips.

Pandoc users need `--resource-path=docs` or `+rebase_relative_paths` to compile the folder's own `docs/` bodies; exported Markdown (§4) needs nothing.

## 4. Export

One transcoder path (the `PictureTranscoder` port) with per-target profiles. All sizes are in pixels; DPI metadata is ignored. Every renderer reads bytes through the host's `readAsset` and the pre-listed `assetRecordsOf(fs)`, so the desktop and the MCP server compile the same book. A missing file degrades to the caption, named in the compile log. EXIF is stripped on export as defence in depth (originals imported before the import strip may carry GPS); a recipe option keeps it. **A profile the compiling host cannot run is refused with a remedy (§6.4.1), never passed through unscaled or unconverted**, and every caption a format prints is the **decoded** caption of §2.2.1, never the suffix.

| Format | Behaviour | Code |
|---|---|---|
| **EPUB 3.3** | `OEBPS/images/<file>` manifest items; `<figure><img alt/><figcaption>`. WebP → JPEG (q 85), or PNG when the source has alpha or is lossless. Alpha flattened onto white. sRGB. Long edge ≤ **1600 px** by default (`epubImageMaxPx` recipe option), never upscaled. Opt-in "keep WebP (Apple Books only)". The cover takes the same transcode, but capped at **2560 px** on its long edge rather than 1600: a retail cover is 1600 × 2560 (epub-metadata.md), so the figure limit would downscale every printable cover to a 1600 px long edge and push its short side under the 1400 px minimum the compile log warns about. The compile log prints the book's image weight and the five heaviest pictures, and warns on missing alt. | `prose.ts` (a `figure` block replaces `case 'image'` → text), `render-epub.ts`, `picture-profile.ts` |
| **DOCX** | `ImageRun` sized by extent: width = min(text width, natural width at 300 ppi); pixels capped at 2× text width at 300 ppi. WebP → JPEG or PNG as in EPUB. Caption in the Caption style; alt in `docPr descr`. | `render-docx.ts` |
| **Markdown** | The body's Markdown is **preserved**: only the image construct (destination and title) changes; every other body byte is preserved. Each image's destination becomes `<name>.assets/a_….png` (from `../assets/a_….png`), and the used files are copied to `exports/<name>.assets/`; no `..`, so it is pandoc-safe. Its title becomes the **decoded** caption (§2.2.1), and the title is omitted entirely whenever the decoded caption is empty, whatever the size hint or decorative flag (metadata is never exported); an unknown suffix version cannot be decoded, so that title is preserved verbatim and the compile log names it. Emphasis, links, code and spacing are written as the writer wrote them; this is not the alt-text reduction the other prose formats apply. Recipe option `pictures: 'copy' \| 'link' \| 'drop'`, default `copy`. `png\|jpe?g\|webp` join **both** `isBinaryPath` regexes. | `render-text.ts`, `emit.ts`, `exports.ts` |
| **Plain text** | One line, `[Picture: caption]`; option `pictures: 'placeholder' \| 'drop'`. | `render-text.ts` |
| **PDF** | There is no prose PDF. Pictures reach PDF through the comic PDF ([comics.md](comics.md) §5) or a future prose PDF; the CHANGELOG "Known limits" says so when the export work lands. | none |
| Fountain / FDX / Ink | Pictures in those bodies are not exported. | none |

## 5. UI surfaces

- **Inspector › Pictures** (`InspectorSections.tsx`): a thumbnail strip of the selected node's links, with drop, paste and *Choose files…*; caption, alt, tags, *Make card picture*, "Used in" chips, *Open on board*. With an editor selection, *Attach to this paragraph* captures the anchor. A **"Lost their paragraph"** list shows orphaned links with the captured quote struck through, *Re-pin* and *Make document-level*; `moved` links carry a small "confirm" chip. *Make document-level* is one undoable compound command, including when it merges with an existing placement on the item.
- **Picture board** (`apps/desktop/src/media/PictureBoard.tsx`, a peer of `StoryboardView.tsx`): the project gallery, grid S/M/L like the corkboard, filters (transcription text, tag, attached to, unused, has transcription, source, lost their paragraph), multi-select batch tag and link, the `ShotLightbox.tsx` lightbox. Opened from the binder's Research root ("Pictures") and the project panel. A **size meter** shows each picture's bytes and pixels, the project total and its largest ten, with *Store working copies* as a bulk action. A free-form spatial moodboard is parked.
- **Inline in the editor:** an image NodeView resolves `../assets/a_….png` to a `blob:` URL from `ProjectAssets`; drop, paste and an *Insert picture* toolbar and slash item; a placement popover (alt, caption, decorative, size hint); a broken-picture chip when the file is missing.
- **Corkboard:** an index card shows its node's `role: 'card'` picture at M and L (S stays text). A drop on a card is `asset.link`.
- **Storyboard:** unchanged UX; "use an image already in the project" lists from the registry.
- **Codex panel:** `visualRefs` gain captions and the board's picker.

## 6. Storage

### 6.1 Limits

`COVER_MAX_BYTES` becomes `PICTURE_MAX_BYTES` (16 MB, unchanged), exported from `packages/pictures`. Formats are PNG, JPEG and WebP. **SVG is refused** (active content in EPUB and MCP). A project soft budget warns at 500 MB of assets in Settings › Data. `navigator.storage.persist()` and `estimate()` run at the first picture import.

### 6.2 Dedup by hash, and the backfill

`crypto.subtle.digest('SHA-256')` runs inside the async apply. A hash equal to a record's returns that id, writes no file and adds only the links. A hash equal to an unrecorded file on disk (left by an undone import) re-creates the record over it. Ids stay random; the hash is never the file name. On open, every listed `assets/` file used by cover, shots, `visualRefs` or an inline image gets a record (hash computed in idle time), written with the next save, the way `language` and `identifier` were back-filled.

### 6.3 Load-time reconciliation

A record whose file is missing, plus an unrecorded file with the same `sha256`, means the file was renamed outside the app: one batched "Re-link N renamed pictures" (`asset.relink`). The file may keep the stem it was renamed to (the bytes are the identity); a name another record already holds is refused. Never re-link by name similarity.

### 6.4 Import pipeline (inside the async apply, in order)

1. Sniff the leading bytes.
2. **HEIC:** decode where the browser can (`createImageBitmap`, Safari) and re-encode as JPEG q 0.9; otherwise refuse with "export as JPEG, or use the iPhone photo picker". No WASM decoder (CSP).
3. **Pixel budget:** decode with resize (`createImageBitmap(blob, {resizeWidth, imageOrientation: 'from-image'})`), so a full-size bitmap never exists; downscale in steps and check the output for blank pixels. Above 50 MP or 16 MB: refuse with a reason. Above **24 MP or 8 MB**: the batch prompt (once per batch, remembered per project) offers *Keep originals* or *Store 4096 px working copies* (D6); a working copy records the original's size in `workingCopy`.
4. **Private metadata:** remove the GPS IFD, maker notes and serial numbers from EXIF losslessly by segment rewrite (JPEG APP1, PNG `eXIf`, WebP `EXIF` chunk); Orientation and the colour profile stay (D2). **XMP and IPTC go whole:** the JPEG APP1 XMP packet and APP13 Photoshop block, the PNG `tEXt`, `zTXt` and `iTXt` chunks that carry XMP (`XML:com.adobe.xmp`) or a raw IPTC or XMP profile, and the WebP `XMP ` chunk (the RIFF size is rewritten and the VP8X flag cleared). A file whose metadata cannot be walked safely is refused, not stored.
5. Hash the bytes as stored, then dedup (§6.2).

`QuotaExceededError` keeps the file staged and offers *Attach a folder* or *Export a bundle*; nothing fails silently.

#### 6.4.1 The host capability matrix and its gate

`ProcessPicture` has two implementations, and they are **not** interchangeable. The matrix is the contract; a profile that asks for a cell a host does not have is **refused with a remedy before any file is written**.

| Operation | Browser (the app) | Node (SDK, CLI, MCP server) |
|---|---|---|
| Decode PNG / JPEG | `createImageBitmap` (canvas) | yes — `png-decode.ts` (`node:zlib`; every colour type, bit depth and Adam7) and `jpeg-js` 0.4.4 (baseline and progressive; CMYK refused) |
| Decode WebP | `createImageBitmap` (canvas) | yes, `@jsquash/webp` → RGBA (`webp_dec.wasm`, still images only) |
| Decode HEIC | Safari only, `createImageBitmap`; otherwise refuse | **no** — refuse |
| Resize / downscale | yes, `createImageBitmap` resize options or canvas | yes, area-average downscale after EXIF orientation 1–8; never upscales |
| Encode JPEG | yes, canvas `toBlob('image/jpeg')` | yes, `jpeg-js` |
| Encode PNG | yes, canvas `toBlob('image/png')` | yes, the small fflate PNG writer |
| Colour profile to sRGB | yes, `createImageBitmap` `colorSpaceConversion` | yes for grey and RGB matrix/TRC ICC profiles (Display P3, Adobe RGB and the like); a CMYK, lookup-table or unreadable profile is refused |
| Strip EXIF (GPS, maker notes, serials) | yes, pure segment rewrite | yes, the same pure module |
| Rasterise a comic page (canvas + `FontFace`) | yes | **no** (comics.md §5) |
| SVG input | refused (active content in EPUB and MCP) | refused |

- **Node's `ProcessPicture` is `processPictureInNode`** (`@caotang/exporter/picture-process-node`, a Node-only subpath, so `jpeg-js` never reaches the browser bundle). `transcodePictureInNode` stays the contact sheet's WebP→PNG path. Re-encoded output carries no metadata and no colour profile (it is sRGB); 16-bit channels are rounded to 8. A `preserve` profile with nothing to change returns the stored bytes with only the private metadata removed. The app's `processPictureInBrowser` writes and reads back a known pixel before drawing, so a dead canvas is refused while a genuinely white picture is kept.
- **The gate is a host object, not a runtime guess.** The composition root supplies `{ capabilities: ReadonlySet<PictureOperation>, process: ProcessPicture }`. The import command's `validate` refuses a profile whose operations are absent, naming "export the picture from the app"; the importer refuses an input whose decode is absent, naming "open the project in the app". A refused operation writes no file and releases whatever the host staged for it.
- **`pictures.view` on a host that cannot resize.** A host composed without the resize cell (the gate above) cannot downscale, so a view **sends the stored bytes unchanged when the picture is already within the host's image limit** (long edge ≤ 1568 px and the transport's message cap) and **refuses a larger one before sending anything**, naming its size and the remedy (open the project in the app, or import a working copy at or below the limit). It never claims to have downscaled, and §8.1's downscale sentence is the app's behaviour, not the server's.
- **A host saves only bytes it can inspect.** The pure sniff, the size and pixel caps, the hash and the EXIF segment rewrite run on every host. Decoding and re-encoding — the HEIC conversion and the working-copy downscale — run where the matrix says they do; in this build only the app stages picture bytes (a drop, a paste, or an MCP client's image block), and a Node host saves a staged file without re-encoding it rather than pretending to a decoder it lacks.

#### 6.4.2 Import reservation and retention ports (P1 and P8)

Today's `AssetStaging` in `packages/store/src/commands-project.ts` **consumes the bytes on `take`**, and `ProjectAssetPort` only writes. That is enough for one cover, and not enough for a retry or a sweep, so two ports are specified before the registry lands:

```ts
interface AssetReservation { id: string; items: readonly { stagingId: string; bytes: Uint8Array }[] }
interface RetryableAssetStaging {
  stage(bytes: Uint8Array): string;
  reserve(ids: readonly string[]): AssetReservation;   // keeps the bytes for a retry
  commit(id: string): void;                              // the record and file are written
  release(id: string): void;                             // back to the staging set, bytes held
  discard(ids: readonly string[]): void;                 // the writer or a refusal drops them
}
interface AssetRetentionSnapshot { authoritative: boolean; ids: ReadonlySet<string>; reasons: readonly string[] }
```

- `reserve` refuses an unknown or already-reserved id, and `commit` removes the id only after the record and the file are written. A `QuotaExceededError` mid-batch calls `release` and rethrows into the writer's remedies, so a retry never re-reads the original file and nothing is dropped silently.
- **Removal is a separate port from writing.** A writer-only port cannot answer "is this file safe to delete", so the sweep reads `listRetention(): Promise<AssetRetentionSnapshot>` and calls `remove(ids)`; `reasons` names the root per id.
- **A bulk working copy refuses an unknown reference shape, and a paragraph anchor is not one.** Before it writes anything, the batch probes a copy of the manifest for every field that still names the picture; a field outside the known ones (a cover, a shot's image and vendor references, a codex `visualRefs` entry, a comic panel, a link) refuses the whole batch. A link's `target.anchor` is **captured prose** (§2.3) — an image's Markdown in the sentence above a later paragraph appears in its `prefix` as text — so the probe does not descend into it: the body rewrite moves that paragraph and the anchor is recaptured from the new body. Without the exemption, a picture whose Markdown sat in one paragraph made every bulk working copy of it refuse.
- The cover and shot imports keep their names and params and move onto the same staging object when P1 lands; `take` stays only until they do.

### 6.5 Thumbnails, bundle, folder

- **Thumbnails** are derived and per-browser: a new `thumbs` object store in `caotang-assets` (`ASSET_DB_VERSION` 1 → 2, an upgrade that only adds a store), never in `caotang-app`, the folder or a bundle. They are generated in a worker with `createImageBitmap` resize options; a thumbnail that fails is regenerated once at half size, then shown as a placeholder.
- **A blank check separates a white picture from a broken decode.** A valid uniform-white picture — every sampled pixel near white, alpha opaque — is content and is kept; a decode or canvas failure — no bitmap, a zero-sized canvas, or pixels that cannot be read — is the failure the check reports. "It is white" is never evidence of failure, here or at §6.4 step 3.
- **Bundle:** the `zip.ts` `assets` option carries every file with a record or a use. Before an ordinary *Export bundle*, a preview offers *Export without removing*, *Remove them, then export*, or Cancel only when genuinely unreferenced files exist. A failed or refused preview never holds back a backup; a sweep that refuses or stops part-way blocks that removal-and-export path and still leaves export-without-removing available. Rescue exports never ask.
- **Folder save:** files are written at import time, the record at the next manifest save; a crash in between leaves an unrecorded file that §6.2 reclaims. The folder-change check in `lifecycle.ts saveFolder` extends to `assets/`: a hash mismatch asks whether to take the folder's version (updating `sha256` and `bytes`) or keep the browser's.

### 6.6 Eviction and Safari

The existing eviction banner (ui-modules §5.3) gets a picture-aware variant: when `persisted() === false`, no folder is attached and the project has pictures, it names folder attachment or a bundle as the next action. The sentence "Safari deletes site data after 7 days without a visit. Attach a folder, install Caotang to your Home Screen, or export a bundle." appears only on Safari; other browsers hear only what their storage API reported. Dismissal is per project in the app database under `picture-notices:<projectId>`, and the banner returns when picture bytes reach twice the dismissed amount. In browsers without `showDirectoryPicker`, *Export a bundle* is offered after the first 50 MB of pictures and every 30 days after a snooze; *Turn this reminder off* is persisted in the same per-project record. The eviction banner takes precedence, and removing a project forgets its notice record.

#### 6.6.1 The retention inventory a sweep must read

A picture file is safe to delete only when **every** root that can name it has been read and none does. The roots, in full — cover, shot, codex and live links are not the list, they are part of it:

1. **Typed uses:** `project.coverAssetId`, `tree[].shot.image`, `codex[].visualRefs`, every inline image parsed from every stored body, and a comic panel's `assetId`.
2. **Links:** every `assetLinks[]` entry, whatever its role or target, including an `orphaned` or `moved` paragraph link — an orphan is still the writer's link.
3. **Vendor references:** a shot prompt's `references[]` and the pictures a prompt pack names for a shot or a codex entry ([video-prompt-pack.md](video-prompt-pack.md) §6).
4. **Undo:** every open undo group's inverse or captured compensation in this tab, including a group whose command was refused after it captured.
5. **Checkpoints:** every retained body snapshot; a body is text, and a body can spell `../assets/a_….png`.
6. **Pending and editor history:** the pending journal (`caotang.pending.<projectId>`, editor-engine §9), the editor-history journal's base body, and the kept words of a stopped tab — each can hold an inline reference the project never saved.
7. **Retained snapshots and drafts:** a background task's held drafts and an open editor's ghost text, which can quote an image the writer has not placed yet; and the recovery offers a corrupted manifest's rebuild may still name.

- **The snapshot is authoritative or the sweep refuses.** A body the load could not decode, a folder listing that failed, an app-database store this build does not know, or a checkpoint read that threw makes `authoritative: false`; the sweep refuses whole, naming the root, and removes nothing. It never falls back to "delete what we could read".
- A complete snapshot that finds a file with no record and no use only *offers* it; `asset.sweep` is writer-confirmed and not undoable, removes files only (never records), and leaves every file with a record to `asset.delete` first.
- Fixtures: one file retained by each root above, then swept only when that root is removed; an unknown or failed root refuses the sweep and changes nothing; a genuinely unreferenced file is removed only after confirmation; a file named only by a checkpoint, a pending-journal body or a vendor prompt survives.

### 6.7 Hosted

`packages/remote-store` has no blobs. Pictures on the hosted instance need an encrypted blob store, content-addressed by the plaintext hash *inside* the encryption so dedup leaks nothing, with its quota stated up front. That belongs to the Hosted instance milestone ([hosted.md](hosted.md)), not to this one.

## 7. Gateway: vision input

`ChatMessage.content` widens to `string | ContentPart[]` (`{type: 'text', text} | {type: 'image', mime, bytes: Uint8Array, hash, size, caption?}`, with `mime` one of PNG, JPEG, GIF or WebP) in `packages/gateway/src/types.ts`, mapped per adapter: `openai-chat.ts` (`image_url` data URL), `openai-responses.ts` (`input_image`), `anthropic-messages.ts` (`image`, base64 source). Gated on `ModelCaps.vision`.

**A part is not only an adapter concern.** Every consumer that already reads message content must handle the widened type in the same change, or the image exists on the wire and nowhere else: **accounting** (a per-route image-token heuristic, never a text-character estimate), the **prompt preview**, the **conversation history and context layers** (a part is replayed on the next turn as the part it was, never flattened to a placeholder string), and **redaction** (the request log stores a hash and size, never the bytes; an error excerpt never carries one). The mock provider accepts parts and answers an image by its placeholder (`[image 1: image/png, 96 B, sha256:ab12cd34…]`), so an eval can read where the pictures sat; it takes images only when built with `capsVision`. The prompt preview is the one place a part is shown as its placeholder rather than replayed as the part: a preview is kept, so it carries each image's hash, size, type and caption (`PromptPreview.images`) and never the bytes. [provider-gateway.md](provider-gateway.md) §3 states the validation, limits and gate these consumers share.

## 8. Agent, MCP and handwriting

### 8.1 Harness tools

Rows in `packages/harness/src/metadata.ts`; agent-harness §10 and media-track §2 state the registry's current count and move together, and the combined count is read from the integrated registry after each addition, never predicted in a spec.

| Tool | Risk | What |
|---|---|---|
| `pictures.list` | read | Records, links and uses, filtered by target or tag; text only. |
| `pictures.view {assetIds ≤ 4, maxPx?}` | read | Image parts **only if** the active model has `vision`, otherwise caption and transcription with a note. In the app, downscaled to ≤ 1568 px on the long side through the resize-on-decode path; a host that cannot resize follows §6.4.1's view rule (within-limit bytes, or a refusal naming the size). |
| `pictures.import {stagingId, links?, caption?, alt?, source?}` | write-confirm | The staging-consumer tool of §2.4, mapped onto `asset.import`: it saves bytes the host staged — an MCP tool's image content block (§8.3), a drop or paste the app staged — and returns the record id. It cannot stage bytes itself and refuses an unknown or consumed id. |
| `pictures.annotate` | write-auto | caption, alt, tags, note; a batch of ≤ 50; inverse undo. |
| `pictures.attach` | write-auto | `asset.link` / `unlink`; a paragraph target takes a quote, resolved to an anchor at plan time. |
| `pictures.place {assetId, doc, anchor}` | write-confirm | Inserts an inline image at an anchored position via the existing, never-exposed `editor.insert` primitive — not a new bus command — with a ghost preview; its undo is the containing document's body snapshot in the same group. |
| `pictures.transcribe {assetIds[], into?, language?, secondRead?}` | write-confirm, model-backed | §8.4. `into` defaults to `new-document`; `secondRead` is an explicit `{profileId, model?}` route, never a silent repeat on the first. |

Every row's risk and undo are its command's (§2.4), except `pictures.place`, which composes the never-exposed `editor.insert` primitive as stated above. **The write-auto rows are in `ACCEPT_EDITS_TOOLS`** (`pictures.annotate`, `pictures.attach`), so *Accept edits* approves them as shown; `pictures.import`, `pictures.place` and `pictures.transcribe` are not in the list, so *Accept edits* asks for them, *Auto* approves them as native cards, and a delegated agent may stage them but never apply them. `asset.sweep` has no row here at all.

**What is built (P11): the five native rows and the two async ports** (`packages/harness/src/tools/pictures.ts`; the module exports its names, rows and definitions, and `metadata.ts` and `table.ts` join them).

- **Reads.** `pictures.list {target?, tag?, limit?}` is text only (no file name, hash or bytes): each picture with its caption, alt, tags, size, its placements (id, role, target by title, a paragraph by the quote it is pinned to, note) and its other uses, at most 100, cut at whole pictures under the row's cap with the left-out count in `notes`. `pictures.view {assetIds ≤ 4, maxPx ≤ 1,568}` is an **async port** wired where the host supplies a `PictureViewHost`: the host says whether the model has `vision`, reads the stored file, gives the transport's limits and, only when it can decode, resizes. With vision the images ride in a **user message after the tool result** (an image part is valid on no other role, and a tool result has no image channel): the port hands them to the host's outbox (`createPictureOutbox`), and the loop sends what the outbox holds for the turn in one user message after the turn's tool results (`pictureViewMessage`). The loop invokes a read-class async port through `callAsync` without a confirmation card and drains the outbox after both the native-wire tool messages and the JSON-wire results message; an unflushed turn's images are dropped with it. The desktop supplies the per-turn model's vision capability, reads through `ProjectAssets`, resizes through the browser decoder when it has one, and passes the same outbox to the picture host and `createAgentSession`. Without vision the answer is each picture's caption, alt text and transcription as text with a note that the model is not seeing the picture, and no file is read. A picture over `maxPx` is resized by a host that can, and the answer says "downscaled from W × H to w × h"; on a host that cannot it is sent as stored only when it is already within `maxPx` and the transport's byte limit, and otherwise the whole call is refused, before anything is sent, naming the size and the remedy (§6.4.1). The tool never says it shrank a picture it did not.
- **Writes.** `pictures.annotate {items ≤ 50}` maps an `a_` id onto `asset.setMeta` (caption, alt, decorative, tags; an empty string, an empty list or `false` clears) and an `l_` id onto `asset.setLinkMeta` (note); the whole batch is validated first, a repeated id is refused, and one Undo reverses it. `pictures.attach {attach ≤ 50, detach ≤ 50}` maps onto `asset.link` and `asset.unlink`, each op checked against the links the ops before it leave, so a batch that places a picture twice at one target is refused whole. A paragraph target is `{kind: 'paragraph', doc, anchor: <quote>}`: the quote is resolved at plan time against the document's body to the one paragraph it is the whole of, or else sits inside, and captured as the §2.3 anchor at the body's current revision. A quote that fits more than one paragraph is refused with the paragraphs it fits (`details.candidates`), never guessed.
- **Confirmed rows.** `pictures.import {stagingId, links?, caption?, alt?, source?}` is an **async port** over `asset.import`, run through the harness's `dispatchAsync` because that command awaits the host's file write; it has no parameter that could carry bytes, and an unknown or already-used staging id is the apply's `not-found`, with nothing written. `pictures.place {assetId, doc, anchor, position?, size?, revision?}` is a native tool whose one command is `editor.insert`, dispatched under the grant the tool gives it (`PreparedCommand.inherit: 'write-confirm'`, set by the tool's code and never by a caller), at the start or end of the quoted paragraph, writing `![alt](../assets/a_….png "caption")` with the §2.2.1 title. Its card shows a ghost (the paragraph, the Markdown to be written, the neighbouring paragraph). The call carries the revision it was prepared at as `expectedRevision`, so a document that changed between the card and the write is refused by the bus (`revision-conflict`) with nothing changed; a `revision` the caller names that is not the current one is refused before any card. A screenplay or a branching container has no inline pictures and is refused. The insert and the body snapshot are one undo group.

### 8.2 MCP server

Resource templates `caotang://asset/{id}` (a `blob` resource with its mimeType) and `caotang://assets` (the registry as JSON) in `resources.ts` / `uris.ts`. `pictures.list` and `pictures.view` (image content blocks) are listed in every mode; `pictures.annotate` and `pictures.attach` with `--allow-writes`. The server is a Node host whose only decoder is the contact-sheet WebP path above, so it does not resize: `pictures.view` sends a picture only when its stored bytes are already within the host's limits and refuses a larger one with its size and the import-a-smaller-copy remedy (§6.4.1). `pictures.transcribe` and `pictures.place` are not listed (model-backed or ghost-preview rows), and `pictures.import` is not listed either: its staging id names a host's staging area, and the MCP server has none. An import over MCP needs a size cap below the MCP message limits and the `.caotang-mcp.lock` folder rule.

**What is built (P12): the reads.** `pictures.list`, `pictures.view`, `caotang://assets` and `caotang://asset/{id}` are served, read-only, in every mode. `pictures.annotate` and `pictures.attach` are not listed yet: they wait for their harness rows (§8.1, C2), and a call for one is the SDK's "not found". Until those rows land, `pictures.list` and `pictures.view` are registered on the server itself, as `timeline.read` is (`packages/mcp-server/src/pictures.ts`), and the harness's mapping replaces the registration when the rows do.

- **One read port.** `packages/sdk/src/pictures.ts` (`@caotang/sdk/folder`) holds the reads: the registry as summaries (`pictureRegistryOf`), a list narrowed by `target` (`project` or a node id, a paragraph of the node counting) or `tag` with each picture's links and non-link uses (`pictureListOf`), and one file's bytes by asset id (`readPictureFile`). A file is named by its id and its record's type, never by a path: the id must be `a_` and ten characters, the record must exist, and a record whose `file` is not `<id>.<ext of its mime>` is refused as damaged and never read, so the manifest cannot point a read out of `assets/`. The folder port refuses a path that leaves the folder, or leads out through a link, on top of that. The bytes are sniffed and must be the record's type, and a file larger than the bound is refused (the record's own size first, so a refused picture is never read).
- **Limits.** One message carries at most `MESSAGE_MAX_BYTES` (4 MiB, the size of a request the server takes), and a picture goes as base64 inside it, so `PICTURE_MAX_SENT_BYTES` is the most whose base64 fits with 64 KiB left for the envelope: 3,096,576 bytes. A picture over it is refused before anything is sent, naming its size in bytes and the remedy (store a working copy in the app, or import a smaller copy); it never says it was shrunk. `pictures.view` also refuses a picture whose long edge (the header's size with EXIF orientation applied) is over 1,568 px, a picture whose size cannot be read, and a set whose bytes together are over the bound, and then sends none of the set. `maxPx` is accepted and not applied, and the answer says so. A refused read is a tool result with `isError`, or a `-32602` (an id that is not a picture, one the registry lacks, a missing file) or `-32600` (too large, wrong type, damaged record) on a resource.
- **Shapes.** A record is read as its id, type, bytes, pixels, caption, alt, tags, source, transcription, working-copy and time fields; the stored file name and the content hash are left out, and a paragraph link carries the quote it is pinned to in place of its whole anchor. `caotang://assets` is refused whole, never cut, over `RESOURCE_MAX_BYTES`, naming `pictures.list` and its filters. `pictures.list` is capped at about 8,000 tokens at whole pictures and says how many it left out.
- **Refresh.** Every project change refreshes `caotang://assets` (links follow the tree and the bodies), and an `asset.*` row refreshes every `caotang://asset/{id}` too; an import, a batch import or a delete also announces a changed list. The resource list orders the pictures after the codex entries.

### 8.3 MCP client: image content blocks (#145)

In `invoke.ts` (the routing is `images.ts`), an `image` content block from an external tool is **not** counted as text tokens and is not fed back verbatim. The bytes are staged and the model gets a stub (`[image 1: image/png, 812 KB, staged as stg_…]`). The writer, or a `pictures.import {stagingId}` step (write-confirm, §8.1 — the same row as `asset.import`, §2.4), saves it with `source: {kind: 'mcp', server, tool}`. Untrusted-content tainting applies to the stub; sniffing and the size cap apply to the bytes. Outbound, an external tool that wants a picture gets bytes from the staging area, never a filesystem path. This works over today's HTTP transport; stdio arrives with the desktop app and adds nothing here.

**What is built.**

- **Detected before the size calculation.** `applyMcpInvoke` routes the image blocks first, so what the 8,000-token cap measures (and `resultTokens`, which counts any image block as its stub and never its base64) is the answer with each picture already a stub. A block that is a picture is never counted as text, whichever host called.
- **The stub is exactly `[image N: <type>, <size> KB, staged as <id>]`.** `N` is one-based among the answer's images, the type is the one the **bytes** sniff to (`sniffPicture`: PNG, JPEG or WebP), the size is the decoded bytes in whole kilobytes (never fewer than 1), and the id is the project staging id the import takes (`stg_` and the random part the staging area mints; the `s_…` of the earlier sketch is the same id, not a second kind). It is a text block inside the untrusted result, so it is tainted with the rest. A host with no staging area wired still checks the bytes and writes `[image N: <type>, <size> KB, not staged: this host has nowhere to hold pictures]`; no host shows a model a picture as text. The result also carries `staged: [{stagingId, mime, bytes, index, expiresAt}]` for the app, with no bytes.
- **Checked as a whole, then staged.** Every block is counted, measured from its base64 length before it is decoded, decoded, sniffed and compared with the type it declared; only then is anything staged, so a refusal stages nothing. A block whose declared type differs from its bytes, an SVG or GIF or any other format a picture import refuses, a block with no data or type, and a string that is not base64 are each refused as `postcondition` and name the block, never the data. A staging failure refuses the answer and drops what it had staged.
- **Limits, per answer.** At most **4 images** (`EXTERNAL_IMAGE_COUNT_CAP`, the four a `pictures.view` shows at once) and at most **16 MiB decoded** across all of them (`EXTERNAL_IMAGE_BYTES_CAP`, `PICTURE_MAX_BYTES`, the size a picture import takes). Over either is refused as `limit-exceeded` with the cap named, like the token cap, and the message says the tool already ran on the server. The Streamable HTTP wire's own 16 MiB answer budget counts the base64, so a single answer reaches the wire's limit at about 12 MiB of picture before this cap does.
- **A bounded lifetime: ten minutes** (`STAGED_IMAGE_LIFETIME_MS`). Staged bytes are dropped ten minutes after they were staged, when the writer declines or cancels (`ImageStager.discard`), when the answer they came with is then refused over the token cap, and when the project closes (`releaseAll`, called by the session's `close`). An expired, discarded, unknown or consumed id is refused by `asset.import` as not found, and an id staged for another project is refused as another project's, both before anything is written. The stager forgets only what it staged; a drop or paste held in the same staging area is not touched.
- **Provenance is the stager's, not the model's.** `ImageStager.provenanceOf(stagingId)` answers `{kind: 'mcp', server, tool}` (the server's name and the tool's own name) for a held id from an external answer. `pictures.import` takes its `source` from it for such an id, whatever `source` a call carries, so a model cannot label a drop as a server's picture or a server's picture as a drop.
- **Outbound.** A tool argument whose whole value is `staged:<id>`, at any depth, is replaced by the base64 of those bytes at the call, after validation and after the writer's approval, so the card shows an id and not megabytes. An id that is not held (expired, another project's, mid-import) or references over the 16 MiB cap refuse the call before anything is sent. A path is never read and a URL is never fetched on the tool's behalf, and a string that merely starts with `staged:` is sent as written. The risk, the review pin and the permission modes are unchanged: the call is still the tool's effective risk.

### 8.4 Handwriting to text (#146)

`pictures.transcribe {assetIds[], into?: 'new-document' | 'searchable', language?, secondRead?: {profileId, model?}}`:

1. **Plan card, before a byte is sent:** page thumbnails, the output target and language hint, the real request schedule and its estimated cost. The primary route is the turn's Chat/Drafting model. The optional second read names another `{profileId, model?}` explicitly; both routes and both costs are shown. A primary or second route without `vision`, an unknown second route, or a second route identical to the first is refused up front with the setting remedy. Warnings name a non-English language hint and a selection over 20 pages; the review also cautions about historical handwriting without guessing a page's age.
2. **Prompt:** keep line breaks; mark illegible spans `[illegible]` and uncertain words `[?word?]`; do not modernise spelling; the project language or override is a hint; **the codex entry names and aliases are a vocabulary list** ("prefer these spellings when the ink supports them"). Requests ask for temperature 0, subject to the route's ordinary parameter support (no claim that every model accepts it). Up to 6 pages go in one request, or fewer when the route's image limit is lower; a failed batch falls back to page-by-page attempts, with no page duplicated or dropped.
3. **Review gate:** generated pages stay transient and `unreviewed` until the writer approves them. Each page's ghost shows image and text side by side and highlights `[?…?]`. Approval is per page and the selected pages publish as one undo group. The opt-in second read runs on its explicitly named route and highlights word-level disagreements; nothing is merged automatically. A re-transcription is a new ghost diffed against the approved text, never an overwrite of it.
4. **On approval (`new-document`, the default, D7):** one `asset.transcribe` command creates a document under Research (titled from the first non-empty line unless the review names one), with the selected pages in order as its body. Each page gets a `role: 'source'` paragraph link at the first paragraph of its own text, and its `AssetRecord.transcription` points back `{docId, anchor}`. The links survive edits through §2.3.
5. **`searchable`:** the same single command puts the text into `AssetRecord.transcription.text`, which project search indexes; no document is created.
6. **Guards and undo:** every reviewed page carries the complete transcription value the plan read, or `null`, as `expect`. A record changed while generation or review was open refuses the whole publication with `revision-conflict`. One undo restores the new document, source links and every prior record value together; a cancelled or failed generation/review dispatches nothing.

On-device OCR (Tesseract/ONNX) stays out: it needs `wasm-unsafe-eval` and is weaker on handwriting. #146 was filed as `feat(scan)`, but `@caotang/scan` is the continuity-scan package; it is retitled `feat(pictures): convert handwritten pages to text`.

## 9. Timeline and comics

- **Timeline:** the contract is `linksOf({kind: 'node', nodeId})`, the `role: 'card'` picture per node, `codex.visualRefs` for character pins, and `AssetLink.when` for a picture that marks a moment. [timeline.md](timeline.md) §9.1 owns `when`'s semantics and the timeline op that moves it. Neither feature blocks the other.
- **Comics:** panels reference registry records; the comic track is [comics.md](comics.md).

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Safari users lose pictures after 7 days away (IndexedDB only) | Medium | Eviction banner variant, bundle reminder, Home Screen hint (§6.6). |
| A paragraph link lands in the wrong paragraph | Low | Diff mapping, the runner-up guard, `moved`, lookalike fixtures (§2.3). |
| EPUB images render blank on Kobo or older readers | Low | Default transcode; a test asserts no `image/webp` manifest item by default. |
| GPS leaks through a pushed or zipped project folder | Medium | Strip at import (D2); keep the export strip. |
| Plausible but wrong transcription is trusted | Medium | Review gate, `[?word?]`, codex vocabulary, second read (§8.4). |
| A huge photo decodes blank on iOS < 18 | Medium | Resize on decode, blank check, pixel budget (§6.4). |
| HEIC dropped into Chrome or Firefox | High | A clear refusal with a remedy; `accept` without HEIC. |
| `diff_main` is slow on very large documents | Low | `Diff_Timeout` and the step-3 fallback; measured on the 100k-word fixture. |

## 11. Phased plan

Milestone **Pictures**, epic #148. Issues: A0 #151, A1 #152, A2 #153, A4 #154, A5 #155, A6 #156, B1 #157, B2 #158, B3 #159, A3 #160, C1 #161, C2 #162, C4 #163, C5 #164, C3 #146. Every feature issue updates USER-GUIDE, CHANGELOG (including "Known limits") and ROADMAP in the same pull request, because `test/not-in-this-build.test.ts` and `test/user-guide-claims.test.ts` pin them, and flips this spec's status line for what it builds. The minimal shippable slice is **A0, A1, A2, A4, B1, B2**: pictures everywhere, inline in prose, correct EPUB and DOCX. A3 (paragraph anchors) follows once that slice is in writers' hands (D1).

| # | Title | Scope | Done when | Needs |
|---|---|---|---|---|
| A0 | `docs(architecture): specify pictures and attachments` | This spec, ARCHITECTURE rows, decisions.md lines | Spec merged, decisions recorded | — |
| A1 | `feat(store): a picture registry with hashes, dedup and a backfill of existing images` | `assets[]`, `packages/pictures`, `asset.import(Batch)`, `asset.setMeta`, `alt`/`decorative`; the import pipeline (§6.4: HEIC, pixel budget, GPS strip, working-copy prompt); cover and shot imports re-based; backfill | Old projects open with a record for every used file; the same bytes imported twice write one file; GPS is gone from an imported JPEG with Orientation kept; cover and shot undo unchanged | A0 |
| A2 | `feat(store): link pictures to the project, a folder or a document` | `assetLinks[]` with project and node targets, link/unlink/reorder, the deleteNode cascade, `role: 'card'` | Links survive save, reload and bundle; delete plus undo restores them | A1 |
| A4 | `feat(pictures): a Pictures section in the Inspector and a project picture board` | Inspector section, `PictureBoard.tsx`, filters, lightbox, size meter, "Lost their paragraph" list | Upload, caption, alt, tag and link from both surfaces; e2e drop plus undo | A2 |
| A5 | `feat(corkboard): show each card's picture` | `Corkboard.tsx` M/L | The card picture shows and survives reorder | A2 |
| A6 | `feat(store): sweep unused picture files and show picture storage use` | `asset.sweep`, the retention inventory of §6.6.1 and its refusing snapshot, Settings › Data meter, `persist()`, thumbs store v2, rename reconciliation (§6.3), picture-aware eviction banner and bundle reminder (§6.6) | The sweep removes only files **no root in §6.6.1 names** — typed uses, links, vendor references, open undo groups, checkpoints, the pending and editor-history journals, retained snapshots and drafts — and refuses whole when a root cannot be read; the meter matches; a renamed file is offered for re-link | A1 |
| B1 | `feat(editor): insert, show and caption pictures in prose` | NodeView, `blob:` resolution, drop/paste/slash, placement popover, the `../assets/` spelling with title caption, the placement title-suffix codec and its fixtures (§2.2.1) | The round-trip corpus stays byte-identical, a caption with quotes, backslashes or marker-like text included; e2e insert → save → reload | A1 |
| B2 | `feat(export): carry inline pictures into EPUB and Word` | `figure` block, EPUB transcode/flatten/≤ 1600 px, figure and figcaption, DOCX extent sizing and transcode, compile-log image weight, export EXIF strip | An epubcheck-clean book with figures and no `image/webp` manifest item by default; a .docx that opens with images | B1 |
| B3 | `feat(export): Markdown with a pictures folder and a placeholder line in plain text` | `render-text.ts`, the `pictures` recipe option, **both** `isBinaryPath` regexes | Exported .md resolves every image from `exports/` | B1 |
| A3 | `feat(store): anchor pictures to a paragraph and keep the anchor through every body write` | Paragraph target, `AnchorPort`, the old/new body-write boundary of §2.3 (not today's `captureBody`) with prior-link capture on every mutation and recovery, the guarded ladder fallback, `orphaned`/`moved`, `asset.repin` | The eight drift fixtures pass (none lands in the wrong paragraph); one undo restores body and anchors; a recovery that replaces a body maps the same links | A2, B2 |
| C1 | `feat(gateway): image content parts for vision-capable models` | `ChatMessage` parts, three adapters, `vision` gating, mock, redaction | Recorded-provider tests per route; no bytes in the request log | — |
| C2 | `feat(harness): picture tools for the agent` | `pictures.list/view/annotate/attach/place`, registry rows and doc counts | Mock-provider evals; a non-vision model gets the text fallback | A3, C1 |
| C3 | `feat(pictures): convert handwritten pages to text` (#146) | `pictures.transcribe`, codex vocabulary, per-page review gate, second read, "searchable only", source links both ways | Three pages → a reviewable document, each page linked at its paragraph; Han and RTL fixtures; re-transcribe never overwrites approved text | A3, C1, C2 |
| C4 | `feat(mcp): serve project pictures as resources and image tool results` | `resources.ts`, `uris.ts`, tool listing | A host lists and renders a picture; writes need `--allow-writes` | A1 |
| C5 | `feat(mcp): save images that external tools return into project pictures` (part of #145) | `invoke.ts` image routing, staging, `source: 'mcp'`, taint | An HTTP test server's image block lands as a record after approval | A1, C2 |

The timeline's picture work is timeline T10 ([timeline.md](timeline.md) §11); the comic work is [comics.md](comics.md) §8.

## 12. Decisions

Recorded on 2026-10-23: the owner approved the recommended option of each decision. One-line versions are in [decisions.md](../decisions.md).

| # | Decision | Rejected alternative and why |
|---|---|---|
| D1 | **Paragraph-level attach uses true paragraph anchors**, mapped through the edit with strict orphaning (§2.3), shipped after the minimal slice. | Document-level links only, with inline placement standing in for "on a paragraph": loses a real need. Naive fuzzy re-search silently mis-anchors (B2); diff mapping avoids that cheaply. |
| D2 | **Strip the GPS IFD at import**, keeping Orientation, losslessly; the export strip stays as defence in depth. | Strip only on export: the folder itself is the shareable artifact, often zipped or pushed to git, and only some iOS paths strip GPS (E5). |
| D3 | **EPUB transcodes WebP and downscales to ≤ 1600 px by default**; keep-WebP is opt-in. | Pass WebP through as an EPUB 3.3 core type: Kobo renders it blank (C1). |
| D4 | **The registry lives in `caotang.json`** (`assets[]`, `assetLinks[]`): the recovery ladder and undo come for free; ~300 bytes per record. | A `pictures.json` sidecar: smaller manifest and cleaner diffs, but a second recovery and undo path. |
| D5 | **Inline spelling is portable Markdown**, `![alt](../assets/a_….png "caption")`, with the pandoc caveat documented. | `asset:` ids: rename-proof but opaque to every other tool. |
| D6 | **Large photos (> 24 MP or 8 MB) get a once-per-batch prompt**: keep originals or store 4096 px working copies. | Always keep (bloat, A1) or always downscale (references sometimes need detail). |
| D7 | **Handwriting lands as a new document under Research** with per-page review, plus a "searchable only" mode. | Insert at the cursor, or the picture's note: neither gives a reviewable, linked source. |
| D8 | **Pictures are a registry plus a board**, not binder items. | Scrivener-style `picture` nodes: reuse the tree, but put every sketch in it, which is Scrivener's own bloat story. |

The comic decisions (D9–D12) are in [comics.md](comics.md) §9.

## 13. Sources

**Writing tools:** literatureandlatte.com/blog/use-bookmarks-in-scrivener-projects-to-link-to-internal-and-external-files · forum.literatureandlatte.com/t/bug-epub-compile-option-downscale-and-resample-image-to-visible-size-not-working/133672 · help.ulysses.app/en_US/dive-into-editing/images-and-sketches · vellum.pub/specs/ · forum.obsidian.md/t/auto-update-links-for-files-moved-while-obsidian-is-closed/91670 · developers.notion.com/reference/file-object · worldanvil.com/faq · github.com/jgm/pandoc/issues/8099
**Anchoring:** github.com/hypothesis/client/issues/7571 · web.hypothes.is/blog/showing-orphaned-annotations/ · github.com/yjs/y-prosemirror/issues/204 · github.com/googleworkspace/cli/issues/169
**Exports:** kdp.amazon.com/en_US/help/topic/G75V4YX5X8GRGXWV · github.com/kobolabs/epub-spec/issues/74 · github.com/w3c/epubcheck/issues/1484 · office-watch.com/2024/webp-support-has-now-been-added-to-microsoft-office
**Browser and photos:** webkit.org/blog/14403/updates-to-storage-policy · developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria · caniuse.com/heif · bugs.webkit.org/show_bug.cgi?id=267277 · bugs.webkit.org/show_bug.cgi?id=257534 · lionpuro.com/posts/canvas-is-finally-usable-on-safari/
**Handwriting:** arxiv.org/abs/2503.15195 · arxiv.org/html/2502.20295v3 · goodnotes.com/blog/machine-learning-engineer-handwriting-recognition · rocketbookhelp.zendesk.com/hc/en-us/articles/360006723533
