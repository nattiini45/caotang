# Import: CSV / TSV (#288)

Status: **built**. Own reader `@caotang/import-csv` over the shared plain-text reader ([import-read.md](import-read.md)); the preview
is [import-preview.md](import-preview.md), the codex write is [codex.md](codex.md) §7.1.

One importer for every spreadsheet story bible: Aeon, Notion, Miro, Sudowrite, a shot list, and Caotang's own timeline CSV.
A hand-written RFC 4180 reader, as the issue prefers: no papaparse, no dependency, a lazy chunk, nothing executed.

## 1. The grid

`.csv`, `.tsv` or `.txt`. The encoding comes from the shared plain-text reader: UTF-8 with or without a BOM, UTF-16 with a BOM
(Excel's "Unicode text"), and the other encodings it knows. The delimiter is **sniffed** — comma, semicolon (German and French
Excel), tab, pipe — by which one gives the most columns in the most rows, counted outside quotes; the writer can choose one
instead. Quoted fields keep their commas, their doubled quotes and their newlines. A row whose cell count differs from the first
row's is kept and reported, never silently dropped.

## 2. Two modes

| Mode | What a row becomes |
|---|---|
| **Codex entries** (default) | one offered codex row, with a Research page when the row has long text |
| **Timeline / scenes** | one scene, in the order the file gives (or the Order column's) |

The first row is a header unless the writer says otherwise; without one the columns are named `Column 1`, `Column 2`, …

## 3. Columns

Each column's role is guessed from a synonym table (Name ← name / title / character …; Aliases ← aka / also known as / nickname …;
Start ← start / date / day …; POV ← viewpoint / narrator …), and a role is used once, so two "name" columns do not both become the
name. **Every column has its own dropdown in the preview's rules**, so the writer can change any of them; changing one re-reads
the file.

- **Codex roles**: Name (required), Aliases (split on `;`, `,` or a newline), Type, Description, Long text → a Research page,
  Tags → keywords, Include policy, Image file, Relation to… , Detail field, Ignore.
- **Timeline roles**: Title, Start, End, Duration, Order, Marker, POV, Participants, Location, Arc, Summary, Body, Ignore.

A codex row with no name is left out and named in the report. A description longer than 2,000 characters is cut to an excerpt and
the whole text goes to the row's Research page.

## 4. Dates

A date is **never guessed silently**. The writer picks the format — ISO (`2026-01-04`), day-first (`04.01.2026`), month-first
(`01/04/2026`), year-first, or day numbers — and a value that does not fit it is reported, not read as something else. `Day N`
and a plain integer are day offsets in every format, and negative offsets are allowed. The anchor is the date day 0 stands for:
the writer's own when one is given, else **the first date in the file**, which the report names, so the offsets mean something.
A duration reads `3`, `3 days`, `2d` or `1 week`, as whole days.

## 5. What the import writes, and what it approximates

Codex mode writes what `codex.importBatch` carries: name, aliases, type, description, keywords and include policy, with the long
text as the row's own Research page. An image file name, a relation and a detail field are **kept as text on that page** and
reported: the codex has no typed detail fields (#221) and no relations graph (#223) in this build, and `binder.importTree` carries
no visual references.

Timeline mode writes a scene per row with its title, synopsis and body; POV, participants, location and arc become keywords, and
the days, the duration and the order are kept as a **Timeline note** on the scene. The timeline's own fields (`dayOffset`,
`durationDays`, `expectedPresent`, `threads[]`) are not part of `binder.importTree`, so they are reported as an approximation
rather than written; decision 8's arcs are kept as keywords until they can be threads.

## 6. Safety and limits

The parse runs in the preview's `'self'` Worker with a timeout and Cancel, under the shared text reader's size limit. Every
imported text goes through `scanImport`. Nothing is written before **Import**, which commits one `binder.importTree` that one Undo
takes back. There is no `eval`, `new Function` or WebAssembly in the chain.

## 7. Tests

`packages/import-csv/test` reads synthetic files: comma, semicolon, tab and pipe; quoted commas, quotes and newlines; UTF-16 and a
BOM; a story bible with aliases, types and long text; a timeline with ISO dates, `Day N`, durations, POV, participants and arcs; a
ragged row, a nameless row and a date in the wrong format; and the writer's own delimiter, header and column choices.
