#!/usr/bin/env python3
"""The DOCX contents-field interop gate: opens the Word files the exporter wrote in LibreOffice, and fails when the
contents field is not what expected.json says — a real, updatable field whose cached entries are what every viewer
shows first.

Run: `CAOTANG_DOCX_OUT=<dir> pnpm exec vitest run packages/exporter/test/docx-write-corpus.test.ts`, then
`python3 tools/office-interop/check_docx.py <dir> [--skip-libreoffice]`. CI's office-interop job does both.

  (0) the package: a sound ZIP naming word/document.xml, word/styles.xml and word/settings.xml, and in the document
      the field itself — a complex `w:fldChar` field (begin, `instrText` instruction, separate, cached text, end) with
      no `w:sdt` wrapper, `w:updateFields` in the settings when and only when the file has contents, and `w:outlineLvl`
      on the Heading styles, which a `\\o` field collects its entries by. The packed single-run `w:sdt` shape is the one
      LibreOffice flattens to dead text, so its absence is asserted.
  (a) the cache is visible: LibreOffice converts each file to PDF, `pdftotext -layout` reads it, and the region between
      the `Contents` heading and the first chapter heading must list every expected title, in order — and must not
      show the field's instruction as text. For `toc-off` there is no `Contents` page at all.
  (b) the field survives a LibreOffice re-save: `soffice --convert-to docx` re-writes each file, and the re-saved
      `word/document.xml` must still hold a `TOC` field instruction — proof LibreOffice imported it as an index and not
      flat text.
  (c) LibreOffice can regenerate it: over a UNO socket (`python3-uno`), each file's `getDocumentIndexes()` must hold at
      least one index, `.update()` must repopulate it, and the exported PDF must list every expected title with a page
      number, which only an index can produce.
  (d) hyperlinks: on the (c) PDF, `pdftohtml -xml` must show every contents entry as a link to the page its trailing
      number names. The cached entries in the (a) PDF are plain text by design (no `_Toc` bookmarks exist to link to),
      which is recorded as a NOTE, not a failure.

LibreOffice is `soffice` on PATH; `pdftotext` and `pdftohtml` are poppler-utils; (c) needs `python3-uno`. With
--skip-libreoffice only (0) runs; without it, a missing soffice is a failure, not a skip: a gate that quietly checks
nothing is the failure it exists to prevent. soffice exits 0 for some failures, so every output must exist and be
non-empty, and an `Error:` line on its output fails the run. Its raw output goes to <dir>/logs for CI to upload.
"""

import json
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any, Optional

SOFFICE_TIMEOUT = 300
UNO_CONNECT_TRIES = 60

failures: list[str] = []


def fail(file: str, check: str, message: str) -> None:
    failures.append(f"{file}: {check}: {message}")
    print(f"FAIL {file} [{check}] {message}")


def note(file: str, check: str, message: str) -> None:
    print(f"NOTE {file} [{check}] {message}")


def soffice_path() -> Optional[str]:
    return shutil.which("soffice") or shutil.which("libreoffice")


REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
TYPES_NS = "{http://schemas.openxmlformats.org/package/2006/content-types}"
OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
WORD_NS = "application/vnd.openxmlformats-officedocument.wordprocessingml."


def read_parts(path: Path) -> Optional[dict[str, str]]:
    """Every XML part of the package, decoded, or None when the zip is not a document."""
    try:
        with zipfile.ZipFile(path) as archive:
            if archive.testzip() is not None:
                fail(path.name, "package", "the ZIP has a corrupt entry")
                return None
            return {name: archive.read(name).decode("utf-8", "replace") for name in archive.namelist() if name.endswith(".xml") or name.endswith(".rels")}
    except zipfile.BadZipFile as error:
        fail(path.name, "package", f"is not a package: {error!r}")
        return None


def check_package(path: Path, book: dict[str, Any]) -> None:
    """(0) The ZIP, its contents field in raw XML, and the settings and styles it depends on."""
    name = book["file"]
    parts = read_parts(path)
    if parts is None:
        return
    for part in ("word/document.xml", "word/styles.xml", "word/settings.xml"):
        if part not in parts:
            fail(name, "package", f"has no {part}")
            return
    body = parts["word/document.xml"]
    settings = parts["word/settings.xml"]
    styles = parts["word/styles.xml"]

    contents = bool(book["contents"])
    for marker in ('<w:fldChar w:fldCharType="begin"', "instrText", '<w:fldChar w:fldCharType="separate"', '<w:fldChar w:fldCharType="end"'):
        if (marker in body) != contents:
            fail(name, "package", f"{marker!r} should {'be present' if contents else 'be absent'}")
    if contents:
        if "TOC \\h \\o" not in body:
            fail(name, "package", "the field instruction does not read TOC \\h \\o")
        if "<w:sdt" in body:
            fail(name, "package", "the field sits inside a w:sdt control, the shape LibreOffice flattens")
        if "<w:outlineLvl" not in styles:
            fail(name, "package", "the Heading styles carry no w:outlineLvl, so a regenerated table comes out empty")
    else:
        if "TOC \\h" in body:
            fail(name, "package", "a TOC instruction is present although the recipe turns the contents off")
    if ("<w:updateFields/>" in settings) != contents:
        fail(name, "package", f"word/settings.xml should {'carry' if contents else 'not carry'} <w:updateFields/>")


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
    for f in files:
        produced = out / f"{f.stem}.{tag.split(':')[0]}"
        if not produced.is_file() or produced.stat().st_size == 0:
            fail(f.name, tag, "LibreOffice wrote no output, or an empty one")
            ok = False
    return ok


