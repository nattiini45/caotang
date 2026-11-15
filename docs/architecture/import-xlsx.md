# Import: Excel workbooks (#289)

Status: **built** (the workbook reader and its worksheet picker). Own reader `@caotang/import-xlsx` on the shared zip and XML layer
([import-read.md](import-read.md)); the mapping is the spreadsheet reader's own ([import-csv.md](import-csv.md)), the preview is
[import-preview.md](import-preview.md). The mapping presets the issue also asks for (Aeon, Notion, Miro, Caotang's own timeline,
and a writer's saved preset) are **not built yet**; they are the next pull request for #289.

**Import spreadsheet…** takes an `.xlsx` beside `.csv`, `.tsv` and `.txt`. A workbook is a zip, so the bytes decide: a file that
starts with `PK` is opened as a workbook, whatever it is named. No SheetJS: the issue rules it out on licence and size, and a
workbook is a zip of XML this project already reads. Nothing here runs, fetches or evaluates; a macro is never read.

## 1. What is read

| Part | What it gives |
|---|---|
| `xl/workbook.xml` | the worksheets, in the writer's order, and `workbookPr/@date1904` |
| `xl/_rels/workbook.xml.rels` | where each worksheet's part sits (a target may name its path from the package root) |
| `xl/sharedStrings.xml` | the shared strings, including a string written as runs; phonetic reading aids are not text |
| `xl/styles.xml` | `cellXfs` → `numFmtId` → the number format code, built-in or custom |
| `xl/worksheets/sheetN.xml` | the cells: shared (`t="s"`) and inline (`t="inlineStr"`) strings, numbers, booleans (`TRUE`/`FALSE`), error values, and a formula's **cached value** (`t="str"` or `v` beside `f`) |

A cell's reference (`BC12`) places it, so a sparse row keeps its empty columns and a skipped row stays a blank row. Trailing blank
rows are dropped, and every row is as wide as the widest, which is the grid a CSV of that sheet would give.

**A formula is never calculated.** Its cached value is read as the cell's text; the report says how many cells were read that way.
An error value (`#REF!`, `#N/A`) is kept as its text and counted.

## 2. Dates

A number cell whose style's format shows a date becomes `YYYY-MM-DD`, so the shared mapping reads it in its `iso` format without
the writer choosing anything. The format is a date when, with quoted words and bracketed sections (`[Red]`, `[$-407]`) removed, it
holds a date or time letter and no `General`; the built-in date ids (14–22, 27–36, 45–47, 50–58) count as dates too.

The serial is counted in the workbook's own system: 1900 (base 1899-12-31) or 1904 (base 1904-01-01, older Mac Excel). The 1900
system carries Lotus 1-2-3's leap-year bug: serial 60 is the 29th of February 1900, a day that never was, so it reads as the 28th
and every later serial sits one day earlier than a plain count. **A time of day is not kept**: the day is, and the report counts
the cells whose time was dropped.

## 3. The preview

The same source as the CSV import (`spreadsheet-source.ts`), with the delimiter chip replaced by a **Worksheet** chip when the
workbook holds more than one sheet. Choosing another sheet reads it again; the mode, the header, the date format and every column's
role work exactly as they do for a CSV, and each mode keeps its own column choices. The report names the worksheet the rows came
from, how many sheets the workbook holds, and the formulas, times and error cells above.

Everything else is the shared preview's: nothing is written before **Import**, one `binder.importTree` commits it, one Undo takes it
back, and every imported text goes through `scanImport`.

## 4. Safety and limits

The workbook is opened by the shared zip reader inside the preview's `'self'` Worker, under its caps (archive size, entry count,
entry size, total size, compression ratio) with a timeout and Cancel. A worksheet is refused above **100,000 rows** or **2,000,000
cells**, and a cell is cut at Excel's own 32,768 characters. A zip that is no workbook, a workbook with no sheets, and a sheet name
the workbook does not hold are refused in the writer's words. There is no `eval`, `new Function` or WebAssembly in the chain.

Not read: charts, pivot tables, cell comments, pictures, conditional formatting, data validation, defined names and macros. A
workbook whose text lives only in those carries no rows, and the preview says the sheet has no rows rather than inventing any.

## 5. Tests

`packages/import-xlsx/test` writes synthetic workbooks: shared and inline strings, numbers and booleans, a sparse sheet, cached
formulas and an error cell, dates in both systems with the leap-year bug, a time of day, the sheet picker, a root-relative
relationship target, a zip that is no workbook, a sheet over the row cap, and **a workbook and its CSV twin read to the same rows**.
`apps/desktop/test/import-splitter-source.test.ts` reads a two-sheet workbook through the preview source; `e2e/import-xlsx.spec.ts`
imports one in the app and switches its worksheet.
