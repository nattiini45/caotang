# The CSV/TSV table import 🧭

> Status: the package `packages/import-table` (`@caotang/import-table`) is **built** (#288), and the CSV/TSV half of **Import spreadsheet…** in the binder calls it through the shared preview (#267) in the `'self'` Worker host (#390). It reads `.csv`, `.tsv` and delimited `.txt` into codex entries or timeline scenes, writes one `binder.importTree`, and takes the whole import back with one Undo. Epic: #263.

## 1. Purpose

A character bible, story bible or timeline often starts in a spreadsheet long before it becomes a manuscript. The table import is the writer-controlled bridge: the file supplies rows, the writer chooses what the rows become and what each column means, and Caotang writes only after the shared preview shows the result. The reader is own code (MIT), pure and DOM-free. It has no third-party dependency, no `eval`, no `new Function` and no WebAssembly. It takes decoded text: `@caotang/import-read/text` owns the encodings, their detection and their byte and line caps.

The source is deliberately not a spreadsheet application. It reads rectangular delimited text. Formulas, styles, multiple sheets and merged cells belong to the XLSX reader (#289; `import-xlsx.md`); an image file named by a row is text, because a standalone CSV carries no image bytes.

## 2. Reading

- **Input and size.** The binder button accepts `.csv`, `.tsv`, `.txt` and `.xlsx`; bytes starting with the zip signature go to the workbook reader, and the delimited-text reader described here receives the rest. The preview checks `file.size` before reading bytes; a file over the shared `MAX_TEXT_BYTES` cap is refused on the status line. UTF-8 with or without a BOM and UTF-16LE/BE with a BOM come through the shared text reader, whose encoding choice remains visible when it guessed.
- **Delimiter.** Comma, semicolon, tab and pipe are candidates. The sniffer parses the first rows with each candidate and picks the one making the most consistent multi-column table; the preview shows a Delimiter choice so the writer can override it. A single-column file is still read, but no delimiter is meaningfully detected.
- **RFC 4180 quoting.** A quote at the start of a field opens a quoted cell; two quotes inside it are one quote; a newline inside it is part of the cell. CRLF, CR and LF row endings are normalised. Quotes elsewhere are literal text, because spreadsheet writers disagree and inventing structure there is worse than keeping the text.
- **Rows.** Blank rows are dropped. The first row is column names by default and can be marked as data. Missing trailing cells read as empty strings. A row wider than the first is kept, and inconsistent row widths are counted as one loss rather than silently repaired.
- **Caps.** `MAX_TABLE_ROWS` is 10,000 and `MAX_TABLE_COLUMNS` is 200. Crossing either refuses the read (`too-many-rows` or `too-many-columns`) instead of allocating an unbounded table. An empty table is refused as `empty`; an unterminated quote keeps the text read so far and is named. The preview keeps only the parse for the current encoding/delimiter settings; changing one drops the previous full table parse, and returning to it reads the bytes again.

## 3. The mapping

The first twenty data rows are shown as a grid in the shared preview. Every column header carries a role dropdown, with the role guessed from English and export synonyms the first time. The mapping is stored locally for the same mode and exact normalised column layout and is reapplied when that layout is imported again; it never leaves the writer's browser. Marking a column Ignore keeps its text out of the import.

### Codex rows

Roles are Name, Aliases, Type, Description, Long text, Tags, Include policy, Image file, Relation to…, Detail field, Scope and Ignore. Name is required; a row without one is named as a loss and skipped.

- **Aliases, tags and lists** split on semicolons first, then commas and newlines. When a cell contains semicolons, commas inside an item stay text; commas separate items only in a cell without semicolons. An entry keeps at most ten aliases, as the codex does; later aliases are left out and named as a loss. A repetition of the entry name or an earlier alias, compared without case, is kept only once because the codex treats those terms as the same name.
- **Type** maps character/person, location/place, object/item, lore, subplot/arc/thread and other synonyms to Caotang types. Every distinct source value gets its own Type becomes choice in the preview, so a writing tool's vocabulary can be mapped explicitly. An unknown word kept as Other is also kept as a keyword, never silently discarded.
- **Cell whitespace.** Names, dates, numbers, types and list items are trimmed; Description, Long text, relation/detail text, Summary and Body keep their surrounding whitespace because it can be meaningful prose or Markdown.
- **Description** becomes the entry description. A description over 2,000 characters is shortened in the entry and kept whole in the entry's research page, with the truncation reported.
- **Long text**, the description, image-file text and preserved detail/relation text are written to the research page. The row has `preferPage`, so the page exists even when the name occurs in an imported document.
- **Include policy** accepts the codex values `always`, `detected`, `manual` and `never`, with ordinary private/secret/GM-only words read as `manual`; an unrecognised value keeps the default.
- **Image file** is preserved as text in the research page and reported as a loss: the table itself cannot supply the image's bytes.
- **Relation to…** and **Detail field** are kept as text on the research page and reported as kept for #223/#221, not converted to typed relations or detail fields. Repeated columns with the same header keep every cell, joined as separate paragraphs.
- **Scope** `world` makes the row lore and the index document is titled **World history**, matching issue #288's world-history decision; other scopes do not change the type.

The index document is placed in Research, never in the manuscript. Codex collision and rename handling are the shared preview's batch rules: an existing name or alias starts skipped and nothing merges into it.

### Timeline rows

Roles are Title, Start, End, Duration, Order, Part/Chapter/Scene marker, folder path, POV, Participants, Location, Arc/plotline, Summary, Body and Ignore. Title is required; a row without one is named as a loss and skipped.

- **Order** is the reading order when every row supplies it; otherwise file order is kept. The preview text blocks use the same order as the scenes, so a selected block names the scene it previews. Caotang's exported `reading index` column maps to it.
- **Hierarchy.** `folder path` is split on `/` and becomes folders under the manuscript. `main` or an empty path falls back to **Imported timeline**. A Part value of `prologue` or `epilogue` becomes the scene's story part; `main` marks it main story.
- **Dates.** ISO dates, explicit day/month/year or month/day/year (chosen by the writer, never guessed silently), `Day N` and signed integers are accepted. A date must fill its cell; trailing text makes it unreadable. An impossible calendar day (2024-02-31) or a day outside the coherence range of −10,000,000 to 10,000,000 is a bad date, never normalized into another day. Absolute dates are epoch days internally and re-anchored to the writer's Day zero choice, which defaults to the earliest dated row; negative offsets stay negative. Caotang's apostrophe formula guard is stripped before any cell is read.
- **Duration** is a safe integer day count or a safe integer count in days, weeks, months or years (7, 30 and 365 days). Without a duration, a start/end pair in the same date basis gives `end - start`, matching the timeline export's end-day arithmetic; a mixed relative/calendar pair cannot measure a duration and supplies none.
- **People and places.** POV and Participants become coherence `pov` and `expectedPresent`; Locations are attached codex entries. Rows create stub codex entries for the names, so the shared batch validator can resolve them, while existing entries are matched case-insensitively by name or alias. Repeated entity names in one list keep their first spelling once, under the same case-insensitive comparison. When the writer renames a colliding stub, the scene declaration follows the renamed imported row rather than the entry it collided with. A name that cannot resolve is omitted rather than inventing text metadata.
- **Arcs.** Arc/plotline values become coherence `threads[]`; one scene keeps the first spelling of a handle repeated only by case, as coherence metadata does. The table format carries no payoff scene, so the last scene in reading order is the fallback payoff; when the row is that same scene the first scene is used instead. A one-scene import cannot pay off its own thread, so that arc is named as a loss.
- **Summary and body.** Summary becomes the scene synopsis; body becomes the document body, with summary used as body when the body column is absent or empty.

## 4. Committing

The table import writes nothing before **Import**. In codex mode the commit is the batch of entries, their research pages and the index document. In timeline mode it is the folder tree, documents, generated or chosen codex entries and scene metadata. A row with no declarations carries no `sceneMeta` at all, so a project without `coherence.json` can still import such a timeline. `binder.importTree` now carries optional `sceneMeta` on document nodes: POV, `dayOffset`, `durationDays`, expected participants, locations, story part/main-story and threads. Validation rewrites source names to existing codex ids or to pending ids of entries in the same batch, rewrites pending payoff scene indexes to document ids, refuses a thread paid off by the very scene that sets it up, rejects a malformed or overlong thread note, and requires the coherence projection whenever scene metadata is present.

The apply writes the metadata into `coherence.json` in the same synchronous batch as the nodes and entries, adds location entry attachments, and its one compensation removes those attachments, the metadata, entries, pages and nodes. Thus the writer's Undo is exactly one step.

## 5. What is counted, never dropped quietly

The preview names an empty or oversized table, an unterminated quote, inconsistent row widths, a missing required Name/Title, an unreadable or impossible date, an unreadable number, an unknown source type, aliases over the ten-entry codex limit, an overlong description, an image filename without image bytes, relation/detail columns kept for their later typed features, and a plotline with no possible payoff scene. The generic injection scan reads every body, synopsis, codex description and research-page body before import.

## 6. What is not built

- Plottr (#290), yWriter (#291), novelWriter (#294) and Scapple (#295); XLSX workbooks are `import-xlsx.md` (#289), whose vendor presets remain unbuilt until real fixtures exist.
- Typed codex relations (#223) and detail fields (#221); table columns for them are preserved as research-page text.
- Reading image bytes named by a table row.
- Importing cell styles, merged cells or a spreadsheet's comments; workbook formulas are read only as cached values by `import-xlsx.md`.

## 7. Tests

Small synthetic CSV/TSV fixtures live under `packages/import-table/test/fixtures`, including a Caotang timeline export, a German semicolon CSV, a base64-held UTF-16 text fixture (kept that way so the repository carries no NUL bytes), a codex bible and an arcs timeline. The dev-only test hook reports codex entries and `sceneMeta` read-only, so the Playwright spec verifies the declarations that actually landed rather than trusting the preview.
