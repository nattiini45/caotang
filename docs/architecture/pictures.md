# Pictures and attachments — one picture registry, links, inline pictures in prose

> Status: **specified, not built.** Nothing in this spec runs in the current build; the decisions in §12 bind the work when it is cut. What exists today is listed in §0, and only that is built. The comic-book track that shares this registry is its own spec, [comics.md](comics.md).
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
| MCP client | `packages/mcp-client/src/invoke.ts` | Image content blocks are returned to the model as text. |
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
| `asset.import {stagingId, links?: AssetTarget[], caption?, alt?, source?}` | write-auto · undo removes record and links, **the file stays** | Runs the import pipeline (§6.4). Hash first; a match returns the existing id. `project.importAsset` and `shot.importImage(s)` are re-implemented on it, keeping their names and params. **This is the staging consumer, registered explicitly:** the host stages the bytes and names them, the command never takes bytes as params, and the harness tool `pictures.import` (§8.1) maps onto this command under its own stable tool name (as `notes.replace` maps onto `notes.set`). An unknown or already-consumed staging id is refused as not-found and nothing is written. |
| `asset.importBatch {items[]}` | write-auto · one undo group | All-or-nothing, as `shot.importImages`. The large-photo prompt is asked once per batch. |
| `asset.setMeta {assetId, patch, expect}` | write-auto · inverse | caption, alt, decorative, tags, note, source label. |
| `asset.link` / `asset.unlink` / `asset.reorderLinks` / `asset.repin` | write-auto · inverse | `repin` re-captures an orphaned or moved paragraph anchor from a selection. |
| `asset.relink {pairs[]}` | write-auto · inverse | Load-time "renamed outside Caotang" re-link (§6.3), one batch. |
| `asset.delete {assetId}` | write-confirm · compensate | Removes record and links; the file stays until the sweep. Refused while a typed use exists, with the uses listed. |
| `asset.sweep` | **confirm, not undoable** (destructive class) | Deletes files with no record and no use that no **retention root** still references — the complete inventory is §6.6.1, not only cover, shot, codex and live links. An incomplete or unknown root refuses the sweep. Writer-confirmed, and **not a model tool**: no harness row exists for it. |

Each command starts in command-bus §9 and lands with its row; `test/registry.test.ts` holds the parity. Until then this table is the owning contract: command-bus §9 keeps its 51 built names and gains these rows when their commands land. The permission gate reads the risk classes unchanged ([agent-harness.md](agent-harness.md) §4): a `write-auto` tool rides a native card, which *Auto* approves, *Accept edits* approves only when every write row is in `ACCEPT_EDITS_TOOLS`, and *Plan only* refuses; a `write-confirm` tool needs the approved plan or a confirm card. **The write-auto picture tools join `ACCEPT_EDITS_TOOLS` when they land** (`pictures.import`, `pictures.annotate`, `pictures.attach`), so *Accept edits* approves them as shown; `pictures.place` and `pictures.transcribe` are `write-confirm` and not in the list, so *Accept edits* asks for them and *Auto* approves them as native cards. A delegated agent may stage a picture step, never apply it. `pictures.place` maps onto the existing, never-exposed `editor.insert` primitive rather than a new bus command; it is `write-confirm`, and its undo is the containing document's body snapshot in the same group. `asset.sweep` is the destructive class: confirm, not undoable, no tool.

## 3. Inline pictures in prose

**Stored spelling (portable Markdown, D5):** `![alt](../assets/a_XXXXXXXXXX.png "caption")` in `docs/<id>.md`. It renders in Obsidian, VS Code and GitHub from the folder as-is, and the editor schema already round-trips it losslessly. Pictures are block-level by convention (a paragraph holding only the image); an image inside a sentence is tolerated and exported as a block figure. A `src` outside `../assets/` is kept and exported as alt text with a log line; a hand-written `http` image gets a "Download into project" action, which saves bytes (A6). A decoration flag or a size hint (full width, half, inline) is stored in the title only when it is not the default, through the **versioned, escaped title suffix of §2.2.1**, so a caption-only body stays exactly as written and a caption containing marker-like text, quotes or backslashes still round-trips.

