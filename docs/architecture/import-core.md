# Import core: the block model and the chapter and scene splitter 🧭

> Status: the package `packages/import-core` (`@caotang/import-core`) is **built** (#266): the block model, the rule set and the splitter, with golden fixtures. Nothing in the app calls it yet. The readers that emit blocks (DOCX, RTF and Scrivener, Markdown, plain text, EPUB, ODT, HTML), the preview dialog (#267) and committing nested Part folders (#269) are **specified, not built**. Epic: #263.

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

`footnotes` (`{ blockIndex, label, md }`), `comments` (`{ blockIndex, md, author? }`), `metadata` (`title`, `author`, `language`, …), `assets`, `losses` (`LossWarning[]` with a `LossCode`) and `injection` (hits from `scanImport`, keyed by block). Footnotes stay inline in the text (decision 3): the reader writes `[^n]` into the block's Markdown, and the splitter writes the definition at the end of the scene that holds the reference, with continuation paragraphs indented four spaces. Comments go into that chunk's `notes`. Losses pass through to the result, with every `other` block's `loss` added. Injection hits are given the id of the node they landed in.

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

`title`, `tree` (`ProposedFolder` with `role` `part` or `chapter`, holding `ProposedDoc` with `role` `scene` or `text`; ids are the role and the first block, `chapter-12`, stable for one input), `frontMatter`, `backMatter[]`, `toc`, `splits` (each split's block, kind and reason, for the ✂ markers), `detected` (heading levels, styles, families with counts and acceptance, page breaks, units, markers, empty runs, the resolved chapter rule, the scene level and the Parts source, for the rule chips), `flags`, `notices` (`title-detected`, `toc-skipped`, `front-matter`, `back-matter`, `empty-runs-offered`, `no-chapters`, `parts-flattened`), `losses`, `injection` and `stats`.

## 5. What is not built

- The readers. Each emits `ImportDocument` and is a lazy chunk (#31).
- The preview dialog (#267), which edits `SplitRules`, shows `detected` as chips and `splits` as markers, and commits one undo group.
- Committing the tree. The splitter emits Part folders holding chapter folders; the binder allows them once #269 lands. Until then a caller can use `parts: 'flatten'`.

## 6. Fixtures

`packages/import-core/test/fixtures/*.json` are reader-independent block lists, each with a golden test of the proposed tree, the front and back matter, the flags and the notices: a Heading-styled Word manuscript, Shunn format, Parts → Chapters → Scenes with a prologue and an epilogue, German "Kapitel 1", Chinese "第一章", a TOC at the start, front and back matter, mixed chapter families with a gap and a duplicate, empty `#` scene breaks, a setext heading beside a thematic break, and a stray "Chapter 3". The 26k-word chapter and the 200k-word timing document are generated in the tests.
