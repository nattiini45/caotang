# Exporter — compile pipeline spec (v1)

> Status: built.
> Inputs: binder tree (project-format.md §2), document bodies, vocabulary. Output: assembled files. Design goal: **small, predictable, and always inspectable** — a per-block-kind template rather than a full compile matrix, and DOCX with semantic styles as a non-negotiable.

## 1. Responsibilities

- Compile a selected binder subset → single artifact in Markdown / plain TXT / DOCX.
- Template = the *thin* styling layer: title page, chapter headings, scene separators, front/back matter.
- Never mutates the project; writes only to `exports/` (or a user-chosen download).

## 2. Pipeline (4 stages, all inspectable)

```
select → flatten → render → emit
```

1. **Select** — `ExportSelection { includeRootIds: NodeId[], docFilter?: (doc) => boolean }`. Only nodes under Manuscript are eligible by default; Research requires explicit inclusion. Selection is a **recipe**: `ExportRecipe { name, includeRootIds, format, templateId, options }` — named recipes persist in the manifest (new top-level array `recipes[]`, same shape as vocabulary), so "paperback draft" vs "beta read" are one click. Default recipe auto-created per project.
2. **Flatten** — walk the tree depth-first in `order`; produce a linear list of blocks:
   ```
   { kind: 'frontmatter', fmKind: 'titlepage'|'copyright'|'custom', docId? }
   { kind: 'chapter', title, level }        // folder nodes
   { kind: 'scene',   docId, body, title }  // document nodes
   { kind: 'separator' }                     // between two consecutive scenes of the same chapter, or of the same loose run under the manuscript
   { kind: 'backmatter',  bmKind: 'about-author'|'custom', docId? }
   ```
   *(Front/back-matter blocks: v0.1 ships `titlepage` only, on by default — `{title}/{author}/{date}` template vars already cover it; `copyright` + custom front/back matter = recipe options with the same render path, land v0.2 unless trivial. Front/back matter blocks are rendered from template variables or a referenced doc's body — never stored as separate binder nodes, keeping the three-tier model intact.)* Empty documents are skipped **with a visible note in the compile log** ("skipped: Chapter 3 → The Call (empty)"). Scene-level text is the raw body; `***` thematic breaks inside a body are preserved as blocks.
3. **Render** — per format. Template variables: `{title}`, `{author}`, `{date}`, `{chapterTitle}`, `{chapterNumber}`, `{sceneNumber}`. Defaults: chapter → `## {chapterNumber}. {chapterTitle}` (MD), separator → `***` centered (DOCX: centered `* * *` — the yWriter/Scrivener convention), title page → `{title}` + `{author}` + `{date}` centered. **`{date}` is the writer's local calendar day** (`YYYY-MM-DD` in the zone the device runs in, the rule goals-progress.md states for "today"), not the UTC day, which is a different day for part of every day in most zones. The compile log's `at` and the EPUB's `dcterms:modified` stay UTC. **TOC policy:** MD = generated anchor list after the title page (optional, default on); DOCX = Word **TOC field** anchored on `Heading 1` chapter styles (optional, default on — Word regenerates it via F9; if the renderer can't emit a credible TOC field, ship without and note it in the compile log); TXT = none. **DOCX TOC mechanics:** the adopted recipe is `TableOfContents(alias, { hyperlink: true, headingStyleRange: '1-2' })` + `Document({ features: { updateFields: true } })` **plus `cachedEntries`** built from the binder chapter list, with a `section` scene's heading (§2, Per-scene styling) as a level-2 entry after its chapter — entries visible in every viewer *before* Word's field update (Word: on-open "update fields" prompt fires once and regenerates; LibreOffice never auto-updates fields and shows only the cached content — acceptable, the cached entries ARE the real content; Pages/Vellum import likewise read the cache), with `beginDirty: false` rejected (no prompt, but stale TOC) and a static TOC rejected (loses Word's field semantics) — see §7 E1.
4. **Emit** — MD/TXT: Blob download + copy into `exports/` in the artifact. DOCX: Blob download. Every compile writes a `compile-log.json` entry: `{at, recipe, format, blockCount, wordCount, skippedDocs[], tocIncluded, notes[]}` (append-only, `exports/`).

**Compile log as a first-class surface:** Scrivener's community advice is "trial-compile a small collection first"; our equivalents are `previewFlatten` (pre-compile block list, §4) and the compile log (post-compile record incl. every skipped doc). Vellum's Draft-vs-Proof live styled preview is the gold-standard UX and is explicitly **v0.2 backlog** (it is Vellum/Atticus's moat; not v0.1).

### Per-scene styling

A chapter has a heading and a scene has none: below the chapter the body is one undifferentiated run. A writer can say what a scene *is*, and each format decides how that looks.

- **Declaration.** The scene's binder node carries an optional `style` (project-format.md §2, `tree[].style`). The vocabulary is closed and grows by spec change, not by free text: `normal` (the default, and the same as absent) and `section`. The writer sets it in the Inspector, through `binder.setMeta`'s `style` (a value, or `null` to clear), so it is undoable and idempotent. It is read from the manifest at flatten and never computed, and the flat `scene` block carries it only when it is not `normal`.
- **`section`.** A scene that opens a section of its chapter, the manuscript's second-level division. Its **title** is printed above its body, which no format does for a scene without a style. A blank title prints nothing.
- **Unknown stored value.** A `style` this build does not know loads as the string it is (nothing is dropped, so a later version's value survives a round trip), the load notice names it once, and every format renders the scene as `normal`.

| Format | `section` renders as |
|---|---|
| Markdown | `### {title}` above the body. The contents list stays the chapter list. |
| TXT | `{TITLE}` in upper case above the body, on its own line. |
| DOCX | A `Heading 2` paragraph (defined in `styles.xml`) above the body, with no page break. The TOC field already asks for levels 1–2, so its `cachedEntries` carry the heading at level 2, after its chapter, in document order: the cached list and the field agree. |
| EPUB | An `<h2>` above the scene's prose in its chapter file. The `nav.xhtml` and NCX stay the chapter list. A prologue scene filed under the manuscript is headed by its own title, so a `section` there does not repeat it. |

**A style a format cannot express is dropped, and said.** Each style has a row of the formats that express it, and the compile log's `notes[]` names a style in the compile that its format dropped, once per style (for instance, "the `verse` style has no meaning in the plain-text format, so it was dropped"). `section` is expressible in all four prose formats, so no live style reaches that path yet; it is tested with a vocabulary row the test supplies. The media formats do not read `style`.

## 3. Format specifics

| Format | Renderer | Notes |
|---|---|---|
| Markdown | string assembly (no deps) | Chapter = `##`; hierarchy beyond folder depth ignored in output (three-tier model). TOC = anchor list (§2). |
| TXT | same, headings as uppercase lines | `CHAPTER 1. THE LANDING`; separator = blank-line + `* * *`. |
| DOCX | `DocxRenderer` over `docx` (exact pin), lazy-loaded | **v0.1 contract (fixed regardless of renderer):** paragraph styles `Title`, `Heading 1` = chapter, body `Normal`; page-break before each chapter; TOC field optional (default on, per §2); opens cleanly in Word so editors' track changes + Word TOC + Vellum import all work. This contract is the **launch blocker** — if the renderer can't meet it, swap renderers before shipping. The renderer is **lazy-loaded** (dynamic import at the exporter module edge — the editor bundle never pays for it). |
| EPUB | `EpubRenderer` (§3a) — **v0.2, client-side** | Ships behind the same lazy-load seam as DOCX. |
| Screenplay PDF | `pdf`, over the screenplay package's paginator and PDF writer | Binary, so it needs the byte store like DOCX and EPUB. The pagination runs in the plan; the file is drawn in the queue, after the font is loaded lazily, and the CJK fallback too when the script needs it (screenplay.md §5.3). |
| *(media track, post-v0.1)* | Per-medium renderers specced in their own specs — all additive to this §2 enum, same recipe shape, same compile-log/undo/error semantics: `fountain`/`fdx`/`pdf` ([screenplay.md](screenplay.md) §5) · `ink-json` + dialogue table ([dialogue-narrative.md](dialogue-narrative.md) §4) · shot-list CSV + contact-sheet PDF ([storyboard.md](storyboard.md) §6) · `promptpack` + vendor templates ([video-prompt-pack.md](video-prompt-pack.md) §5) | The one-source-many-outputs compile is verified additive (media-track §1): new recipe `format` enum values, no formatVersion implication. |

### 3a. EPUB renderer

**Verdict:** EPUB is **feasible fully client-side; v0.2 confirmed; no Tauri dependency** — the ZIP+XML workload is trivial in-browser, so the v0.2 "client-side or desktop-shell?" question resolves to client-side. The original premise "epub.js write path" was **false** (epub.js and Readium are readers, not writers — Readium: "exclusively for reading… doesn't have any support for modifying or creating them"). The generation-library field is thin and dormant (`@smoores/epub` 0.1.9 best-engineered but Node-fs-bound with an 18-month release gap; `epub-gen-memory` dormant since 2024-07 with the wrong HTML-in input shape; `epub-gen` dead since 2019). **Adopted: a Caotang-owned thin emitter** over the existing mdast render stage (stage 3) — same precedent as the vendored remark-prosemirror posture (editor-engine §12): ~200 lines of frozen-spec code beats a dormant dependency.

**Dependency:** `fflate` (exact 0.8.3, MIT, zero runtime dependencies) as the **lazy-loaded** export-only ZIP engine — same lazy-import-at-the-exporter-module-edge pattern as the DOCX renderer (§3). Rejected: `jszip` (dual MIT/GPL license muddies the MIT stack; heavier). **The browser build is reached by fallthrough, not by a declared condition:** the package's `exports` map lists `node`, then `import`, then `require`, with no `browser` key, so a resolver that sets `node` (Vitest's node environment does) gets the Node build, which calls `createRequire` and `worker_threads`. Caotang therefore imports the explicit `fflate/browser` subpath everywhere, so the tested file is the shipped file. The `~8 KB` figure is the minified core; the package's unpacked size is larger because it ships type maps, UMD and dual ESM/CJS builds.

**Output structure (EPUB 3.3, reflowable only — fixed-layout is out of scope for novel prose):**

```
mimetype                    # uncompressed, FIRST zip entry: "application/epub+zip"
META-INF/container.xml      # points at the package document
OEBPS/
  content.opf               # package document: metadata + manifest + spine
  nav.xhtml                 # EPUB 3 nav TOC (binder chapter list)
  toc.ncx                   # NCX retained for EPUB-2-compat reading systems
  chapter-001.xhtml …       # one XHTML file per chapter (per-scene/per-chapter doc model)
```

**Emitted from exactly the data the other renderers already consume:**
- `nav.xhtml` + `toc.ncx` from the **same binder chapter list** the MD/DOCX TOC renderers consume (stage-2 flatten blocks; chapter = folder nodes, one file per chapter, scenes inside as `<section>`s or paragraph flows per template).
- Per-chapter XHTML from the **mdast stage** (remark mdast → XHTML is a standard remark path; same AST the MD renderer consumes — no new intermediate).
- `content.opf` metadata from manifest/template variables: `{title}`, `{author}`, `{date}` exist (§2); the additive manifest floor (language, identifier/UUID, cover) is specified in [epub-metadata.md](epub-metadata.md): four additive `project.*` slots (`language` BCP-47, `identifier.uuid` — generated once at project create, never regenerated per the EPUB 3.3 maximal-persistence rule, `identifier.isbn?` optional with the ONIX `refines` meta, `coverAssetId?` reusing the storyboard `assets/` store) + emitter-computed `dcterms:modified` (never stored — artifact property, not project truth); epubcheck-clean is the floor, retail-specific extras stay template-layer polish. No `formatVersion` bump, same argument as `filters[]`/`goals[]`.

**Renderer seam (same shape as `DocxRenderer`):**

```ts
interface EpubRenderer {
  emit(blocks: FlatBlock[], opts: { title: string; author?: string; templateId?: string }): Promise<Blob>;
}
```

- `format: 'epub'` joins the §2 recipe format enum and `compile(selection, format)` in v0.2; the compile log gains `format: 'epub'` rows unchanged.
- **Acceptance gate (dev-dependency only):** fixture corpus → `@likecoin/epubcheck-ts` (WASM epubcheck in the browser, **BSD-3-Clause since 0.7.0** (it was **GPL-3.0-only for all 25 earlier versions**), **never enters the app bundle** (dev/test-only like Playwright — the restriction stands as a posture, but the copyleft reason it was imposed for does not)) reports **0 errors** on EPUB 3.3; nav + NCX present; one XHTML file per chapter. **Pinned: `@likecoin/epubcheck-ts` 0.7.0 (exact, BSD-3-Clause), a devDependency of `@caotang/exporter` only.** The pin is the expensive part of the gate, not the tidy part: this package changed license *without* a major bump and without a deprecation marker, so a floating range would have absorbed a GPL→BSD relocation silently, which is a stronger argument for the exact-pin rule than the `ERESOLVE` argument that rule was written for. The pin is recorded here and in `packages/exporter/package.json`. The chapter-per-file layout follows the reader-performance lesson (long single-file XHTML EPUBs render badly in readers) and matches our per-scene document model exactly. **Metadata fixtures ([epub-metadata.md](epub-metadata.md)):** the acceptance corpus holds six metadata fixtures (minimal zero-config book, ISBN+refines, cover present/absent, identifier persistence across re-packs, language propagation).
- `@smoores/epub` stays the **studied reference implementation** (its manifest/spine modeling and `Epub.create` shape are the design template), not a dependency — identical posture to recreate-transform (editor-engine §13).

## 4. Public API

```ts
interface Exporter {
  compile(selection: ExportSelection, format: ExportFormat, templateId?: string):
    Promise<ExportResult>;           // { blob | files[], log }; ExportFormat is the sixteen-member enum of §5
  previewFlatten(selection: ExportSelection): FlatBlock[];   // powers UI preview + agent dry-run
  listRecipes(): ExportRecipe[];     // the manifest's recipes[], read at each compile
}
```

- `previewFlatten` exists because the lesson is trust: the user (and the agent's plan preview) must see the block list *before* the artifact is produced.
- **The service** (`createExporter`, `packages/exporter/src/exporter.ts`) returns the `Exporter` above and adds `ready`, `idle`, `failures` and `commandPort`. The store takes the port through `createProjectCommandRegistry({ exporter })`, so a compile reaches the bus as `export.compile` or `export.compileSelection`, with the same gate, activity row and undo as any command (command-bus §3).
- **Recipes change only through commands.** The `Exporter` interface has no `saveRecipe`. A recipe is `{name, includeRootIds, format, templateId?, options?}` in the manifest's `recipes[]`, and it changes only through `recipe.save` (saving a name that exists replaces it) and `recipe.delete` (command-bus §9, both write-confirm). `options` holds `titlePage`, `toc`, `author`, `charLimit` (the dialogue table's character limit, a whole number from 1 to 10000, dialogue-narrative.md §4), `sceneNumbers` (`off`, `left`, `right` or `both`), `continued` (a boolean) and `pageSize` (the contact sheet's paper, `A4` or `Letter`, storyboard.md §6). `sceneNumbers` and `continued` are the screenplay PDF's options (screenplay.md §5.3); absent, they are off and on. Absent, `pageSize` is A4. Every project is seeded with the default Manuscript recipe at create: `docx`, the manuscript root, the default template. A project that predates recipes holds that one default, named `Manuscript` (the bus's `DEFAULT_RECIPE_NAME`), and an export may name it; a project whose recipes were all deleted holds none. A `recipe.save` or `recipe.delete` in a project that stores no list stores the default first, so the save keeps it beside the new recipe and the delete leaves an empty list. `recipesOf` leaves out a recipe whose format this build cannot compile, because it could not be run.
- **The Export dialog's refusals.** The dialog sends its compile through the bus, so the bus's gates run before any file is written. A refusal, such as a recipe name the project does not hold, or an assets folder that cannot be listed for the shot list or the prompt pack, is shown inside the dialog beside Compile, and no file is downloaded. The refusal is cleared when the writer chooses another recipe or format.

## 5. Agent integration

- **The agent's tool is `export.compile`**, a **confirm-gated** tool (agent-harness.md §3): `export.compile { format, recipeName?, templateId? }` compiles **the whole manuscript**, or, with a `recipeName` and no selection, **the recipe's own nodes**: a manuscript recipe compiles the manuscript, and a recipe that names a part compiles that part, through the same compile the desktop runs. The apply reads the nodes from the recipe, and the outcome the agent is given lists them as `includeRootIds` (`['manuscript']` for a whole-manuscript compile). **`export.compileSelection { includeRootIds, format, templateId?, recipeName? }`** compiles **a part**. A `recipeName` on a part supplies the options the part compiles with (the title page, contents, author and character limit), and the recipe's own selection is not read. Both export commands refuse a recipe name the project does not hold as not-found, before anything is applied, and a selection that names a node the project does not hold is refused as not-found too, every unresolved id named at once. The selection gates of a media format (a Fountain or FDX compile with no screenplay scene, a screenplay PDF whose scenes print no text, an Ink story or dialogue table with no dialogue container, a shot list with no shot) run in the same apply, before anything is reserved. A PDF whose scenes print no text is refused because the blank book it would write reports success, and a selection with no scene at all is refused with it, so no title-page-only PDF is written. The MCP server's write-confirm runs them first, through `ExporterService.refusalOf`, with nothing reserved, so the writer is never asked for a compile that would be refused. **A prompt pack names its vendor template**, in `templateId` or in the recipe, and both commands refuse one that names neither at validate: the bus's validator checks the shape, and the harness checks the id against the installed templates before the card. `export.compileSelection` is a bus command (command-bus §9, write-confirm) that the desktop export dialog sends, and it is not a model tool. Either returns a compile log summary (block count, word count, skipped list, output name), not the blob. The artifact lands in `exports/` and as a download; undo deletes the emitted file(s) (exports are disposable, tier 3, project-format §4). A name that collides in `exports/` gets an auto-versioned filename, and the response says so.
- **The hosts that compile.** The desktop and the MCP server compile through the same exporter with the same three reads, so one project writes the same book and the same shot list from either. `exportMetadataOf(project)` gives the identifier, the byline and the cover's id (epub-metadata.md). `assetRecordsOf(fs)` gives the images the shot list and the prompt pack name, by id and file name: only a folder that is absent reads as no images, and any other failure to list it is an error, so a shot is never written as having no file for a folder that could not be read. `readAsset` gives the cover's bytes. The exporter reads the images synchronously, so each host lists them ahead of a compile and holds the listing: the desktop at the open, after each import of an image, at the attach and before an export is asked for; the MCP server at the open, and again on each confirmed call before its checks run and before it applies, so a listing that failed once is not held against a later compile. A listing that failed refuses the compile with its reason, as a refusal of the export and not as a defect in the apply (`ApplyRefusal`), so the export writes nothing.
- **The formats** are the sixteen members of `EXPORT_FORMATS` (`packages/exporter/src/types.ts`), in four groups. **Prose:** `md`, `txt`, `docx` (the DOCX pin and its benchmark, §7 E1) and `epub` (§3a; its gate is in epub-metadata.md). **Media:** `fountain`, `fdx` and `pdf` (screenplay.md §5; `pdf` is appended after the spreadsheets in the enum), `ink-json`, `dialogue-csv` and `dialogue-xlsx` (dialogue-narrative.md §4), `shot-list-csv`, `shot-list-xlsx` and `contact-sheet-pdf` (storyboard.md §6; `contact-sheet-pdf` is appended last in the enum) and `promptpack` (video-prompt-pack.md §5, one vendor template). **Review:** `coherence-md` and `coherence-json`, the coherence report of the findings file (its run record, coherence.md §4.1). The report is a report of the findings, not of the manuscript, and it leaves through the same compile, log and emitter as the rest. Each media format is a recipe over one package's renderer; the renderers stay in their packages (`packages/exporter/src/media.ts`). **Spreadsheets:** `dialogue-xlsx` and `shot-list-xlsx` write the same rows as their CSV through one writer, `packages/exporter/src/render-xlsx.ts`: a hand-written Office Open XML workbook of one sheet, zipped by `fflate/browser` loaded lazily, as the EPUB is (§3a), so no dependency is added. Text cells are inline strings, which a spreadsheet never evaluates, so they carry no CSV apostrophe; a text cell that opens with a formula character gets Excel's `quotePrefix` style. Shot numbers, durations and the character limit are number cells. A cell over Excel's 32,767 characters is cut, with a compile-log note. Both are binary formats (`BINARY_FORMATS`), so the bus needs a byte store for them, as for DOCX and EPUB. The two PDFs, `pdf` and `contact-sheet-pdf`, are binary formats too.
- The export dialog groups the formats as **Prose, Media and Review**. It offers the prompt pack in the Media group as *Prompt pack (video)*, with a **Vendor template** choice of the installed templates, and sends the choice as `templateId` on `export.compile` or `export.compileSelection`. A recipe's own `templateId` seeds the choice only when it is an installed vendor template, because for every other format it is a layout template (the seeded Manuscript recipe carries `default`); the dialog never sends a recipe's layout id as a vendor. A compile with no vendor chosen leaves the recipe off the command, so the validator's refusal is the one said beside Compile, and nothing is written. *Save as recipe* with the pack chosen stores the vendor as the recipe's `templateId`, and is refused with none. The dialog's compile writes all three artifacts (JSON, Markdown and CSV) and downloads them as one zip; the storyboard's prompt-pack tab keeps its own export of one artifact per click.

- **`docFilter` does not cross the bus.** §2's `ExportSelection.docFilter` is a **function**, and a command's params are *"flat, enum-constrained, schema-validated"* (command-bus §2) — they are JSON, travel over MCP, and are written to the activity log. A callable filter therefore cannot be a command param on either tool: `export.compileSelection` takes `includeRootIds` and nothing else, and a UI that wants a filter **resolves it to a node-id list before sending**. The `ExportSelection` object remains the shape the local `Exporter` interface takes (§4), which is the layer it belongs to.
- **Why two commands rather than one with an optional scope** ): the earlier single-tool form carried `includeRootIds?`, so *omitting* it meant "the whole manuscript" and *supplying* it meant "a part" — one name, two behaviours, and a caller who forgot the field silently exported everything. Splitting by scope makes each call say which it is, and gives each its own risk rating and undo group.

## 6. Non-goals and deferrals

**Deferred, and not in the enum of §5:**

- None. Every format the specs name for this enum is in it.

**Not built, and not on any list yet:** print CSS, custom CSS injection, endnote and footnote engines. EPUB ships, as §3a describes.

## 7. Assumptions / open questions

| # | Item | Status |
|---|---|---|
| E1 | docx.js quality sufficient for manuscript chapter/TOC/separator | Built on `docx` (exact pin, lazy-loaded): its real TOC field (`TableOfContents` + `features.updateFields`, with cached entries), `pageBreakBefore` and semantic paragraph styles meet the §3 contract directly. |
| E2 | Compile feature set (front matter, copyright, TOC conventions) | **Answered** — front/back-matter blocks + TOC policy integrated (§2).
| E3 | Recipes persist in manifest `recipes[]` | Explicit choice; format v1 includes the optional array (additive, loader-tolerant). |
| E4 | Separator default `***` | Confirmed (`* * *` is the cross-tool convention); configurable per template. |
| E5 | Live styled preview (Vellum Draft/Proof duality) | v0.2 backlog; `previewFlatten` structure list is the v0.1 stand-in. |
| E6 | EPUB | Built: a Caotang-owned thin emitter over the mdast stage (fflate + package.opf + nav + NCX + chapter-per-file XHTML), §3a. |