Pandoc users need `--resource-path=docs` or `+rebase_relative_paths` to compile the folder's own `docs/` bodies; exported Markdown (§4) needs nothing.

## 4. Export

One transcoder path (the `PictureTranscoder` port) with per-target profiles. All sizes are in pixels; DPI metadata is ignored. Every renderer reads bytes through the host's `readAsset` and the pre-listed `assetRecordsOf(fs)`, so the desktop and the MCP server compile the same book. A missing file degrades to the caption, named in the compile log. EXIF is stripped on export as defence in depth (originals imported before the import strip may carry GPS); a recipe option keeps it. **A profile the compiling host cannot run is refused with a remedy (§6.4.1), never passed through unscaled or unconverted**, and every caption a format prints is the **decoded** caption of §2.2.1, never the suffix.

| Format | Behaviour | Code |
|---|---|---|
| **EPUB 3.3** | `OEBPS/images/<file>` manifest items; `<figure><img alt/><figcaption>`. WebP → JPEG (q 85), or PNG when the source has alpha or is lossless. Alpha flattened onto white. sRGB. Long edge ≤ **1600 px** by default (`epubImageMaxPx` recipe option), never upscaled. Opt-in "keep WebP (Apple Books only)". The cover takes the same transcode. The compile log prints the book's image weight and the five heaviest pictures, and warns on missing alt. | `prose.ts` (a `figure` block replaces `case 'image'` → text), `render-epub.ts` |
| **DOCX** | `ImageRun` sized by extent: width = min(text width, natural width at 300 ppi); pixels capped at 2× text width at 300 ppi. WebP → JPEG or PNG as in EPUB. Caption in the Caption style; alt in `docPr descr`. | `render-docx.ts` |
| **Markdown** | The body's Markdown is **preserved**: only the image construct (destination and title) changes; every other body byte is preserved. Each image's destination becomes `<name>.assets/a_….png` (from `../assets/a_….png`), and the used files are copied to `exports/<name>.assets/`; no `..`, so it is pandoc-safe. Its title becomes the **decoded** caption (§2.2.1), and the title is omitted entirely whenever the decoded caption is empty, whatever the size hint or decorative flag (metadata is never exported); an unknown suffix version cannot be decoded, so that title is preserved verbatim and the compile log names it. Emphasis, links, code and spacing are written as the writer wrote them; this is not the alt-text reduction the other prose formats apply. Recipe option `pictures: 'copy' \| 'link' \| 'drop'`, default `copy`. `png\|jpe?g\|webp` join **both** `isBinaryPath` regexes. | `render-text.ts`, `emit.ts`, `exports.ts` |
| **Plain text** | One line, `[Picture: caption]`; option `pictures: 'placeholder' \| 'drop'`. | `render-text.ts` |
| **PDF** | There is no prose PDF. Pictures reach PDF through the comic PDF ([comics.md](comics.md) §5) or a future prose PDF; the CHANGELOG "Known limits" says so when the export work lands. | none |
| Fountain / FDX / Ink | Pictures in those bodies are not exported. | none |

## 5. UI surfaces

- **Inspector › Pictures** (`InspectorSections.tsx`): a thumbnail strip of the selected node's links, with drop, paste and *Choose files…*; caption, alt, tags, *Make card picture*, "Used in" chips, *Open on board*. With an editor selection, *Attach to this paragraph* captures the anchor. A **"Lost their paragraph"** list shows orphaned links with the captured quote struck through, *Re-pin* and *Make document-level*; `moved` links carry a small "confirm" chip.
- **Picture board** (`apps/desktop/src/media/PictureBoard.tsx`, a peer of `StoryboardView.tsx`): the project gallery, grid S/M/L like the corkboard, filters (tag, attached to, unused, has transcription, source, lost their paragraph), multi-select batch tag and link, the `ShotLightbox.tsx` lightbox. Opened from the binder's Research root ("Pictures") and the project panel. A **size meter** shows each picture's bytes and pixels, the project total and its largest ten, with *Store working copies* as a bulk action. A free-form spatial moodboard is parked.
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

