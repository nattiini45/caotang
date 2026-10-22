#!/usr/bin/env python3
"""The XLSX interop gate: opens the workbooks the exporter wrote in two readers other than our own, and fails when either reads
something other than what expected.json says.

Run: `CAOTANG_XLSX_OUT=<dir> pnpm exec vitest run packages/exporter/test/xlsx-write-corpus.test.ts`, then
`python3 tools/office-interop/check_xlsx.py <dir> [--skip-libreoffice]`. CI's office-interop job does both.

  (0) the package: a sound ZIP whose relationships and content types name the workbook, the sheet and the styles, and whose
      targets exist. openpyxl finds the styles by their path, whether or not a relationship points at them, so this is checked
      here, and it is what Excel repairs.
  (a) openpyxl (3.1.5, `pip install openpyxl==3.1.5`) reads each file directly, with every warning an error: the sheet name, the
      workbook title, the frozen bold header, and for every cell its value, its type (n or s), Excel's quotePrefix and wrapText.
  (b) LibreOffice converts each file to CSV, and the CSV is compared cell for cell: a number is a number, `=SUM(A1)` is the text
      `=SUM(A1)` and not 0, and the CJK, the emoji and the line breaks survive.
  (c) LibreOffice re-saves each file as XLSX, and openpyxl reads the result: the same values and types, so nothing was turned
      into a formula, or a number into text, on the way through.

LibreOffice is `soffice` on PATH. With --skip-libreoffice only (a) runs; without it, a missing soffice is a failure, not a skip:
a gate that quietly checks nothing is the failure it exists to prevent. soffice exits 0 for some failures, so every output must
exist and be non-empty, and an `Error:` line on its output fails the run. Its raw output goes to <dir>/logs for CI to upload.

openpyxl does not decode the `_xHHHH_` escapes of an XLSX string (ECMA-376 ST_Xstring); LibreOffice does. So openpyxl's text is
decoded here before it is compared, with the same rule Excel uses.

A cell longer than LONG characters is compared by its first LONG characters in (b) and (c): LibreOffice has limited the length
of a cell it imports before, and the cut at 32,767 characters is checked in full in (a).
"""

import csv
import json
import re
import shutil
import subprocess
import sys
import tempfile
import warnings
import zipfile
from pathlib import Path
from xml.etree import ElementTree
from typing import Any, Optional

import openpyxl

LONG = 8000
SOFFICE_TIMEOUT = 300
CSV_FILTER = "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true"

failures: list[str] = []


def fail(file: str, check: str, message: str) -> None:
    failures.append(f"{file}: {check}: {message}")
    print(f"FAIL {file} [{check}] {message}")


def unescape_excel(text: str) -> str:
    """Excel's reading of an `_xHHHH_` escape."""
    return re.sub(r"_x([0-9A-Fa-f]{4})_", lambda m: chr(int(m.group(1), 16)), text)


def same_text(want: str, got: str, loose: bool) -> bool:
    if loose and len(want) > LONG:
        return len(got) >= LONG and got[:LONG] == want[:LONG]
    return got == want


def compare_cells(file: str, check: str, book: dict[str, Any], ws: Any, strict_flags: bool) -> None:
    """Compares the sheet's cells with the book's rows: value and type, and the style flags when `strict_flags` (check a)."""
    loose = not strict_flags
    for r, row in enumerate(book["rows"], start=2):
        for c, want in enumerate(row, start=1):
            ref = f"{openpyxl.utils.get_column_letter(c)}{r}"
            cell = ws.cell(row=r, column=c)
            if want is None:
                if cell.value is not None:
                    fail(file, check, f"{ref} should be empty, got {cell.value!r}")
            elif want["t"] == "n":
                if cell.data_type != "n" or cell.value != want["v"]:
                    fail(file, check, f"{ref} should be the number {want['v']!r}, got {cell.data_type!r} {cell.value!r}")
            else:
                got = unescape_excel(cell.value) if isinstance(cell.value, str) else cell.value
                if cell.data_type != "s" or not isinstance(got, str) or not same_text(want["v"], got, loose):
                    fail(file, check, f"{ref} should be the text {want['v'][:80]!r}, got {cell.data_type!r} {str(got)[:80]!r}")
                if strict_flags:
                    if bool(cell.quotePrefix) != bool(want.get("quotePrefix")):
                        fail(file, check, f"{ref} quotePrefix should be {bool(want.get('quotePrefix'))}, got {cell.quotePrefix}")
                    if bool(cell.alignment.wrap_text) != bool(want.get("wrap")):
                        fail(file, check, f"{ref} wrap_text should be {bool(want.get('wrap'))}, got {cell.alignment.wrap_text}")
    if ws.max_row != len(book["rows"]) + 1:
        fail(file, check, f"the sheet has {ws.max_row} rows, expected {len(book['rows']) + 1}")


