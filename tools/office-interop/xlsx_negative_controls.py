#!/usr/bin/env python3
"""Negative controls for the XLSX interop gate.

CI's office-interop job runs check_xlsx.py over the corpus the exporter wrote. A checker that never fails proves nothing, so this
script breaks a copy of the corpus three ways and requires each broken copy to be rejected, naming the workbook and the failure:

  (a) string cells lose `t="inlineStr"`: the cell text is no longer a string a reader can read (dialogue.xlsx);
  (b) the workbook's styles relationship is deleted: the styles part is no longer named by the package (dialogue.xlsx);
  (c) a number cell is written as a text cell: the cell reads back as text, not a number (shot-list.xlsx).

Each control copies `expected.json` and every workbook into its own temporary directory, mutates one copy there, and runs
check_xlsx.py on that directory. The corpus itself is never touched. The script exits 0 only when all three copies are rejected
with the expected reason; it exits 1 when any copy is accepted, or when a run fails for anything other than the expected reason
(so a broken control cannot pass as a working one), and 2 when it cannot start.

Run: `python3 tools/office-interop/xlsx_negative_controls.py <corpus-dir> [--skip-libreoffice] [--checker <path>]`

`--checker` points the controls at another checker. A stub that always exits 0 makes this script exit 1: that is the control on
the control. `--skip-libreoffice` is passed through to check_xlsx.py for a machine without LibreOffice; the three mutations are
caught by the package and openpyxl stages, so the job runs them without the flag.
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
from typing import Callable, Pattern

HERE = Path(__file__).resolve().parent
DEFAULT_CHECKER = HERE / "check_xlsx.py"
SHEET = "xl/worksheets/sheet1.xml"
RELS = "xl/_rels/workbook.xml.rels"
TIMEOUT = 600


class MutationError(Exception):
    """The corpus does not have the shape this mutation needs, so the control cannot prove anything."""


def rewrite_part(path: Path, part: str, change: Callable[[str], str]) -> None:
    """Rewrites one part of a workbook's ZIP, copying every other part byte for byte."""
    with tempfile.TemporaryDirectory(prefix="xlsx-control-part-") as scratch:
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


def drop_inline_strings(text: str) -> str:
    """(a) A string cell keeps its `<is>` but loses `t="inlineStr"`, so a reader no longer knows it holds a string."""
    changed, count = re.subn(r'(<c\b[^>]*?)\s+t="inlineStr"', r"\1", text)
    if count == 0:
        raise MutationError('no cell carried t="inlineStr"')
    return changed


def drop_styles_relationship(text: str) -> str:
    """(b) The styles relationship is gone, so the package no longer names xl/styles.xml."""
    changed, count = re.subn(r'<Relationship\b[^>]*\bType="[^"]*/styles"[^>]*/>', "", text)
    if count == 0:
        raise MutationError("no styles relationship")
    return changed


def number_as_text(text: str) -> str:
    """(c) A2, the first shot number, is written as a text cell holding the same digits."""
    match = re.search(r'<c r="A2"[^>]*><v>([^<]+)</v></c>', text)
    if match is None:
        raise MutationError('A2 is not a number cell of the shape <c r="A2"><v>...</v></c>')
    return text.replace(match.group(0), f'<c r="A2" t="inlineStr"><is><t>{match.group(1)}</t></is></c>')


@dataclass(frozen=True)
class Control:
    label: str
    workbook: str
    part: str
    mutate: Callable[[str], str]
    what: str
    marker: Pattern[str]


CONTROLS: tuple[Control, ...] = (
    Control(
        label="a string cell without t=inlineStr",
        workbook="dialogue.xlsx",
        part=SHEET,
        mutate=drop_inline_strings,
        what="the string cells",
        marker=re.compile(r"should be the (?:bold )?text", re.IGNORECASE),
    ),
    Control(
        label="a workbook with no styles relationship",
        workbook="dialogue.xlsx",
        part=RELS,
        mutate=drop_styles_relationship,
        what="the styles part",
        marker=re.compile(r"no styles relationship", re.IGNORECASE),
    ),
    Control(
        label="a number written as a text cell",
        workbook="shot-list.xlsx",
        part=SHEET,
        mutate=number_as_text,
        what="the cell type",
        marker=re.compile(r"A2 should be the number 1\b", re.IGNORECASE),
    ),
)


def run_control(control: Control, corpus: Path, workbooks: list[str], checker: Path, skip_libreoffice: bool) -> bool:
    """True when the mutated copy was rejected with the expected reason, naming the workbook."""
    with tempfile.TemporaryDirectory(prefix="xlsx-control-") as scratch:
        copy = Path(scratch) / "corpus"
        copy.mkdir()
        shutil.copy2(corpus / "expected.json", copy / "expected.json")
        for name in workbooks:
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
        except OSError as error:
            print(f"FAIL {control.label}: the checker could not run: {error}")
            return False
        output = run.stdout + run.stderr
        if run.returncode == 0:
            print(f"FAIL {control.label}: the checker accepted the {control.workbook} copy (exit 0)")
            return False
        matching = next((line for line in output.splitlines() if control.marker.search(line)), "")
        if control.workbook not in output or not matching:
            print(f"FAIL {control.label}: the checker exited {run.returncode}, but not because of {control.what} in {control.workbook}")
            for line in output.splitlines()[:8]:
                print(f"  {line}")
            return False
        print(f"ok   {control.label}: {matching.strip()}")
        return True


def main(argv: list[str]) -> int:
    checker = DEFAULT_CHECKER
    skip_libreoffice = False
    positional: list[str] = []
    index = 1
    while index < len(argv):
        argument = argv[index]
        if argument == "--skip-libreoffice":
            skip_libreoffice = True
        elif argument == "--checker":
            index += 1
            if index >= len(argv):
                print(__doc__)
                return 2
            checker = Path(argv[index]).resolve()
        elif argument.startswith("--checker="):
            checker = Path(argument.split("=", 1)[1]).resolve()
        elif argument.startswith("--"):
            print(f"unknown option {argument}")
            print(__doc__)
            return 2
        else:
            positional.append(argument)
        index += 1

    if len(positional) != 1:
        print(__doc__)
        return 2
    corpus = Path(positional[0]).resolve()
    expected_path = corpus / "expected.json"
    if not expected_path.is_file():
        print(f"{expected_path} not found: write the corpus first")
        return 2
    if not checker.is_file():
        print(f"{checker} not found: point --checker at the XLSX checker")
        return 2
    workbooks = [book["file"] for book in json.loads(expected_path.read_text(encoding="utf-8"))["files"]]
    missing = [name for name in workbooks if not (corpus / name).is_file()]
    if missing:
        print(f"the corpus is missing {', '.join(missing)}: write it first")
        return 2

    rejected = [run_control(control, corpus, workbooks, checker, skip_libreoffice) for control in CONTROLS]
    if all(rejected):
        print(f"ok: {len(CONTROLS)} broken copies were rejected, each naming its workbook and what failed")
        return 0
    print(f"{rejected.count(False)} control(s) did not prove the checker fails")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
