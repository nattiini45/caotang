# The Excel workbook table import 🧭

> Status: the package `packages/import-xlsx` (`@caotang/import-xlsx`) is **built** (#289), and **Import spreadsheet…** in the binder calls it through the same table preview as CSV/TSV (#288) in the `'self'` Worker host (#390). It reads one worksheet of an `.xlsx` workbook into codex entries or timeline scenes, writes one `binder.importTree`, and takes the whole import back with one Undo. Epic: #263.

## 1. Purpose

A character bible or timeline often already exists as an Excel workbook. The workbook reader turns one worksheet into the same rectangular rows the CSV/TSV import maps, so the writer keeps one preview, one column-mapping UI and one commit path. The reader is own code (MIT), pure and DOM-free. It has no SheetJS or other third-party spreadsheet dependency, no `eval`, no `new Function` and no WebAssembly.

A workbook is untrusted input. Nothing in it runs: macros, external links, active content and formulas are never executed, fetched or calculated. The reader uses the shared zip and XML readers from `@caotang/import-read` and stays inside their archive caps.

## 2. Reading

- **Input.** The binder button accepts `.csv`, `.tsv`, `.txt` and `.xlsx`. The bytes decide: a file starting with the zip local-file signature `PK\x03\x04` is opened as a workbook whatever its name, and other bytes stay on the delimited-text reader. The preview checks `file.size` before reading the file; a workbook over the shared archive byte cap is refused before its bytes are read.
- **Workbook parts.** `xl/workbook.xml` and its relationships name the worksheets; `xl/sharedStrings.xml` supplies shared strings; `xl/styles.xml` supplies number formats; `xl/worksheets/sheetN.xml` supplies cells. A root-relative relationship target is followed inside the package. Nothing outside the package is followed.
- **Worksheet choice.** The first populated worksheet is read first; an empty leading sheet does not block later populated sheets. When the workbook holds more than one readable worksheet, the preview shows a Worksheet choice by the writer-visible sheet name; changing it re-reads that sheet in the Worker. Chart sheets and other non-worksheet parts are not choices. A requested name the workbook does not hold is refused.
- **Cell values.** Shared strings and inline strings are text, with SpreadsheetML `_xHHHH_` character escapes undone. Numbers become plain CSV-like numerals. Booleans become `TRUE` or `FALSE`. Error cells are kept as their error text (`#REF!`, `#N/A`, …) and counted in the report. A formula is never calculated: its cached result in the file is read, and formula cells are counted in the report.
- **Dates.** A numeric cell whose built-in or custom number format is a date/time format becomes `YYYY-MM-DD`. Both the 1900 system and the older Mac 1904 system are honoured. The 1900 system's fictitious serial 60 reads as 1900-02-28 rather than shifting every later date. A time of day is not kept, because the table mapper's dates are whole days; each such cell is counted as a loss. A time-only format emits no fabricated calendar date at all. A numeric cell outside the serial range a spreadsheet date can hold stays a numeral rather than crashing the reader.
- **Rows.** Sparse cells keep their columns, so an empty cell inside a row stays empty. Wholly blank rows are dropped, exactly as the RFC 4180 reader drops them. Rows keep their worksheet row numbers for mapping warnings.
- **Caps.** Worksheet output uses the shared table caps, 10,000 rows and 200 columns, because wider or taller output cannot be mapped in the table preview. A cell reference beyond Excel's own last column XFD (16,384 columns) is refused before allocation. At most 2,000,000 cell elements are read. Text in a cell is cut at Excel's own 32,767-character limit, and every cut cell is counted as a loss. A workbook with no readable sheet rows is refused as empty.

## 3. Mapping and committing

The rows enter `@caotang/import-table` unchanged after this reader: the same first-twenty-rows grid, header choice, column-role dropdowns, codex/timeline modes, date-format and day-zero choices, local mapping memory, collision handling, losses and injection scan apply. A mapping saved for a normalised column layout is reapplied when that layout is imported again, whether the rows came from delimited text or a workbook.

The commit is exactly the table import's commit: one `binder.importTree` carrying nodes, codex entries, research pages and scene metadata, with one Undo. The workbook reader adds no second write path.

## 4. What is counted, never dropped quietly

The preview names a workbook or sheet that cannot be read, a worksheet cap refusal, a date cell whose time of day is not kept, a cell cut at the character limit and the table mapping's own losses. The report counts formulas read as cached values and error cells kept as text. Other worksheets are not imported unless the writer chooses them; the chosen Worksheet control makes that scope visible. Imported text reaches the same injection scan as CSV/TSV rows.

## 5. Vendor presets

The Aeon Timeline, Notion and Miro presets are **not built**. Issue #289 makes real exported fixtures the precondition for keying a preset to a header hash, and those fixtures were not available when the reader shipped. The writer-controlled mapping UI and the locally remembered column mappings ship instead; no preset is guessed from lookalike headers.

## 6. What is not built

- Cell formatting, currencies, percentages, merged cells, comments, images and time-of-day values.
- Recalculating formulas or following external workbook links.
- Importing several worksheets in one commit.
- StudioBinder/Boords shot-list semantics; those belong to their own formats when real fixtures and the storyboard contract exist.

## 7. Tests

Small synthetic SpreadsheetML workbooks are generated by `packages/import-xlsx/test/fixtures/workbook.ts`, so no real workbook or vendor export is copied. The unit tests cover shared and inline strings, sparse rows, cached formulas, errors, both date systems, times, sheet choice, archive and worksheet refusals, cell caps, root-relative targets and equality with a CSV twin. The shared-preview unit tests cover the worksheet chip and re-read; the Playwright table spec covers choosing a workbook, switching worksheets, importing the chosen rows and one Undo in the real reader Worker.