def check_openpyxl(path: Path, book: dict[str, Any]) -> None:
    """(a) The file as written."""
    name = book["file"]
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        try:
            wb = openpyxl.load_workbook(path)
        except Exception as error:  # a warning is an error here: openpyxl met a part it repairs or drops
            fail(name, "openpyxl", f"does not load cleanly: {error!r}")
            return
    if wb.sheetnames != [book["sheet"]]:
        fail(name, "openpyxl", f"sheets are {wb.sheetnames!r}, expected {[book['sheet']]!r}")
        return
    ws = wb.active
    if wb.properties.title != book["title"]:
        fail(name, "openpyxl", f"the workbook title is {wb.properties.title!r}, expected {book['title']!r}")
    pane = ws.sheet_view.pane
    if ws.freeze_panes != "A2" or pane is None or pane.state != "frozen":
        fail(name, "openpyxl", f"row 1 is not frozen: freeze_panes {ws.freeze_panes!r}, pane state {getattr(pane, 'state', None)!r}")
    for c, label in enumerate(book["columns"], start=1):
        cell = ws.cell(row=1, column=c)
        if cell.value != label or cell.data_type != "s" or not cell.font.b:
            fail(name, "openpyxl", f"header {c} should be the bold text {label!r}, got {cell.value!r} bold={cell.font.b}")
    compare_cells(name, "openpyxl", book, ws, strict_flags=True)


REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
TYPES_NS = "{http://schemas.openxmlformats.org/package/2006/content-types}"
OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
SHEET_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml."


def check_package(path: Path, book: dict[str, Any]) -> None:
    """(0) The ZIP, its relationships and its content types."""
    name = book["file"]
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            if archive.testzip() is not None:
                fail(name, "package", "the ZIP has a corrupt entry")
            rels = {
                part: {r.get("Type", ""): r.get("Target", "") for r in ElementTree.fromstring(archive.read(part)).iter(f"{REL_NS}Relationship")}
                for part in ("_rels/.rels", "xl/_rels/workbook.xml.rels")
            }
            types = ElementTree.fromstring(archive.read("[Content_Types].xml"))
    except (KeyError, zipfile.BadZipFile, ElementTree.ParseError) as error:
        fail(name, "package", f"is not a package: {error!r}")
        return
    if rels["_rels/.rels"].get(OFFICE_REL + "officeDocument") != "xl/workbook.xml":
        fail(name, "package", "the package relationships do not point at xl/workbook.xml")
    for kind, part in (("worksheet", "xl/worksheets/sheet1.xml"), ("styles", "xl/styles.xml")):
        target = rels["xl/_rels/workbook.xml.rels"].get(OFFICE_REL + kind)
        if target is None or f"xl/{target}" != part or part not in names:
            fail(name, "package", f"the workbook has no {kind} relationship to an existing {part}")
    overrides = {o.get("PartName"): o.get("ContentType") for o in types.iter(f"{TYPES_NS}Override")}
    for part, kind in (("/xl/workbook.xml", "sheet.main+xml"), ("/xl/worksheets/sheet1.xml", "worksheet+xml"), ("/xl/styles.xml", "styles+xml")):
        if overrides.get(part) != SHEET_TYPE + kind:
            fail(name, "package", f"{part} has content type {overrides.get(part)!r}, expected {SHEET_TYPE + kind!r}")


def soffice_path() -> Optional[str]:
    return shutil.which("soffice") or shutil.which("libreoffice")


def convert(soffice: str, files: list[Path], target: str, out: Path, logs: Path, tag: str) -> bool:
    """One soffice call over all the files, on a throwaway profile. True when every output exists and is non-empty."""
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="lo-profile-") as profile:
        command = [
            soffice,
            "--headless",
            "--norestore",
            f"-env:UserInstallation={Path(profile).as_uri()}",
            "--convert-to",
            target,
            "--outdir",
            str(out),
            *[str(f) for f in files],
        ]
        try:
            run = subprocess.run(command, capture_output=True, text=True, timeout=SOFFICE_TIMEOUT)
        except subprocess.TimeoutExpired:
            fail("soffice", tag, f"did not finish in {SOFFICE_TIMEOUT} seconds")
            return False
    (logs / f"soffice-{tag}.log").write_text(f"$ {' '.join(command)}\nexit {run.returncode}\n--- stdout\n{run.stdout}\n--- stderr\n{run.stderr}\n", encoding="utf-8")
    ok = True
    if run.returncode != 0:
        fail("soffice", tag, f"exited {run.returncode}")
        ok = False
    for line in (run.stdout + run.stderr).splitlines():
        if "Error:" in line:
            fail("soffice", tag, line.strip())
            ok = False
    return ok


