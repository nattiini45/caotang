#!/usr/bin/env python3
"""Negative controls for the DOCX contents-field interop gate.

CI's office-interop job runs check_docx.py over the corpus the exporter wrote. A checker that never fails proves nothing, so
this script breaks a copy of the corpus three ways and requires each broken copy to be rejected, naming the file and the failure:

  (a) the field flattened to static text: no `fldChar`, no `instrText` — the entries stay as plain paragraphs, which is the
      shape a writer cannot update (toc-3-chapters.docx);
  (b) the Heading styles lose `w:outlineLvl`: a `\\o` contents field collects paragraphs by outline level, so a regenerated
      table comes out empty (toc-3-chapters.docx);
  (c) two cached entries swap titles: the cache shows the wrong chapter names in the right places, which only the rendered
      page can betray — (c) needs LibreOffice and is skipped under --skip-libreoffice (toc-3-chapters.docx).

Each control copies `expected.json` and every document into its own temporary directory, mutates one copy there, and runs
check_docx.py on that directory. The corpus itself is never touched. The script exits 0 only when every copy that ran is
rejected with the expected reason; it exits 1 when any copy is accepted, or when a run fails for anything other than the
expected reason (so a broken control cannot pass as a working one), and 2 when it cannot start.

Run: `python3 tools/office-interop/docx_negative_controls.py <corpus-dir> [--skip-libreoffice] [--checker <path>]`

`--checker` points the controls at another checker. A stub that always exits 0 makes this script exit 1: that is the control on
the control. `--skip-libreoffice` is passed through to check_docx.py for a machine without LibreOffice, and skips (c).
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Pattern

HERE = Path(__file__).resolve().parent
DEFAULT_CHECKER = HERE / "check_docx.py"
DOCUMENT = "word/document.xml"
STYLES = "word/styles.xml"
TIMEOUT = 600


class MutationError(Exception):
    """The corpus does not have the shape this mutation needs, so the control cannot prove anything."""


def rewrite_part(path: Path, part: str, change: Callable[[str], str]) -> None:
    """Rewrites one part of a document's ZIP, copying every other part byte for byte."""
    with tempfile.TemporaryDirectory(prefix="docx-control-part-") as scratch:
        rewritten = Path(scratch) / path.name
        with zipfile.ZipFile(path) as source, zipfile.ZipFile(rewritten, "w", zipfile.ZIP_DEFLATED) as target:
            if part not in source.namelist():
                raise MutationError(f"{path.name} has no {part}")
            for info in source.infolist():
                data = source.read(info.filename)
                if info.filename == part:
                    changed = change(data.decode("utf-8"))
                    if changed == data.decode("utf-8"):
                        raise MutationError(f"the mutation changed nothing in {path.name}:{part}")
                    data = changed.encode("utf-8")
                target.writestr(info, data)
        shutil.move(str(rewritten), path)


def flatten_field(text: str) -> str:
    """(a) The field's runs go: no begin, no instruction, no separate, no end — the entries stay as plain text."""
    changed = re.sub(r"<w:r><w:fldChar[^>]*/></w:r>", "", text)
    changed = re.sub(r"<w:r><w:instrText[^>]*>[^<]*</w:instrText></w:r>", "", changed)
    if "fldChar" in changed or "instrText" in changed:
        raise MutationError("the field was not flattened")
    return changed


def drop_outline_levels(text: str) -> str:
    """(b) The Heading styles lose their `w:outlineLvl`, so a regenerated contents table collects nothing."""
    changed, count = re.subn(r'<w:outlineLvl w:val="\d+"/>', "", text)
    if count == 0:
        raise MutationError("no w:outlineLvl in the styles")
    return changed


