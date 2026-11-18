# Import core: the block model and the chapter and scene splitter 🧭

> Status: the package `packages/import-core` (`@caotang/import-core`) is **built** (#266): the block model, the rule set and the splitter, with golden fixtures. The plain-text reader is **built** (#283, §7.1), and so is the RTF reader ([import-rtf.md](import-rtf.md)). The preview dialog is built (#267, [import-preview.md](import-preview.md)), and its splitter source runs `splitImport` for both readers' **Import plain text…** and **Import RTF…** (§5.1), each reading in the preview's `'self'` Worker host with a hard timeout and cancel (#390). The other readers that emit blocks (DOCX, RTF and Scrivener, Markdown, EPUB, ODT, HTML) and committing nested Part folders (#269) are **specified, not built**. Epic: #263.

## 1. Purpose

Every document reader emits one intermediate block list, and one pure function turns it into a proposed binder tree. Format code then stays small, and the heuristic that finds chapters and scenes is written and tested once. The package has no DOM and no dependencies, so it runs on the main thread, in a `'self'` Worker and in Node (the CLI and the MCP server can reuse it). It uses no `eval`, no `new Function` and no WebAssembly (CSP `script-src 'self'`). `test/text.test.ts` in the package checks both, and ESLint refuses browser globals in `packages/import-core/src`.

Pandoc's AST (Header, HorizontalRule, Div and Span with attributes, Note) is the prior art for this shape. Pandoc may be used only as an external, test-only reference (decision 11 of the epic); it is never bundled or linked.

## 2. The block model (`model.ts`)

### 2.1 Blocks

`ImportDocument.blocks` is a flat `ImportBlock[]` in reading order:

| Kind | Fields | Notes |
|---|---|---|
| `heading` | `level` 1–6, `text`, `md`, `src?` | An empty heading (`#` alone) is read as a scene break. |
| `para` | `md`, `text`, `src?` | `md` is Caotang-dialect Markdown (CommonMark, GFM strike, images, inline `[^n]` footnote references). An empty `text` is an empty paragraph: a signal, never body text. |
| `break` | `marker`, `src?` | `<hr>`, a Markdown thematic break, a horizontal rule. |
| `pagebreak` | | A hard page break. Never body text. |
| `image` | `assetRef`, `alt` | Written as `![alt](assetRef)`. |
| `other` | `md`, `loss?` | Content the reader kept in a degraded form (a table as text). |

`Signals` (`src`) carry what the source said about the block's structure and nothing more: `styleName`, `outlineLevel` (as a heading level, 1 = top), `align`, `allBold`, `allCaps`, `fontSizeRel` (against the body median), `pageBreakBefore`, `emptyBefore` / `emptyAfter` (for readers that drop empty paragraphs), `sourceUnit` (EPUB spine item, file, Longform scene) and `toc` (a Word TOC field or EPUB `toc` landmark).

### 2.2 Side tables

`footnotes` (`{ blockIndex, label, md }`), `comments` (`{ blockIndex, md, author? }`), `metadata` (`title`, `author`, `language`, …), `assets`, `losses` (`LossWarning[]` with a `LossCode`) and `injection` (hits from `scanImport`, keyed by block). Footnotes stay inline in the text (decision 3): the reader writes `[^n]` into the block's Markdown, and the splitter writes the definition at the end of the scene that holds the reference, with continuation paragraphs indented four spaces; a definition keyed to a block without its reference follows the block that holds it. Comments go into the `notes` of the chunk that owns their block (an empty block's comment goes with the nearest block before it). Nothing is dropped silently: a footnote whose reference no block holds, and a comment on no block in the result, is kept under "Unreferenced notes" in the notes of the last scene (else the last back-matter or the front chunk), reported by an `unreferenced-notes` notice and counted apart in `stats` (`unreferencedFootnotes`, `unreferencedComments`; `footnotes` and `comments` count only those placed with their block). With no chunk at all they are named losses. Losses pass through to the result, with every `other` block's `loss` added. Injection hits are given the id of the node they landed in.

## 3. The splitter (`splitImport(doc, rules?, options?)`)

