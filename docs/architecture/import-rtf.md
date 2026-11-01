# The RTF reader 🧭

> Status: the package `packages/import-rtf` (`@caotang/import-rtf`) is **built** (#274) and tested in Node, on the main thread and in a `'self'` Worker. Nothing in the app calls it yet: the standalone **Import RTF** command and the Scrivener import (#275) reach it through the import preview (#267), which is not built. It emits the block list of import-core.md §2 (#266), whose types it re-exports from `@caotang/import-core` (`src/model.ts`). Epic: #263.

## 1. Purpose

Scrivener stores every text as `content.rtf` (and `notes.rtf`); TextEdit, Word, Bear, Ulysses and Scrivener's Compile write `.rtf` and TextEdit and Scrivener 2 write `.rtfd` packages. One reader serves all of them: RTF bytes in, `ImportDocument` (blocks, footnotes, comments, metadata, assets, losses) out, plus the bytes of each picture, the texts the injection scan must read and the link fields it did not turn into links.

No library fits (research in #263): rtf.js is 2.1 MB minified and needs the DOM, `rtf-parser` and `@iarna/rtf-to-html` are Node streams, pandoc is GPL and WebAssembly. The reader is own code (MIT), about 29 kB minified and 11 kB gzip (measured with rolldown), with no dependencies at run time and no DOM, `eval`, `new Function` or WebAssembly (`test/csp-clean.test.ts`, and ESLint refuses page globals in `src/`). `banisterious/obsidian-draft-bench`'s MIT converter and the RTF 1.9.1 specification were the references; writerslogic's AGPL code was read for facts only.

## 2. Reading

- **One pass** over the bytes with a group stack. Control words are cut at 32 letters and numbers at 10 digits (rtf-stream-parser's `maxTokenSize` idea); runs of plain ASCII are taken whole.
- **Destinations:** `{\*\…}` the reader does not know is skipped whole, however deep it nests; so are the colour, revision, RSID and other tables, `\nonshppict`, `\objdata`, bookmarks and index entries. Headers and footers, shapes (`\shp`) and objects (`\object`, whose `\result` is kept) are skipped and named in the losses. A plain group with an unknown first word is ordinary text.
- **Unicode:** `\ucN` is honoured per group (Cocoa writes `\uc0`; assuming `\uc1` would drop the character after every `\u`). `\uN` is read signed (Word) or unsigned (Cocoa); a surrogate pair from two `\u` becomes one character and a lone surrogate becomes U+FFFD.
- **Code pages:** 8-bit text (`\'hh` and raw bytes) is decoded in the font's `\cpg`, else its `\fcharset` (134 GBK, 128 Shift-JIS, 136 Big5, 129 Korean, 204 Cyrillic, 238 Central European, 161 Greek, 162 Turkish, 177 Hebrew, 178 Arabic, 186 Baltic, 222 Thai, 77 Mac), else the header's `\ansicpg` or `\mac`, with the host's `TextDecoder`, so no table is bundled. A double-byte character split over two escapes is kept whole. A code page the WHATWG standard does not name (DOS 437 and 850) is read as windows-1252 and reported.
- **Limits** (`RTF_LIMITS`, each overridable): 256 MB of input, groups 1,024 deep, 64 MB per picture, 5,000 pictures, 60 seconds. A cancel flag (an `AbortSignal` fits) and the deadline are checked as it reads. Errors are returned, never thrown: `not-rtf`, `too-large`, `too-deep`, `timeout`, `cancelled`. A truncated file is read to its end (an open footnote or picture is kept) and reported; text after the document's last `}` is reported and not read.

## 3. Mapping

| RTF | Result |
|---|---|
| `\par`, `\` + line end | a `para` block; an empty paragraph is an empty block (a signal for the splitter) |
| `\line` | a hard break (`\` + newline) |
| `\b` `\i` `\strike` | `**`, `*`, `~~`, written with a mark stack so emphasis nests; whitespace stays outside the delimiters |
| `\ul` and its variants | italics, counted (the schema has no underline); `underlineAs: 'none'` drops it, counted |
| `\qc` `\qr` `\qj` | `src.align` (centred and right-aligned text is counted) |
| `\sN` + stylesheet | `src.styleName` (not for Normal); the style's `\outlinelevel` → `src.outlineLevel` |
| `\outlinelevelN` | `src.outlineLevel` = N + 1 |
| all bold, all capitals, size | `src.allBold`, `src.allCaps`, `src.fontSizeRel` against the size most characters are set in |
| `\page`, `\sect` | a `pagebreak` block; `\pagebb` → `src.pageBreakBefore` |
| TOC field result | `src.toc` on its paragraphs |
| `\ls` `\ilvl`, `\listtext`, `\pntext` | `- ` or `N. ` items, two (bullets) or three (numbers) spaces per level; the number shown in `\listtext` is kept, else the list table's format decides; letters and Roman numerals become digits, counted |
| `\intbl`/`\itap`, `\cell`, `\row` | one `other` block per row (`loss: 'table'`), cells joined by " \| "; each table counted once |
| `\footnote` | `[^n]` where it stands and a footnote keyed to that block (decision 3); `\chftn` writes nothing |
| `{\*\annotation}` | a comment on the block, with `\atnauthor` as its author |
| `HYPERLINK "…"` | a Markdown link when the target is `http`, `https` or `mailto` (the paste rule); any other target, an internal `\l` link and Scrivener's `scrivcmt://` keep their text and are listed in `links` for the scan and the Scrivener pass (#277) |
| other fields | their shown text, counted by field name |
| `\pict` PNG, JPEG | an asset (`rtf-image-N.png`, prefix configurable); alone on its line an `image` block, else `![](ref)` inline. `\shppict` wins over `\nonshppict`. EMF, WMF, PICT and bitmaps are skipped and named |
| `\NeXTGraphic` (`.rtfd`) | the attachment by name through `options.attachment`; Cocoa's attachment character after it is dropped |
| `\v` (hidden), `\deleted` | dropped and counted, and their text put in `scanExtra`; `\revised` (inserted) text is kept |
| fonts, colours, highlights, super/subscript, capitals by formatting | dropped and counted |
| `{\info}` | `metadata.title`, `author`, `subject`, `keywords`, `comment` |

Text is escaped only where Markdown would read syntax (`*`, `` ` ``, `[`, `]`, `\`, `_` at a word edge, `~~`, `<` before a tag-like character, an entity, and what would start a heading, quote, list or setext line), so an ampersand or `Kara_thal` stays as typed.

Scrivener's inline annotations and footnotes are escaped text in the file (`{\Scrv_annot …}`, `{\Scrv_fn=…}`), and its style markers are text (`<$Scr_Ps::0>`); they come out as written, and the Scrivener pass (#277) removes them.

## 4. `.rtfd` packages

`readRtfd(archive)` takes an `ImportArchive` from `@caotang/import-read` (a zip or a picked folder, under that reader's caps), reads the shallowest `TXT.rtf` and resolves each `\NeXTGraphic` against the files beside it. A PNG or JPEG becomes an asset; any other attachment (TIFF, PDF) and any file the text never shows is named in the losses.

## 5. The scan

The reader depends on nothing, so it does not run `scanImport` (packages/harness). `scanPartsOf(result)` gives the app every text to scan: each block, footnote, comment and metadata field, each listed link target, and `scanExtra` (hidden text, deleted revisions, field instructions).

## 6. Tests and fixtures

`packages/import-rtf/test/`: unit tests for every row above and every limit; hand-written TextEdit (Cocoa, `\uc0`), Word (styles, footnote, comment, table, PNG, JPEG, EMF, `\uc1`), GBK, Shift-JIS, Big5, Cyrillic, `\ansicpg936` and Mac Roman files; `.rtfd` packages; and the eighteen `content.rtf` files of draft-bench's Scrivener 3 for Windows test project, each checked against Scrivener's own text extraction (`search.indexes`): the same text, and the same word count, once Scrivener's style markers are taken out. `e2e/import-rtf-worker.spec.ts` runs the reader in Node, on the main thread and in a `'self'` module Worker under the app's policy, in Chromium, Firefox and WebKit.

## 7. Not built

- The standalone **Import RTF** command and its Worker, the preview with the losses report and the one undo step: with #267.
- Real files from Scrivener for Mac and from Word for footnotes and comments; the Mac and Word fixtures are written by hand in their shapes.
- Rasterising EMF and WMF pictures (rtf.js's renderers are the candidate, 56 kB each, if writers ask).
