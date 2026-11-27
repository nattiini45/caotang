# Import: Word `.docx` (#279)

Status: **built**. Own reader `@caotang/import-docx` on the shared zip reader ([import-read.md](import-read.md)) and XML reader; the
blocks go to the splitter ([import-core.md](import-core.md)) and the preview ([import-preview.md](import-preview.md)).

Decision 1 (2026-10-31, owner): **an own reader on the shared XML layer**, not mammoth. No new dependency, no second zip library,
and a reject mode for tracked changes that mammoth does not have. pandoc and mammoth are behavioural references only; no code is
copied. There is no `eval`, `new Function` or WebAssembly in the chain, and the reader is a lazy chunk.

## 1. What it reads

| In the zip | What it gives |
|---|---|
| `word/document.xml` | the body: paragraphs, tables, content controls |
| `word/styles.xml` | style names, `w:basedOn` chains, outline level, alignment, bold, caps, size |
| `word/numbering.xml` | list levels: bullet or decimal, and the level's indent |
| `word/_rels/document.xml.rels` | relationship ids to pictures and hyperlinks |
| `word/footnotes.xml`, `word/endnotes.xml` | note definitions |
| `word/comments.xml` | comment text, author and date |
| `word/media/*` | the pictures |
| `docProps/core.xml` | title and creator |

A `.docx` that is not a zip, or a zip with no `word/document.xml`, is refused with a plain message. A zip **of** `.docx` files is
read as a batch: one unit per file, so the splitter makes a chapter per file. A member that cannot be read, opened or parsed is
named as a loss before confirmation, so an incomplete batch is never offered as complete.

## 2. Paragraphs and signals

A paragraph's style is resolved through `w:basedOn` (a cycle stops at the style already seen). The reader keeps, as `Signals`:
`styleName` (always, so the preview can make any style a chapter), `outlineLevel` (from the style or the paragraph),
`align`, `allBold`, `allCaps`, `fontSizeRel` (the paragraph's median run size over the document's), `pageBreakBefore`,
`emptyBefore` / `emptyAfter`, and `toc` for a generated table of contents.

A heading is a paragraph whose resolved outline level is 1–6, or whose style name is Title / Heading n / a localised equivalent
Word writes (`Überschrift n`, `Titre n`, `标题 n`). The text stays as written; the splitter decides what a heading means.

**A TOC never becomes chapters.** A `w:sdt` whose `w:docPartGallery` is `TOC`, or a paragraph holding a `TOC` field instruction, is
marked `toc` and counted; the splitter leaves it out.

## 3. Runs

`w:t` is text (`xml:space="preserve"` keeps its spaces), `w:tab` a tab, `w:br` a line break, `w:br w:type="page"` a page break.
Source text is escaped before it reaches Markdown, so literal `*door*`, backticks, `[name](target)` or a line-start marker stays
prose; only the formatting the reader itself generates becomes Markdown. Bold, italic and strike become Markdown; **underline
becomes italics** by default and is counted (option: off). Small caps, fonts, colours, highlighting and indents are dropped and
counted. `w:hyperlink` keeps its text and, when the target passes the safe-href rule (http, https, mailto or relative), its link;
a `javascript:` target keeps the text only and is counted.

Lists: a paragraph with `w:numPr` becomes `- ` or `1. ` by its level's format, indented two spaces per level. A quote style
(`Quote`, `Block Text`, `Intense Quote`) becomes `> `.

## 4. Tracked changes, notes and comments

`w:ins` and `w:del` are read in one of three modes, chosen in the preview:

| Mode | What happens |
|---|---|
| **accept** (default) | insertions kept, deletions dropped; both counted |
| **reject** | insertions dropped, deletions kept; both counted |
| **keep** | insertions kept, deletions listed in the notes of the scene that holds them |

`w:moveFrom` / `w:moveTo` follow the same rule. A paragraph mark that was inserted or deleted (`w:rPr/w:ins` inside `w:pPr`) does
not merge or split paragraphs: the reader keeps the paragraph as it stands and counts it.

Footnotes and endnotes become inline `[^n]` where the reference stands, with the definition returned for the scene that holds it
(decision 3). Comments become the notes of the chunk that owns their anchor, as `> "anchored text"` then the comment, its author
and its date.

## 5. Pictures, tables and what is dropped

`w:drawing` (and legacy `w:pict`) resolve `r:embed` through the relationships to `word/media/…`. PNG, JPEG, GIF and WebP come in as
`import:docx-image-<n>` with the alt text from `wp:docPr/@descr`; **EMF/WMF are listed and skipped**, and **SVG is refused** (the
picture registry's rule). A paragraph holding only pictures emits every placement in document order, each reference paired with
its own alt text. A batch gives each file its own ref namespace.

A table becomes one paragraph per row, its cells joined with ` — `, with a `table` loss. Headers and footers are not read. Text
boxes are listed as a loss with their text kept as a paragraph, whether the box is attached to a run or nested inside a Word
drawing, VML shape or object.

## 6. Safety and limits

The binder refuses a `.docx` or batch zip above the shared archive size cap before reading the file.

The zip is opened with the shared caps and zip-bomb guard; the XML reader skips DOCTYPEs and never expands entities. The parse runs
in the preview's `'self'` Worker with a timeout and Cancel. Every imported text goes through `scanImport`. Nothing is written before
**Import**, which commits one `binder.importTree` that one Undo takes back, pictures included.

## 7. Tests

`packages/import-docx/test` builds synthetic `.docx` zips: heading styles and a `basedOn` chain, a Shunn manuscript (centred
"Chapter One" and `#` breaks), a Google Docs export, German style names, a TOC field, tracked changes in all three modes, footnotes,
endnotes, comments, literal Markdown punctuation beside real formatting, a list, a quote, a table, direct and nested text boxes,
a PNG, two pictures in one picture-only paragraph, an EMF and an SVG, a `javascript:` link, and a batch zip with unreadable members.