def pdf_text(path: Path) -> Optional[str]:
    """pdftotext -layout output, or None when poppler cannot read the file."""
    try:
        run = subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, text=True, timeout=60)
    except (subprocess.TimeoutExpired, FileNotFoundError) as error:
        fail(path.name, "pdftotext", f"{error!r}")
        return None
    if run.returncode != 0:
        fail(path.name, "pdftotext", f"exited {run.returncode}: {run.stderr.strip()[:200]}")
        return None
    return run.stdout


def contents_region(name: str, check: str, text: str, entries: list[str]) -> Optional[list[str]]:
    """The lines between the `Contents` heading and the first chapter heading — the table as a viewer shows it."""
    lines = [line.strip() for line in text.splitlines()]
    try:
        start = lines.index("Contents")
    except ValueError:
        fail(name, check, "no Contents heading in the PDF text")
        return None
    end = len(lines)
    for i in range(start + 1, len(lines)):
        # The first chapter's bare heading ends the table; an entry carries dot leaders or a page number, never bare.
        if lines[i] == entries[0]:
            end = i
            break
    return [line for line in lines[start + 1 : end] if line]


def check_cached_visible(book: dict[str, Any], path: Path) -> None:
    """(a) The cached entries in the PDF LibreOffice renders."""
    name = book["file"]
    text = pdf_text(path)
    if text is None:
        return
    if not book["contents"]:
        for line in text.splitlines():
            if line.strip() == "Contents":
                fail(name, "libreoffice-pdf", "a Contents page exists although the recipe turns the contents off")
                return
        return
    region = contents_region(name, "libreoffice-pdf", text, book["entries"])
    if region is None:
        return
    at = 0
    for title in book["entries"]:
        found = False
        while at < len(region):
            if region[at].startswith(title):
                found = True
                at += 1
                break
            at += 1
        if not found:
            fail(name, "libreoffice-pdf", f"the contents table does not list {title!r} in order")
    for line in region:
        if "TOC \\h" in line or "instrText" in line:
            fail(name, "libreoffice-pdf", f"the field instruction shows as text: {line[:80]!r}")


def check_resaved(book: dict[str, Any], path: Path) -> None:
    """(b) The file LibreOffice re-saved: the field must survive as a field."""
    name = book["file"]
    parts = read_parts(path)
    if parts is None:
        return
    body = parts.get("word/document.xml", "")
    has_toc = bool(re.search(r"instrText[^<]*TOC|fldSimple[^>]*TOC", body))
    if has_toc != bool(book["contents"]):
        fail(name, "libreoffice-docx", f"the re-saved document {'keeps no TOC instruction' if book['contents'] else 'still carries a TOC instruction'}")