A record whose file is missing, plus an unrecorded file with the same `sha256`, means the file was renamed outside the app: one batched "Re-link N renamed pictures" (`asset.relink`). Never re-link by name similarity.

### 6.4 Import pipeline (inside the async apply, in order)

1. Sniff the leading bytes.
2. **HEIC:** decode where the browser can (`createImageBitmap`, Safari) and re-encode as JPEG q 0.9; otherwise refuse with "export as JPEG, or use the iPhone photo picker". No WASM decoder (CSP).
3. **Pixel budget:** decode with resize (`createImageBitmap(blob, {resizeWidth, imageOrientation: 'from-image'})`), so a full-size bitmap never exists; downscale in steps and check the output for blank pixels. Above 50 MP or 16 MB: refuse with a reason. Above **24 MP or 8 MB**: the batch prompt (once per batch, remembered per project) offers *Keep originals* or *Store 4096 px working copies* (D6); a working copy records the original's size in `workingCopy`.
4. **EXIF:** remove the GPS IFD, maker notes and serial numbers losslessly by segment rewrite (JPEG APP1, PNG `eXIf`, WebP `EXIF` chunk); Orientation and the colour profile stay (D2).
5. Hash the bytes as stored, then dedup (§6.2).

`QuotaExceededError` keeps the file staged and offers *Attach a folder* or *Export a bundle*; nothing fails silently.

#### 6.4.1 The host capability matrix and its gate

`ProcessPicture` has two implementations, and they are **not** interchangeable. The matrix is the contract; a profile that asks for a cell a host does not have is **refused with a remedy before any file is written**.

| Operation | Browser (the app) | Node (SDK, CLI, MCP server) |
|---|---|---|
| Decode PNG / JPEG | `createImageBitmap` (canvas) | **no** — the exporter embeds PNG/JPEG bytes without decoding them |
| Decode WebP | `createImageBitmap` (canvas) | yes, `@jsquash/webp` → RGBA (`webp_dec.wasm`, still images only) |
| Decode HEIC | Safari only, `createImageBitmap`; otherwise refuse | **no** — refuse |
| Resize / downscale | yes, `createImageBitmap` resize options or canvas | **no** |
| Encode JPEG | yes, canvas `toBlob('image/jpeg')` | **no** |
| Encode PNG | yes, canvas `toBlob('image/png')` | yes, the small fflate PNG writer — the WebP→PNG contact-sheet path only |
| Strip EXIF (GPS, maker notes, serials) | yes, pure segment rewrite | yes, the same pure module |
| Rasterise a comic page (canvas + `FontFace`) | yes | **no** (comics.md §5) |
| SVG input | refused (active content in EPUB and MCP) | refused |

- **The current Node transcoder is one row of this table, not a codec.** `packages/exporter/src/picture-transcoder-node.ts` decodes a still WebP to RGBA and writes a PNG scaled to the contact sheet's 300 dpi cap. It does not decode JPEG or PNG, resize those, or encode JPEG; naming it a generic transcoder would claim work the code does not do. P1 adds the gate beside it, and the Node implementation refuses every profile the matrix does not give it.
- **The gate is a host object, not a runtime guess.** The composition root supplies `{ capabilities: ReadonlySet<PictureOperation>, process: ProcessPicture }`. The import command's `validate` refuses a profile whose operations are absent, naming "export the picture from the app"; the importer refuses an input whose decode is absent, naming "open the project in the app". A refused operation writes no file and releases whatever the host staged for it.
- **`pictures.view` on a host with no decoder.** The MCP server and the SDK cannot decode or resize, so a view **sends the stored bytes unchanged when the picture is already within the host's image limit** (long edge ≤ 1568 px and the transport's message cap) and **refuses a larger one before sending anything**, naming its size and the remedy (open the project in the app, or import a working copy at or below the limit). It never claims to have downscaled, and §8.1's downscale sentence is the app's behaviour, not the server's.
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
- The cover and shot imports keep their names and params and move onto the same staging object when P1 lands; `take` stays only until they do.