A pure function: no I/O, no clock, the input is never changed, and the same input gives the same result. The preview re-runs it on every rule change; 200k words re-split in well under 50 ms (a CI test holds the median under 50 ms).

### 3.1 Rules (`SplitRules`, all with defaults)

| Field | Default | Values |
|---|---|---|
| `chapters` | `{ kind: 'auto' }` | `heading` (level), `style` (styleName), `pattern` (families?), `unit`, `pagebreak`, `none` |
| `scenes` | `{ breaks: true, headingLevel: 'auto', emptyRuns: false }` | `headingLevel` a number, `'auto'` or `null` |
| `parts` | `nest` | `nest` (Part folders hold chapter folders, decision 2) or `flatten` (the part title in each chapter's `keywords`) |
| `frontMatter`, `backMatter` | `research` | `research`, `manuscript`, `skip` (a skipped chunk is still in the result, marked `skip`) |
| `skipToc` | `true` | |
| `removeChapterNumbers` | `false` | |
| `sceneTitles` | `numbered` | `numbered` ("{chapter} · n") or `firstWords` |
| `overrides` | none | Manual edits by block index: `noSplit`, `sceneAt`, `chapterAt`. They apply after the rules. |

`SplitOptions.labels` gives the words the splitter writes into titles ("Manuscript", "Before chapter 1", "Chapter n", "{chapter} · n"). They are English by default; the app passes its own in the interface language, so the package carries no catalog. Flags and notices are codes with data, never prose.

### 3.2 Step A: chapter candidates

- **Explicit structure is decisive:** a `heading` block, a paragraph with `outlineLevel`, a "Heading N" style (English, German, French, Spanish, Italian, Dutch, Polish, Russian and Chinese names), a `sourceUnit` boundary.
- **Pattern families**, matched on a short line only: `chapter-word` (chapter, ch., kapitel, chapitre, capítulo, capitolo, hoofdstuk, rozdział, глава, and German "1. Kapitel"), `part-word` (part, book, teil, buch, partie, livre, parte, libro, deel, boek, część, księga, часть, книга), `cjk-chapter` (第…章/回/节), `cjk-part` (第…部/卷/编/篇), `korean-chapter` (제 N 장), `korean-part` (제 N 부) and `number` (a line holding only a number or Roman numeral). After the word must come nothing, a number (digits, Roman numerals, number words in English, German, French, Spanish and Italian) or a separator and a title: "Chapter 3: The Landing", "Chapter Three", "Chapter" are lines of the family, "Part of the problem" is not. Prologue, epilogue and interlude lines (several languages, and 序章, 楔子, 尾声) are not a family; they join whatever chapter family is accepted.
- **Linear on any input:** the patterns match only a line's head (the word and its number) and the rest is read with character loops, so a hostile line cannot make a pattern backtrack (CodeQL `js/polynomial-redos`); the TOC key, the short-line test, the first words and the word count are loops too.
- **Score:** short line (≤ 60 characters, ≤ 8 words, no sentence-final punctuation unless after a numeral) +1, and required; a word family +3 or a number line +2; a page break before +2; centred +1; all bold, all caps, `fontSizeRel ≥ 1.2` or a heading +1; empty paragraphs on both sides +1. A candidate scores **≥ 4**.
- **Repeat rule:** a chapter family is accepted with ≥ 3 candidates, or ≥ 2 in a document under 20,000 words; a part family with ≥ 2. A stray "Chapter 3" in a letter or in dialogue does not split the book.
- When a chapter family is accepted, a candidate of another chapter family that scores ≥ 6 (a pattern plus signals of its own, such as a page break and centring) still splits, and Step F flags the mixed families.

### 3.3 Step B: levels and Parts

1. Explicit heading levels in use are counted, leaving out the title, the TOC and back-matter headings.
2. **Book title:** a Title style used once before any heading, or a top-level heading that occurs once and comes before any other heading. It becomes `result.title` (otherwise the reader's `metadata.title`). Not when the writer chose chapters at that level.
3. **`auto` resolves in this order:** headings (the shallowest level with ≥ 2 occurrences), a paragraph style whose name reads as a chapter style ("Chapter Title", "Kapitel") used ≥ 2 times, `sourceUnit` boundaries (≥ 2 units), accepted pattern families, page breaks (≥ 3 with text after them), and otherwise no split: one chapter, "Manuscript".
4. **Parts with headings:** the shallowest level with ≥ 2 occurrences names Parts, and the next level with ≥ 2 holds the chapters, when at least half its headings read as parts ("Part One", "Teil 2", "第一部") or carry a part style. Otherwise it holds the chapters. When the writer chooses a chapter level, the nearest level above it with ≥ 2 occurrences is Parts. A heading above the chapter level that is neither Parts nor the title starts a chapter of its own. **Parts with patterns:** accepted part families with an accepted chapter family make Parts; part families alone are the chapters ("Book One", "Book Two").
5. **Scene level:** a number, `null`, or on `auto` the first used level below the chapter level (the shallowest level when chapters do not come from headings), used when it occurs ≥ 3 times, or ≥ 2 times inside at least half the chapters.
6. **Story parts:** a chapter titled as a prologue or an epilogue carries `storyPart` (`SceneMeta.storyPart`, coherence.md §5.2.2); an interlude carries none, since the model has no interlude part. With Parts, an epilogue (and a prologue or epilogue at the part level) is a top-level chapter after the last part, not inside it.

### 3.4 Step C: scene breaks

A block is a strong break when it is a `break`, an empty heading, or a paragraph whose trimmed text is only `* # ~ • · ⁂ § ◆ ◇ ❖ — – - = _ +` and spaces, at most 15 characters (40 when centred), or "o0o" / "oOo". Two or more empty paragraphs (or `emptyBefore ≥ 2`) are a weak break, off by default and offered (`detected.emptyRunsOffered`, notice `empty-runs-offered`) when there are ≥ 5 runs and no symbol markers. A marker that splits is removed: the exporter writes the configured separator. A break that does not split (scene breaks off, `noSplit`, front or back matter) is written as `***` between content (project-format.md §3), never at the start or the end of a chunk. An untitled chunk left empty by a split is dropped; nothing is in it.

### 3.5 Step D: noise

- **Table of contents:** blocks marked `toc` or in a TOC style, and a run of ≥ 3 consecutive short lines starting in the first 15 % of the document (at least the first 40 blocks) whose texts, without dot leaders, tabs and page numbers, recur later; a "Contents" heading right before the run joins it. TOC lines are never chapter candidates. With `skipToc` they are left out with a `toc-skipped` notice and kept in `result.toc`; without it they are front matter.
- **Front matter:** everything before the first Part or chapter (other than the title and the TOC) is one "Before chapter 1" chunk, `research` by default. Never dropped silently.
- **Back matter:** a heading or short line reading "Acknowledgements", "About the author", "Also by …", "Danksagung", "Über die Autorin", "Remerciements", "Agradecimientos", "致谢" and the like, after the first chapter, starts a back-matter chunk that runs to the next Part, chapter or back-matter heading. `research` by default. One before the first chapter stays in the front matter.
- **Running headers:** an identical short line just after or just before ≥ 3 page breaks is flagged (`running-header`), not deleted.

### 3.6 Step E: titles

A chapter folder is titled with its heading or line as written. `removeChapterNumbers` strips "Chapter N:" (and "第N章") and keeps the title when nothing would be left. A chapter with no title of its own (page-break chapters without a short first line, manual chapters) is "Chapter n" by position; a unit chapter without a heading is the unit's file name. A scene takes its heading; otherwise "{chapter} · n", or with `firstWords` the scene's first sentence up to 40 characters, cut at a word. A part's own text before its first chapter (an epigraph) is a `text` document in the Part folder, titled with the part.

### 3.7 Step F: sanity flags

Shown in the preview, never fixed by the splitter: `chapter-short` (< 100 words), `chapter-long` (> 25,000), `scene-long` (> 10,000), `number-gap` and `number-duplicate` (chapter numbers read from digits, Roman numerals, number words and CJK numerals; a restart at 1 at the first chapter of a part is not a gap), `mixed-families` and `running-header`.

## 4. The result (`SplitResult`)

`title`, `tree` (`ProposedFolder` with `role` `part` or `chapter`, holding `ProposedDoc` with `role` `scene` or `text`; ids are the role and the first block, `chapter-12`, stable for one input), `frontMatter`, `backMatter[]`, `toc`, `splits` (each split's block, kind and reason, for the ✂ markers), `detected` (heading levels, styles, families with counts and acceptance, page breaks, units, markers, empty runs, the resolved chapter rule, the scene level and the Parts source, for the rule chips), `flags`, `notices` (`title-detected`, `toc-skipped`, `front-matter`, `back-matter`, `empty-runs-offered`, `no-chapters`, `parts-flattened`, `unreferenced-notes`), `losses`, `injection` and `stats`.

## 5. What is not built

- The other readers (DOCX, RTF and Scrivener, Markdown, EPUB, ODT, HTML). Each emits `ImportDocument` and is a lazy chunk (#31).
- A prologue or epilogue the splitter names (`storyPart`) is not committed: `binder.importTree` writes no scene metadata.
- Committing the tree. The splitter emits Part folders holding chapter folders; the binder allows them once #269 lands. Until then a caller can use `parts: 'flatten'`.

### 5.1 The splitter source (built, #267)

`apps/desktop/src/import-preview/splitter-source.ts` turns a reader's `ImportDocument` into an `ImportPreviewSource` ([import-preview.md](import-preview.md) §2). The rule chips come from a split with the default rules: **Chapters at** offers Automatic (naming what `auto` resolved to), each heading level, each chapter style, "Chapter" lines, each file, page breaks and None, each with its count, only those the file has; **Scenes at** offers Automatic, break lines only, break lines with a heading level, break lines with runs of empty lines, and none (it starts on the empty runs when `emptyRunsOffered`); **Parts**, **Text before chapter 1**, **Back matter** and **Table of contents** appear only when the file has them; **Untitled scenes** chooses numbered or first words. `rulesFromSettings` maps the chips and the dialog's manual splits back to `SplitRules` and `SplitOverrides`. `planOfSplit` maps the result: the tree in reading order (the front chunk, the parts and chapters, each back-matter chunk where it starts; a chunk's destination is the node's `place`), the ✂ markers with their reason in words, the counts from `stats` (unreferenced footnotes and comments included), the losses (the reader's own words, else the code's), and the flags in words, a short chapter that a split starts with **Join it to the chapter before** (`noSplit` at that split). The notices are a report list. Every word is a catalogue message, and the splitter's title labels come from `SplitOptions.labels`. A reader's own chips and options re-read the document only when they change (`readKey`); a rule chip re-runs only the splitter. With the reader's pictures option off, each picture's paragraph leaves the bodies and the report counts it.

Two readers use it, each a lazy chunk with the splitter, opened from two binder buttons (`components/ManuscriptImport.tsx`): **Import plain text…** (`text-source.ts`: the encoding, when guessed, and the paragraph mode are reader chips; a file over `MAX_TEXT_BYTES` or `MAX_TEXT_LINES`, or in no encoding the reader can name, is refused on the status line), and **Import RTF…** (`rtf-source.ts`: the file is read in `load` with the dialog's Cancel as the signal; underline as italics and the pictures are options; picture refs are `import:rtf-image-n`; hidden text, deleted revisions, field codes and link targets go to the injection scan through `scanExtra`). A third button, **Import RTFD…**, picks an `.rtfd` package folder and reads it through the same RTF source (import-rtf.md §4). All three read in the preview's `'self'` Worker host with a hard timeout and the dialog's Cancel (#390, import-preview.md §6); the splitter stays on the main thread, where it re-runs on every rule chip.

## 6. Fixtures

`packages/import-core/test/fixtures/*.json` are reader-independent block lists, each with a golden test of the proposed tree, the front and back matter, the flags and the notices: a Heading-styled Word manuscript, Shunn format, Parts → Chapters → Scenes with a prologue and an epilogue, German "Kapitel 1", Chinese "第一章", a TOC at the start, front and back matter, mixed chapter families with a gap and a duplicate, empty `#` scene breaks, a setext heading beside a thematic break, and a stray "Chapter 3". The 26k-word chapter and the 200k-word timing document are generated in the tests.

## 7. Readers

Each reader emits `ImportDocument`, runs on the main thread, in a `'self'` Worker and in Node, and is a lazy chunk (#31).

### 7.1 Plain text (built, #283)

`@caotang/import-read/text` (`packages/import-read/src/text.ts`). Two halves, so the preview re-runs only the cheap one when the writer toggles paragraphs:

- `decodePlainText(bytes, { encoding? })` decodes through the store's `detectEncoding` and `decodeAs` (`@caotang/store/encoding`); it keeps no decoder of its own. It answers `decoded` (`text`, `encoding`, `guessed`, `candidates`) for UTF-8 (a byte-order mark consumed), UTF-16 with a byte-order mark (certain) or by zero-byte parity (guessed), and Windows-1252 (guessed); `ask` (`detection`, `suggested`) for any other best reading or none; `too-large` past `MAX_TEXT_BYTES` (32 MiB), before decoding; and `too-many-lines` past `MAX_TEXT_LINES` (250,000 lines, blank lines and form feeds included), counted on the decoded text in one pass (`countPlainTextLines`, stopping at the limit) before anything is split or a block built. The byte cap alone does not bound memory: 32 MiB of one-character lines is 16 million lines, each a string and a block; a 200k-word novel hard-wrapped at 70 characters is about 17,000 lines. With `encoding` set (the writer's pick) it decodes as that.
- `plainTextBlocks(text, { paragraphs?, fileName? })` normalises CRLF, CR and U+2028/2029/0085 to LF and U+00A0, U+202F, U+2007 to a space, and removes C0 controls other than tab, LF and form feed, DEL and C1 controls. `paragraphs` is `'auto'` (default), `'blank'` or `'line'`; `detectParagraphMode` picks `'line'` at ≥ 8 non-blank lines with blank lines ≤ 5 % of them. Blank mode joins a paragraph's lines with a space; a first line that matches a chapter family or `specialOf` on a short line, and a heading-like line under a setext underline (`===`, `---`, dropped), become paragraphs of their own. Heading-like is the first line of its paragraph, short (`isShortLine`), and a chapter line, all capitals, title case (every word of four or more letters capitalised) or caseless; under any other line the `---` stays a scene break. A symbol-only line (`breakMarkerOf`, the centred limit) is a `break`; a form feed is a `pagebreak`. Signals: `allCaps` (two or more letters, all capitals), `emptyBefore`/`emptyAfter` for blank lines beyond the one that separates paragraphs (blank mode) or all of them (line mode). `md` is `escapePlainMarkdown(text)`: inline `\ ` * _ [ ] < ~` and entity-like `&` everywhere, a leading `#`, `>`, `-`/`+` list marker, `1.`/`1)` and a thematic-break line. Leading indentation is dropped; spaces and tabs inside a line are kept as written (only a paragraph's edges are trimmed). `plainTextBlocks` throws `PlainTextLimitError` past `MAX_TEXT_LINES`; text from `decodePlainText` never reaches it. `metadata.title` is the file name without `.txt`.
- Losses: `formatting` for normalised no-break spaces and dropped indentation, `unsupported` for removed control characters and U+FFFD left by the decode, each with a count. Nothing changes without a line in the report.
- `readPlainText(bytes, options)` runs both and returns `read` with the blocks, the paragraph modes and the encoding, or the decode's `ask` / `too-large`.
- The reader does no injection scan and no commit: the preview (#267) scans every block through `scanImport` and commits one undo group. It runs synchronously (a 200k-word file reads in well under 100 ms); **Import plain text…** runs it in the preview's Worker host through the splitter source (§5.1), off the main thread.
- Fixtures (`packages/import-read/test/fixtures/text/`, checked in as binary so git keeps their bytes): one manuscript in UTF-8 and in Windows-1252 with CRLF (the test writes it as UTF-16 LE with CRLF and UTF-16 BE too, so no zero bytes are checked in), with "CHAPTER ONE" lines and `* * *` breaks; a Word "Save as text" file (one line per paragraph, no blank lines, a no-break space); and a Shift JIS file the reader asks about. `test/text.test.ts` checks each decodes to the same blocks and splits into the same chapters and scenes.
