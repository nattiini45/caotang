# Office interop: opening Caotang's files in real applications

The `.xlsx` files are written by hand (`packages/exporter/src/render-xlsx.ts`), with no spreadsheet library. Unit tests read the
parts back with a reader of our own, which can forgive what a real application does not. Two checks open the files elsewhere.

## In CI: LibreOffice and openpyxl

The `office-interop` job in `.github/workflows/ci.yml` runs on every push to `main` and every pull request.

1. `packages/exporter/test/xlsx-write-corpus.test.ts` writes the corpus (`xlsx-corpus.ts`) through the exporter's own code path
   to `$CAOTANG_XLSX_OUT`, with `expected.json` beside it: per sheet, its name, title and header, and for every cell the value
   and type (`n` or `s`) a spreadsheet must read back, whether it keeps text as text (`quotePrefix`) and whether it wraps. The
   test checks that file against the workbooks it describes. It writes nothing without the variable, so `pnpm verify` is unchanged.
2. `tools/office-interop/check_xlsx.py` reads every file:
   - **package:** a sound ZIP whose relationships and content types name the workbook, the sheet and the styles;
   - **openpyxl 3.1.5**, with every warning an error: sheet name, title, frozen bold header, and each cell's value, type,
     `quotePrefix` and wrap;
   - **LibreOffice, XLSX to CSV:** the CSV is compared cell for cell (`=SUM(A1)` stays text, CJK, emoji and line breaks survive);
   - **LibreOffice, XLSX to XLSX:** the re-saved file is read with openpyxl, with the same values and types. One known loss is a note, not a failure: LibreOffice reads a literal `_x0041_` correctly (the CSV step checks it exactly) but writes it back unescaped, so its re-saved file holds an `A`. That is LibreOffice's writer, not the file Caotang wrote.

   A cell over 8,000 characters is compared by its first 8,000 under LibreOffice; the cut at 32,767 is checked in full under openpyxl.
   A missing `soffice`, a non-zero exit, an `Error:` line or an empty output fails the run. The corpus and the LibreOffice logs
   are uploaded when it fails.

To run it yourself (LibreOffice and `pip install openpyxl==3.1.5` are not part of `pnpm install`):

```sh
CAOTANG_XLSX_OUT=/tmp/xlsx pnpm exec vitest run packages/exporter/test/xlsx-write-corpus.test.ts
python3 tools/office-interop/check_xlsx.py /tmp/xlsx                         # package, openpyxl and LibreOffice
python3 tools/office-interop/check_xlsx.py /tmp/xlsx --skip-libreoffice      # without LibreOffice
```

This is not a check in Excel or Numbers. Excel's "repair" prompt cannot be scripted.

## By hand: Excel, Numbers and Google Sheets

Before a release that changes `render-xlsx.ts` or either table, write the corpus (above), open each file in each application
below, and record the version, the date and the result in the table. Do not describe the files as checked in an application until
its row is filled in.

For each of `dialogue.xlsx`, `shot-list.xlsx` and `sheet-name.xlsx`:

- [ ] Opens with **no** repair prompt. Excel: "We found a problem with some content". Numbers: an import warnings sheet.
- [ ] The sheet tab shows the expected name (`sheet-name.xlsx`: `Shot list   draft  v2`). File › Properties shows the workbook title.
- [ ] Row 1 is bold and stays in view when scrolling.
- [ ] Shot numbers, durations and character limits are numbers: right-aligned, and `SUM` over the column works.
- [ ] `=SUM(A1)`, `+1`, `-x` and `@x` show as text, and stay text after you edit the cell and press Enter (Excel's `quotePrefix`).
- [ ] Accents, CJK, emoji and line breaks show correctly. Multi-line cells wrap.
- [ ] The 32,767-character cell in `shot-list.xlsx` opens and is cut where the compile log said.
- [ ] `_x0041_` shows literally as `_x0041_`, not as `A`.
- [ ] Column widths are readable (not 0, not huge).
- [ ] Save as `.xlsx` from the application over a copy of the file in a copy of the corpus folder, then run
      `check_xlsx.py <folder> --skip-libreoffice` on that folder: the values are unchanged.

| Application | Version | Date | Result | Notes |
| --- | --- | --- | --- | --- |
| Excel 365 for Windows | | | not recorded | |
| Excel 365 for Mac | | | not recorded | |
| Excel for the web | | | not recorded | |
| Numbers (current macOS) | | | not recorded | |
| Google Sheets | | | not recorded | |

## Word contents field (#26)

`.docx` files hold a contents field (`TOC \h \o "1-2"`) with cached entries, written by `packages/exporter/src/render-docx.ts`.
`updateFields` is set in the settings only when that field is. Unit tests read the XML back (`packages/exporter/test/docx.test.ts`,
`docx-write-corpus.test.ts`). No application has opened the files yet; nothing below is ticked until a person has done it.

The cached entries carry titles and no page numbers, and they are not links. Word fills in page numbers when the field is updated,
and its regenerated entries are clickable (`\h`). A viewer that never updates fields shows the titles only.

Write the files:

```sh
CAOTANG_DOCX_OUT=/tmp/docx pnpm exec vitest run packages/exporter/test/docx-write-corpus.test.ts
```

`expected.json` lists, per file, whether it holds a contents field and its entry titles in order. The files: `toc-3-chapters.docx`,
`toc-unicode.docx` (accents, CJK, emoji, `&`, `<`, quotes), `toc-one-chapter.docx`, `toc-off.docx` (no contents field) and
`toc-long.docx` (40 chapters).

For each of `toc-3-chapters.docx`, `toc-unicode.docx`, `toc-one-chapter.docx` and `toc-long.docx`, in each application below:

- [ ] On open, the prompt is recorded word for word (Word: "This document contains fields that may refer to other files. Do you want to update the fields in this document?"), with its buttons.
- [ ] **Yes:** the contents list shows every chapter title in order, with page numbers, in the TOC 1 style; nothing is duplicated.
- [ ] **No:** the cached titles show, in order, without page numbers.
- [ ] After **Yes**, saving and reopening does not ask a second time.
- [ ] The titles in `toc-unicode.docx` read as in `expected.json`.
- [ ] `toc-one-chapter.docx` shows one entry and no stray empty line above or below it.
- [ ] After updating: Right-click › Update Field (or F9) works, and Ctrl-click on an entry opens its chapter.

For `toc-off.docx`:

- [ ] Opens with **no** prompt about fields, and has no contents list.

| Application | Version | Date | Result | Notes |
| --- | --- | --- | --- | --- |
| Word 365 for Windows | | | not recorded | |
| Word 365 for Mac | | | not recorded | |
| Word for the web | | | not recorded | |
| Pages (current macOS) | | | not recorded | |
| Google Docs | | | not recorded | |

Owner-pending. Until a row is filled in, the docs say the field has not been tested in Word or LibreOffice. LibreOffice never
updates fields on open; a scripted check of the structure is a later step and is not part of this checklist.