### 6.5 Thumbnails, bundle, folder

- **Thumbnails** are derived and per-browser: a new `thumbs` object store in `caotang-assets` (`ASSET_DB_VERSION` 1 → 2, an upgrade that only adds a store), never in `caotang-app`, the folder or a bundle. They are generated in a worker with `createImageBitmap` resize options; a thumbnail that fails is regenerated once at half size, then shown as a placeholder.
- **A blank check separates a white picture from a broken decode.** A valid uniform-white picture — every sampled pixel near white, alpha opaque — is content and is kept; a decode or canvas failure — no bitmap, a zero-sized canvas, or pixels that cannot be read — is the failure the check reports. "It is white" is never evidence of failure, here or at §6.4 step 3.
- **Bundle:** the `zip.ts` `assets` option carries every file with a record or a use. The sweep is offered, never forced, before *Export bundle*.
- **Folder save:** files are written at import time, the record at the next manifest save; a crash in between leaves an unrecorded file that §6.2 reclaims. The folder-change check in `lifecycle.ts saveFolder` extends to `assets/`: a hash mismatch asks whether to take the folder's version (updating `sha256` and `bytes`) or keep the browser's.

### 6.6 Eviction and Safari

The existing eviction banner (ui-modules §5.3) gets a picture-aware variant: when `persisted() === false`, no folder is attached and the project has pictures, "Pictures are stored only in this browser. Safari deletes site data after 7 days without a visit. Attach a folder, install Caotang to your Home Screen, or export a bundle." Once per project, dismissible, shown again when picture bytes double. In browsers without `showDirectoryPicker`, *Export a bundle* is offered after the first 50 MB of pictures and monthly after that (dismissible, off with one click).

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

`ChatMessage.content` widens to `string | ContentPart[]` (`{type: 'text'} | {type: 'image', mime, data /* base64 */, detail?}`) in `packages/gateway/src/types.ts`, mapped per adapter: `openai-chat.ts` (`image_url` data URL), `openai-responses.ts` (`input_image`), `anthropic-messages.ts` (`image`, base64 source). Gated on `ModelCaps.vision`.

**A part is not only an adapter concern.** Every consumer that already reads message content must handle the widened type in the same change, or the image exists on the wire and nowhere else: **accounting** (a per-route image-token heuristic, never a text-character estimate), the **prompt preview**, the **conversation history and context layers** (a part is replayed on the next turn as the part it was, never flattened to a placeholder string), and **redaction** (the request log stores a hash and size, never the bytes; an error excerpt never carries one). The mock provider accepts parts and echoes a part count for evals.

## 8. Agent, MCP and handwriting

### 8.1 Harness tools

Rows in `packages/harness/src/metadata.ts`; agent-harness §10 and media-track §2 state the registry's current count and move together, and the combined count is read from the integrated registry after each addition, never predicted in a spec.

| Tool | Risk | What |
|---|---|---|
| `pictures.list` | read | Records, links and uses, filtered by target or tag; text only. |
| `pictures.view {assetIds ≤ 4, maxPx?}` | read | Image parts **only if** the active model has `vision`, otherwise caption and transcription with a note. In the app, downscaled to ≤ 1568 px on the long side through the resize-on-decode path; a host that cannot decode follows §6.4.1's view rule (within-limit bytes, or a refusal naming the size). |
| `pictures.import {stagingId, links?, caption?, alt?, source?}` | write-auto | The staging-consumer tool of §2.4, mapped onto `asset.import`: it saves bytes the host staged — an MCP tool's image content block (§8.3), a drop or paste the app staged — and returns the record id. It cannot stage bytes itself and refuses an unknown or consumed id. |
| `pictures.annotate` | write-auto | caption, alt, tags, note; a batch of ≤ 50; inverse undo. |
| `pictures.attach` | write-auto | `asset.link` / `unlink`; a paragraph target takes a quote, resolved to an anchor at plan time. |
| `pictures.place {assetId, doc, anchor}` | write-confirm | Inserts an inline image at an anchored position via the existing, never-exposed `editor.insert` primitive — not a new bus command — with a ghost preview; its undo is the containing document's body snapshot in the same group. |
| `pictures.transcribe` | write-confirm, model-backed | §8.4. |

