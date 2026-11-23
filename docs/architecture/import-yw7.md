# The yWriter import (#291)

The writer opens a `.yw7` file — a yWriter 7 project kept as a single XML file (UTF-8 or UTF-16; the mobile app writes
UTF-16) — from **Import yWriter…** in the manuscript menu. The whole import is the shared preview of
[import-preview.md](import-preview.md): nothing is written until Import, which commits one `binder.importTree` with one
undo. The reader runs in the preview's Worker.

§1 What it reads. The `YWRITER7` element's `CHAPTERS`, `SCENES`, `CHARACTERS`, `LOCATIONS`, `ITEMS` and `PROJECTNOTES`
sections, in document order. A chapter lists its scenes by `Scenes/ScID` into `SCENES`; a scene a chapter never lists
lands in an "Unsorted" chapter at the end. A `CHAPTER` with `SectionStart` opens a part and keeps the scenes it lists
under its own title as the part's first chapter. The reader was written from the file format alone — the upstream
application is GPL — and the shared XML and text readers do the decode and the tag walking (`@caotang/import-read`).

§2 Chapters and scenes. A chapter or scene's `Title` is its name and its `Desc` its synopsis. A scene's `SceneContent`
is its body: `[i]`/`[b]` and `[h1]`–`[h3]` become Markdown emphasis and headings, other `[tag]` pairs are kept as text
and counted in the losses. `Tags` become keywords, `Goal`, `Conflict`, `Outcome` and `Notes` the scene's notes, and a
`Status` of 1-5 a status through the preview's field mapping (the file's own names, or Outline, Draft, First edit,
Second edit, Done). An `Unused` scene gets the `unused` keyword. A `CHAPTER` whose `Type` is not 0 — a notes, to-do or
unused chapter — becomes a Research document with its scenes' text inside it, and `PROJECTNOTES` notes become Research
documents.

§3 Declarations. A scene's `Characters`, `Locations` and `Items` resolve to codex entry names (per section: the ids
restart per list) and are declared `expectedPresent`, the first character is the scene's `pov`, `Day` is its
`dayOffset` and `LastsDays` its `durationDays` — written into the coherence file by `binder.importTree` when the
project holds one (import-preview.md §5), and kept in the notes either way. A `Hour`/`Minute` or `SpecificDateTime`,
and `LastsHours`/`LastsMinutes`, sit in the notes and are named in the losses: the timeline counts whole days, not
dates or clock times.

§4 Codex. `CHARACTERS`, `LOCATIONS` and `ITEMS` become codex rows — character, location, item — `AKA` their aliases
(a comma list), and `Desc`, `Bio`, `Goals`, `Notes` and `FullName` sections on each entry's own page, which is always
created (`preferPage`). A named `ImageFile` is reported; the picture is not in the file.

§5 Losses and refusals. The preview's loss list names the kept-as-text markup tags, the dates, clock times and sub-day
lengths, the pictures that are named but absent, and every chapter the import moved to Research. A file that is not a
`YWRITER7`/`YW7` document, an XML file that does not parse, and one over the text cap are refused before the preview
opens; a file with no chapters, scenes or entries reads as empty.