def read_csv(path: Path) -> list[list[str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.reader(handle))


def check_csv(book: dict[str, Any], path: Path) -> None:
    """(b) LibreOffice's CSV of the file, against the book."""
    name = book["file"]
    if not path.is_file() or path.stat().st_size == 0:
        fail(name, "libreoffice-csv", "LibreOffice wrote no CSV, or an empty one")
        return
    grid = read_csv(path)
    if len(grid) != len(book["rows"]) + 1:
        fail(name, "libreoffice-csv", f"the CSV has {len(grid)} rows, expected {len(book['rows']) + 1}")
        return
    if grid[0] != book["columns"]:
        fail(name, "libreoffice-csv", f"the header is {grid[0]!r}, expected {book['columns']!r}")
    for r, row in enumerate(book["rows"], start=1):
        got_row = grid[r] + [""] * (len(row) - len(grid[r]))
        for c, want in enumerate(row):
            got = got_row[c]
            ref = f"{openpyxl.utils.get_column_letter(c + 1)}{r + 1}"
            if want is None:
                if got != "":
                    fail(name, "libreoffice-csv", f"{ref} should be empty, got {got[:80]!r}")
            elif want["t"] == "n":
                try:
                    same = float(got) == want["v"]
                except ValueError:
                    same = False
                if not same:
                    fail(name, "libreoffice-csv", f"{ref} should be the number {want['v']!r}, got {got[:80]!r}")
            elif not same_text(want["v"], got, loose=True):
                fail(name, "libreoffice-csv", f"{ref} should be the text {want['v'][:80]!r}, got {got[:80]!r}")


def check_resaved(book: dict[str, Any], path: Path) -> None:
    """(c) The file LibreOffice re-saved, read by openpyxl."""
    name = book["file"]
    if not path.is_file() or path.stat().st_size == 0:
        fail(name, "libreoffice-xlsx", "LibreOffice wrote no XLSX, or an empty one")
        return
    try:
        wb = openpyxl.load_workbook(path)
    except Exception as error:
        fail(name, "libreoffice-xlsx", f"the re-saved file does not load: {error!r}")
        return
    if wb.sheetnames != [book["sheet"]]:
        fail(name, "libreoffice-xlsx", f"sheets are {wb.sheetnames!r}, expected {[book['sheet']]!r}")
        return
    compare_cells(name, "libreoffice-xlsx", book, wb.active, strict_flags=False)


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    skip_libreoffice = "--skip-libreoffice" in argv[1:]
    if len(args) != 1:
        print(__doc__)
        return 2
    directory = Path(args[0]).resolve()
    expected_path = directory / "expected.json"
    if not expected_path.is_file():
        print(f"{expected_path} not found: write the corpus first")
        return 2
    books = json.loads(expected_path.read_text(encoding="utf-8"))["files"]
    if not books:
        print("expected.json lists no files")
        return 2
    logs = directory / "logs"
    logs.mkdir(exist_ok=True)

    files: list[Path] = []
    for book in books:
        path = directory / book["file"]
        if not path.is_file() or path.stat().st_size == 0:
            fail(book["file"], "corpus", "the file is missing or empty")
            continue
        files.append(path)
        check_package(path, book)
        check_openpyxl(path, book)

    if not skip_libreoffice and files:
        soffice = soffice_path()
        if soffice is None:
            fail("soffice", "libreoffice", "LibreOffice is not on PATH (soffice); install libreoffice-calc, or pass --skip-libreoffice")
        else:
            by_file = {b["file"]: b for b in books}
            if convert(soffice, files, CSV_FILTER, directory / "lo-csv", logs, "csv"):
                for f in files:
                    check_csv(by_file[f.name], directory / "lo-csv" / f"{f.stem}.csv")
            if convert(soffice, files, "xlsx:Calc MS Excel 2007 XML", directory / "lo-xlsx", logs, "xlsx"):
                for f in files:
                    check_resaved(by_file[f.name], directory / "lo-xlsx" / f.name)

    if failures:
        print(f"\n{len(failures)} problem(s)")
        return 1
    print(f"ok: {len(files)} file(s) read by openpyxl" + ("" if skip_libreoffice else " and LibreOffice"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
