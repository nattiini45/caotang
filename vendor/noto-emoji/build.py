#!/usr/bin/env python3
"""Builds NotoEmoji-Regular.woff and NotoEmoji-Regular-common.woff from the Noto Emoji static font Google Fonts serves.

Run: python3 vendor/noto-emoji/build.py <path to the downloaded NotoEmoji .ttf>
     python3 vendor/noto-emoji/build.py --common     (the common file only, from the full file beside this script)

The source is the file README.md names, at the URL it names, and its SHA-256 is checked before anything is built. The
outputs are written beside this script, and each SHA-256 is compared with SHA256SUMS: the build fails when they differ, and
fails before it starts when SHA256SUMS or its line for an output is missing. The same source and the same fontTools version
give the same bytes.

The steps:

1. The source is already a static TrueType font (weight 400, Regular), which is what a PDF can embed, so it is not
   instanced. Its style table goes with the other tables below.
2. Every character the font maps is kept, with every glyph the `ccmp` feature reaches from them: the ligatures that draw a
   ZWJ sequence, a flag, a keycap or a tag sequence as one picture. GSUB stays (the exporter lays emoji out through it);
   the vertical metrics and the grid-fitting table go. Each glyph is padded to 4 bytes, because fontkit's subsetter copies
   glyph data as it finds it.
3. The result is stored as WOFF 1.0 (zlib), which the exporter unpacks before fontkit reads it.
4. The common file is that full file cut to the emoji of common-emoji.txt (charset.py says how they are chosen), with the
   ligatures that draw them (a keycap). It is a first, small download for a document whose emoji are all in it; a document
   with any other emoji takes the full file. The build fails when the common file is larger than COMMON_BUDGET.
"""

import hashlib
import sys
from pathlib import Path
from typing import Optional

import fontTools
from fontTools import subset
from fontTools.ttLib import TTFont

FONTTOOLS_VERSION = "4.61.1"
SOURCE_SHA256 = "988621dc5c9a75eb6144f28faae30317a8e3421b68b28740747b3d739e2326b8"
OUTPUT = "NotoEmoji-Regular.woff"
COMMON_OUTPUT = "NotoEmoji-Regular-common.woff"
COMMON_LIST = "common-emoji.txt"
# The most the common file may be: 300 kB (300 * 1024 bytes).
COMMON_BUDGET = 300 * 1024
HERE = Path(__file__).resolve().parent


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pinned_digest(name: str) -> Optional[str]:
    """The SHA-256 SHA256SUMS pins for a file name, or None when SHA256SUMS is missing or has no line for it."""
    sums = HERE / "SHA256SUMS"
    if not sums.is_file():
        return None
    for line in sums.read_text().splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[1].strip() == name:
            return parts[0]
    return None


def listed(path: Path) -> set:
    """The code points of the emoji a list declares: one emoji a line as hexadecimal code points, `#` lines being comments."""
    found = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("#") or not line.strip():
            continue
        found.update(int(code, 16) for code in line.split())
    return found


def subset_options() -> subset.Options:
    options = subset.Options()
    options.layout_features = ["ccmp"]
    options.hinting = False
    options.notdef_outline = True
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.drop_tables += ["vhea", "vmtx", "gasp", "STAT", "DSIG"]
    options.flavor = "woff"
    return options


def build_full(source: Path) -> int:
    if sha256(source) != SOURCE_SHA256:
        print(f"{source} is not the pinned source (SHA-256 {SOURCE_SHA256})", file=sys.stderr)
        return 1
    # The output is always compared: a missing SHA256SUMS, or one with no line for the output, stops the build before it runs.
    pinned = pinned_digest(OUTPUT)
    if pinned is None:
        print(f"{HERE / 'SHA256SUMS'} has no SHA-256 for {OUTPUT}, so the output could not be checked", file=sys.stderr)
        return 1

    # The head table keeps its upstream dates, so the output does not depend on when it was built.
    font = TTFont(source, recalcTimestamp=False)

    options = subset_options()
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=font.getBestCmap().keys())
    subsetter.subset(font)
    font["glyf"].padding = 4

    output = HERE / OUTPUT
    subset.save_font(font, str(output), options)
    digest = sha256(output)
    print(f"{OUTPUT}: {output.stat().st_size} bytes, SHA-256 {digest}")
    if pinned != digest:
        print(f"the output differs from SHA256SUMS ({pinned})", file=sys.stderr)
        return 1
    return 0


def build_common() -> int:
    """The common file: the full file beside this script, cut to the emoji of common-emoji.txt."""
    full = HERE / OUTPUT
    for name in (OUTPUT, COMMON_OUTPUT):
        if pinned_digest(name) is None:
            print(f"{HERE / 'SHA256SUMS'} has no SHA-256 for {name}, so the output could not be checked", file=sys.stderr)
            return 1
    if sha256(full) != pinned_digest(OUTPUT):
        print(f"{full} is not the file SHA256SUMS pins, so the common file would not follow from it", file=sys.stderr)
        return 1
    wanted = listed(HERE / COMMON_LIST)
    # The head, hhea and maxp tables keep the full font's numbers, so a PDF holds the same font program from either file.
    font = TTFont(full, recalcTimestamp=False, recalcBBoxes=False)
    unmapped = wanted - set(font.getBestCmap())
    if unmapped:
        print(f"{COMMON_LIST} holds {len(unmapped)} code points the full font does not map (first: U+{min(unmapped):04X})", file=sys.stderr)
        return 1

    options = subset_options()
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=wanted)
    subsetter.subset(font)
    # A font read from a file pads its glyphs to 1 byte when it is written again; fontkit's subsetter wants 4.
    font["glyf"].padding = 4

    output = HERE / COMMON_OUTPUT
    subset.save_font(font, str(output), options)
    digest = sha256(output)
    size = output.stat().st_size
    print(f"{COMMON_OUTPUT}: {size} bytes, SHA-256 {digest}")
    if size > COMMON_BUDGET:
        print(f"{COMMON_OUTPUT} is {size} bytes, more than its budget of {COMMON_BUDGET}: shrink {COMMON_LIST}", file=sys.stderr)
        return 1
    if pinned_digest(COMMON_OUTPUT) != digest:
        print(f"the output differs from SHA256SUMS ({pinned_digest(COMMON_OUTPUT)})", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print("Run: python3 vendor/noto-emoji/build.py <path to the downloaded NotoEmoji .ttf> | --common", file=sys.stderr)
        return 2
    if fontTools.version != FONTTOOLS_VERSION:
        print(f"fontTools {FONTTOOLS_VERSION} is required (found {fontTools.version})", file=sys.stderr)
        return 1
    if sys.argv[1] != "--common":
        status = build_full(Path(sys.argv[1]))
        if status != 0:
            return status
    return build_common()


if __name__ == "__main__":
    sys.exit(main())
