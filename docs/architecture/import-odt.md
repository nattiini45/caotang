# Import: OpenDocument `.odt` (#298)

Status: **built**. Own reader `@caotang/import-odt` on the shared zip reader ([import-read.md](import-read.md)) and XML reader; the
blocks go to the splitter ([import-core.md](import-core.md)) and the preview ([import-preview.md](import-preview.md)).

An own reader, as for Word ([import-docx.md](import-docx.md)): `odf-kit` is Apache-2.0 and was read as a reference only;
`odt2md` (GPL) and WebODF (AGPL) are not used and no code is copied. No `eval`, `new Function` or WebAssembly; a lazy chunk.

## 1. What it reads

| In the file | What it gives |
|---|---|
| `content.xml` | `office:automatic-styles`, then `office:body/office:text`: the paragraphs, headings, lists and frames |
| `styles.xml` | the named styles the automatic styles inherit from |
| `meta.xml` | `dc:title`, the creator and the language |
| `Pictures/*`, `media/*` | the pictures `draw:image` names |
| a flat `.fodt` | the same content in one XML file, read without a zip |

A file that is neither an ODF zip with `content.xml` nor a flat ODF document is refused with a plain message.

## 2. Paragraphs and signals

`text:h` carries `text:outline-level` (1–6): that is the heading level, whatever the style is called. `text:p` is a paragraph.
The style chain (`style:parent-style-name`, a cycle stops) gives `styleName`, `align` (`fo:text-align`), `allBold`, `allCaps`
and the page break (`fo:break-before="page"`). `text:soft-page-break` is a page break. Empty paragraphs are counted as
`emptyBefore` / `emptyAfter`, and `text:line-break` is a line break inside a paragraph.

Lists: `text:list` / `text:list-item` become `- ` or `1. `, indented two spaces per nesting level. A paragraph whose style
descends from a quotation style becomes `> `.

## 3. Runs, notes and comments

`text:span` carries the character style: bold, italic and strike become Markdown, **underline becomes italics** by default and is
counted (option: off). `text:a` keeps its text and, when `xlink:href` passes the safe-href rule, its link; a `javascript:` target
keeps the text only and is counted. `text:s` is a run of spaces, `text:tab` a tab.

`text:note` becomes inline `[^n]` with its `text:note-body` as the definition (decision 3). `office:annotation` becomes the notes
of the chunk that owns it, with the text it anchors, its creator and its date.

## 4. Tracked changes

ODF keeps changes in `text:tracked-changes` and marks their place in the text with `text:change`, `text:change-start` and
`text:change-end`. The same three modes as Word:

| Mode | What happens |
|---|---|
| **accept** (default) | inserted text kept, deleted text dropped; both counted |
| **reject** | inserted text dropped, deleted text put back where it stood; both counted |
| **keep** | inserted text kept, deleted text listed in the notes of the scene that holds it |

## 5. Pictures and what is dropped

`draw:frame` / `draw:image` name a file inside the package (`Pictures/…`) or a remote address. PNG, JPEG, GIF and WebP come in as
`import:odt-image-<n>` with the alt text from `svg:desc` or `svg:title`; **SVG is refused**, other formats are listed and skipped,
and a remote picture is listed, not downloaded (decision 10). Tables become one paragraph per row with a `table` loss; text boxes
are read as paragraphs and counted. Fonts, colours, highlights and indents are dropped and counted.

## 6. Safety and limits

The zip is opened with the shared caps and zip-bomb guard; the XML reader skips DOCTYPEs and never expands entities. The parse runs
in the preview's `'self'` Worker with a timeout and Cancel. Every imported text goes through `scanImport`. Nothing is written before
**Import**, which commits one `binder.importTree` that one Undo takes back, pictures included.

## 7. Tests

`packages/import-odt/test` builds synthetic ODT packages and a flat `.fodt`: headings, a style chain, a list, a quote, a footnote,
an annotation, tracked changes in all three modes, a PNG, an SVG, a `javascript:` link, a table and a page break.