Every row's risk and undo are its command's (§2.4), except `pictures.place`, which composes the never-exposed `editor.insert` primitive as stated above. **The write-auto rows join `ACCEPT_EDITS_TOOLS` when they land** (`pictures.import`, `pictures.annotate`, `pictures.attach`), so *Accept edits* approves them as shown; `pictures.place` and `pictures.transcribe` are not in the list, so *Accept edits* asks for them, *Auto* approves them as native cards, and a delegated agent may stage them but never apply them. `asset.sweep` has no row here at all.

### 8.2 MCP server

Resource templates `caotang://asset/{id}` (a `blob` resource with its mimeType) and `caotang://assets` (the registry as JSON) in `resources.ts` / `uris.ts`. `pictures.list` and `pictures.view` (image content blocks) are listed in every mode; `pictures.annotate` and `pictures.attach` with `--allow-writes`. The server is a Node host and does not decode or resize: `pictures.view` sends a picture only when its stored bytes are already within the host's limits and refuses a larger one with its size and the import-a-smaller-copy remedy (§6.4.1). `pictures.transcribe` and `pictures.place` are not listed (model-backed or ghost-preview rows), and `pictures.import` is not listed either: its staging id names a host's staging area, and the MCP server has none. An import over MCP needs a size cap below the MCP message limits and the `.caotang-mcp.lock` folder rule.

### 8.3 MCP client: image content blocks (#145)

In `invoke.ts`, an `image` content block from an external tool is **not** counted as text tokens and is not fed back verbatim. The bytes are staged and the model gets a stub (`[image 1: image/png, 812 KB, staged as s_…]`). The writer, or a write-auto `pictures.import {stagingId}` step, saves it with `source: {kind: 'mcp', server, tool}`. Untrusted-content tainting applies to the stub; sniffing and the size cap apply to the bytes. Outbound, an external tool that wants a file gets bytes from `pictures.view`'s staging, never a filesystem path. This works over today's HTTP transport; stdio arrives with the desktop app and adds nothing here.

### 8.4 Handwriting to text (#146)

`pictures.transcribe {assetIds[], into: 'new-document' | 'searchable', language?, secondRead?}`:

1. **Plan card:** page thumbnails, an estimate (one vision call per page, ×2 with a second read), the target. Refused up front when the Drafting or Chat model lacks `vision`, naming the setting. Warnings when the project language is not English, the page looks archaic, or more than 20 pages are selected.
2. **Prompt:** keep line breaks; mark illegible spans `[illegible]` and uncertain words `[?word?]`; do not modernise spelling; the project language is a hint; **the codex entry names and aliases are a vocabulary list** ("prefer these spellings when the ink supports them"). Temperature 0. Up to 6 pages go in one request (shared context), with a page-by-page fallback when the route's image limit is lower.
3. **Review gate:** each page lands `unreviewed` in a ghost preview with the image and text side by side and `[?…?]` highlighted. Approval is per page, one undo group per approval batch. The opt-in **second read** runs the pages on another vision route and highlights word-level disagreements; nothing is merged automatically.
4. **On approval (`new-document`, the default, D7):** as one undo group, `binder.create` a document under Research (titled from the first line), the pages in order as its body; each page gets a `role: 'source'` paragraph link to its asset at the first paragraph of its text, and each `AssetRecord.transcription` points back `{docId, anchor}`. The links survive edits through §2.3.
5. **`searchable`:** the text goes into `AssetRecord.transcription.text` and is indexed by project search; no document is created.
6. **Re-transcribing** never overwrites approved edits: it lands as a new ghost, diffed against the approved text.

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