def uno_context(soffice: str, port: int, profile: str, logs: Path):
    """A running soffice listening on a UNO socket, and a resolver context for it."""
    proc = subprocess.Popen(
        [
            soffice,
            "--headless",
            "--norestore",
            "--invisible",
            f"-env:UserInstallation={Path(profile).as_uri()}",
            f"--accept=socket,host=127.0.0.1,port={port};urp;",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    import uno  # python3-uno

    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    for _ in range(UNO_CONNECT_TRIES):
        try:
            ctx = resolver.resolve(f"uno:socket,host=127.0.0.1,port={port};urp;StarOffice.ComponentContext")
            return proc, ctx
        except Exception:
            time.sleep(1)
    proc.terminate()
    fail("soffice", "libreoffice-uno", f"the UNO socket on port {port} never came up")
    return None, None


def check_regenerated(books: list[dict[str, Any]], directory: Path, logs: Path, out: Path) -> dict[str, Path]:
    """(c) Every file's indexes over UNO, updated and exported to PDF. Returns file name → exported PDF."""
    soffice = soffice_path()
    updated: dict[str, Path] = {}
    if soffice is None:
        return updated
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="lo-uno-profile-") as profile:
        proc, ctx = uno_context(soffice, port, profile, logs)
        if ctx is None:
            return updated
        try:
            import uno

            def prop(name_: str, value: Any):
                p = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
                p.Name = name_
                p.Value = value
                return p

            desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
            out.mkdir(parents=True, exist_ok=True)
            for book in books:
                name = book["file"]
                if not book["contents"]:
                    continue
                source = directory / name
                target = out / f"{source.stem}.pdf"
                try:
                    doc = desktop.loadComponentFromURL(source.resolve().as_uri(), "_blank", 0, (prop("Hidden", True),))
                except Exception as error:
                    fail(name, "libreoffice-uno", f"the document did not load: {error!r}")
                    continue
                try:
                    indexes = doc.getDocumentIndexes()
                    count = indexes.getCount()
                    if count < 1:
                        fail(name, "libreoffice-uno", "getDocumentIndexes() finds no index: the field was flattened on import")
                        continue
                    for i in range(count):
                        indexes.getByIndex(i).update()
                    doc.storeToURL(target.resolve().as_uri(), (prop("FilterName", "writer_pdf_Export"),))
                    updated[name] = target
                except Exception as error:
                    fail(name, "libreoffice-uno", f"{error!r}")
                finally:
                    doc.close(False)
        finally:
            if proc is not None:
                proc.terminate()
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    proc.kill()
    return updated


def check_page_numbers(book: dict[str, Any], path: Path) -> None:
    """(c) The regenerated table: every entry with the page number only an index can write."""
    name = book["file"]
    text = pdf_text(path)
    if text is None:
        return
    region = contents_region(name, "libreoffice-uno", text, book["entries"])
    if region is None:
        return
    at = 0
    for title in book["entries"]:
        found = False
        while at < len(region):
            if region[at].startswith(title):
                found = True
                if re.search(r"\d+\s*$", region[at]) is None:
                    fail(name, "libreoffice-uno", f"the regenerated entry {title!r} shows no page number: {region[at][:80]!r}")
                at += 1
                break
            at += 1
        if not found:
            fail(name, "libreoffice-uno", f"the regenerated table does not list {title!r} in order")


# pdftohtml splits a row into one `<a>` fragment per font run, so a row is found by its last fragment: the dot
# leader ending in the page number. Each fragment is `<text top="N" ...><a href="file.html#P">text</a></text>`.
ROW_LINK = re.compile(r'<text top="(\d+)"[^>]*><a href="[^"]*#(\d+)">([^<]*)</a></text>')
DOTS_AND_PAGE = re.compile(r"\.{3,}\s*(\d+)\s*$")


def check_links(book: dict[str, Any], updated_pdf: Path, cached_pdf: Path) -> None:
    """(d) Links on the regenerated table (each row's link points at the page its number names), and a note on the cache."""
    name = book["file"]
    try:
        run = subprocess.run(["pdftohtml", "-xml", "-stdout", str(updated_pdf)], capture_output=True, text=True, timeout=60)
    except (subprocess.TimeoutExpired, FileNotFoundError) as error:
        fail(name, "libreoffice-uno", f"pdftohtml: {error!r}")
        return
    if run.returncode != 0:
        fail(name, "libreoffice-uno", f"pdftohtml exited {run.returncode}: {run.stderr.strip()[:200]}")
        return
    rows = []
    for top, page, text in ROW_LINK.findall(run.stdout):
        shown = DOTS_AND_PAGE.search(text)
        if shown is not None:
            rows.append((int(top), page, shown.group(1)))
    rows.sort()
    if len(rows) != len(book["entries"]):
        fail(name, "libreoffice-uno", f"the regenerated table has {len(rows)} linked rows, expected {len(book['entries'])}")
    else:
        for (top, page, shown) in rows:
            if page != shown:
                fail(name, "libreoffice-uno", f"a contents row shows page {shown} but links to page {page}")
    try:
        cached = subprocess.run(["pdftohtml", "-xml", "-stdout", str(cached_pdf)], capture_output=True, text=True, timeout=60)
        if cached.returncode == 0 and not ROW_LINK.search(cached.stdout):
            note(name, "libreoffice-pdf", "the cached entries are plain text with no links, by design (no _Toc bookmarks to point at)")
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass


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

    if not skip_libreoffice and files:
        soffice = soffice_path()
        missing = [t for t in ("pdftotext", "pdftohtml") if shutil.which(t) is None]
        if soffice is None:
            fail("soffice", "libreoffice", "LibreOffice is not on PATH (soffice); install libreoffice-writer, or pass --skip-libreoffice")
        elif missing:
            fail("poppler", "libreoffice", f"missing poppler tools: {', '.join(missing)}")
        else:
            by_file = {b["file"]: b for b in books}
            if convert(soffice, files, "pdf", directory / "lo-pdf", logs, "pdf"):
                for f in files:
                    check_cached_visible(by_file[f.name], directory / "lo-pdf" / f"{f.stem}.pdf")
            if convert(soffice, files, "docx:MS Word 2007 XML", directory / "lo-docx", logs, "docx"):
                for f in files:
                    check_resaved(by_file[f.name], directory / "lo-docx" / f.name)
            updated = check_regenerated(books, directory, logs, directory / "lo-updated")
            for name, target in updated.items():
                check_page_numbers(by_file[name], target)
                check_links(by_file[name], target, directory / "lo-pdf" / f"{Path(name).stem}.pdf")

    if failures:
        print(f"\n{len(failures)} problem(s)")
        return 1
    print(f"ok: {len(files)} file(s) read" + ("" if skip_libreoffice else " in LibreOffice"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