def swap_entries(text: str) -> str:
    """(c) The first two cached entries trade titles, so the cache names the chapters in the wrong order."""
    titles = re.findall(r'<w:t xml:space="default">([^<]+)</w:t>', text)
    if len(titles) < 2:
        raise MutationError("fewer than two cached entries")
    first, second = titles[0], titles[1]
    changed = text.replace(f"<w:t xml:space=\"default\">{first}</w:t>", f"<w:t xml:space=\"default\">\x00{second}</w:t>", 1)
    changed = changed.replace(f"<w:t xml:space=\"default\">{second}</w:t>", f"<w:t xml:space=\"default\">{first}</w:t>", 1)
    changed = changed.replace("<w:t xml:space=\"default\">\x00", '<w:t xml:space="default">', 1)
    return changed


@dataclass(frozen=True)
class Control:
    label: str
    workbook: str
    part: str
    mutate: Callable[[str], str]
    what: str
    marker: Pattern[str]
    needs_libreoffice: bool = False


CONTROLS: tuple[Control, ...] = (
    Control(
        label="a contents page with no field",
        workbook="toc-3-chapters.docx",
        part=DOCUMENT,
        mutate=flatten_field,
        what="the field",
        marker=re.compile(r"fldChar.*should be present", re.IGNORECASE),
    ),
    Control(
        label="headings with no outline level",
        workbook="toc-3-chapters.docx",
        part=STYLES,
        mutate=drop_outline_levels,
        what="the outline levels",
        marker=re.compile(r"no w:outlineLvl", re.IGNORECASE),
    ),
    Control(
        label="cached entries in the wrong order",
        workbook="toc-3-chapters.docx",
        part=DOCUMENT,
        mutate=swap_entries,
        what="the entry order",
        marker=re.compile(r"does not list .* in order", re.IGNORECASE),
        needs_libreoffice=True,
    ),
)


def run_control(control: Control, corpus: Path, documents: list[str], checker: Path, skip_libreoffice: bool) -> Optional[bool]:
    """True when the mutated copy was rejected with the expected reason, naming the file; None when skipped."""
    if control.needs_libreoffice and skip_libreoffice:
        print(f"SKIP {control.label} (needs LibreOffice)")
        return None
    with tempfile.TemporaryDirectory(prefix="docx-control-") as scratch:
        copy = Path(scratch) / "corpus"
        copy.mkdir()
        shutil.copy2(corpus / "expected.json", copy / "expected.json")
        for name in documents:
            shutil.copy2(corpus / name, copy / name)
        try:
            rewrite_part(copy / control.workbook, control.part, control.mutate)
        except MutationError as error:
            print(f"FAIL {control.label}: {error}")
            return False
        command = [sys.executable, str(checker), str(copy)]
        if skip_libreoffice:
            command.append("--skip-libreoffice")
        try:
            run = subprocess.run(command, capture_output=True, text=True, timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            print(f"FAIL {control.label}: the checker did not finish in {TIMEOUT} seconds")
            return False
        out = run.stdout + run.stderr
        if run.returncode == 0:
            print(f"FAIL {control.label}: the checker accepted the broken copy")
            return False
        if control.workbook not in out or not control.marker.search(out):
            print(f"FAIL {control.label}: rejected, but not for the expected reason\n{out[-1200:]}")
            return False
        print(f"ok: {control.label} rejected ({control.what})")
        return True


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    skip_libreoffice = "--skip-libreoffice" in argv[1:]
    checker = DEFAULT_CHECKER
    if "--checker" in argv[1:]:
        which = argv[1:].index("--checker")
        try:
            checker = Path(argv[1:][which + 1]).resolve()
        except IndexError:
            print(__doc__)
            return 2
        args = [a for a in args if a != argv[1:][which + 1]]
    if len(args) != 1:
        print(__doc__)
        return 2
    corpus = Path(args[0]).resolve()
    expected_path = corpus / "expected.json"
    if not expected_path.is_file():
        print(f"{expected_path} not found: write the corpus first")
        return 2
    documents = [entry["file"] for entry in json.loads(expected_path.read_text(encoding="utf-8"))["files"]]

    results = [run_control(control, corpus, documents, checker, skip_libreoffice) for control in CONTROLS]
    if any(result is False for result in results):
        return 1
    print("\nok: every broken copy was rejected")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
