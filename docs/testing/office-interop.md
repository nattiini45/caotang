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
