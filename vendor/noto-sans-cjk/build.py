#!/usr/bin/env python3
"""Builds NotoSansMonoCJKsc-Regular.woff and NotoSansMonoCJKsc-Regular-common.woff from the upstream Noto Sans Mono CJK SC OTF.

Run: python3 vendor/noto-sans-cjk/build.py <path to NotoSansMonoCJKsc-Regular.otf>
     python3 vendor/noto-sans-cjk/build.py --common     (the common file only, from the full file beside this script)

The source is the file README.md names, at the tag it names, and its SHA-256 is checked before anything is built. The
outputs are written beside this script, and each SHA-256 is compared with SHA256SUMS: the build fails when they differ, and
fails before it starts when SHA256SUMS or its line for an output is missing. The same source and the same fontTools version
give the same bytes.

The steps:

1. The CFF outlines become TrueType (glyf) outlines, quadratic curves within 1 font unit of the cubic ones. pdf-lib's
   fontkit subsets a TrueType font correctly; it writes a broken subset of a CID-keyed CFF font, which Noto Sans Mono CJK is.
   Each glyph is padded to 4 bytes, because fontkit's subsetter copies glyph data as it finds it.
2. Every character the font maps is kept, with the regional forms the `locl` feature reaches (the Japanese, Korean,
   Traditional Chinese and Hong Kong forms of a Han character, and of fullwidth punctuation) and the GSUB lookups behind it.
   The glyphs only other layout features reach (vertical and other alternates) are dropped, with GPOS and GDEF, the vertical
   metrics and the hinting. Both PDF writers draw horizontal text, and pick the regional forms by the project's language.
3. The result is stored as WOFF 1.0 (zlib), which the PDF writers unpack before fontkit reads it.
4. The common file is that full file cut to the characters of common-charset.txt (charset.py says how they are chosen), with the
   regional forms of those characters. It is a first, small download for a document whose characters are all in it; a document
   with any other character takes the full file. The build fails when the common file is larger than COMMON_BUDGET.
"""

import hashlib
import sys
from pathlib import Path
from typing import Optional

import fontTools
from fontTools import subset
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable

FONTTOOLS_VERSION = "4.61.1"
SOURCE_SHA256 = "ec04cc376b34887cedbdf84074e2e226ed2761eeabdcb9173fc1dd7bfd153ef7"
OUTPUT = "NotoSansMonoCJKsc-Regular.woff"
COMMON_OUTPUT = "NotoSansMonoCJKsc-Regular-common.woff"
COMMON_CHARSET = "common-charset.txt"
# The most the common file may be: 2 MB (2 * 1024 * 1024 bytes).
COMMON_BUDGET = 2 * 1024 * 1024
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


def to_truetype(font: TTFont) -> None:
    order = font.getGlyphOrder()
    glyphs = font.getGlyphSet()
    glyf = newTable("glyf")
    glyf.glyphOrder = order
    glyf.glyphs = {}
    glyf.padding = 4
    for name in order:
        pen = TTGlyphPen(glyphs)
        glyphs[name].draw(Cu2QuPen(pen, 1.0, reverse_direction=True))
        glyf[name] = pen.glyph()
    font["glyf"] = glyf
    font["loca"] = newTable("loca")
    maxp = font["maxp"]
    maxp.tableVersion = 0x00010000
    for field in (
        "maxTwilightPoints",
        "maxStorage",
        "maxFunctionDefs",
        "maxInstructionDefs",
        "maxStackElements",
        "maxSizeOfInstructions",
        "maxComponentElements",
        "maxComponentDepth",
    ):
        setattr(maxp, field, 0)
    maxp.maxZones = 1
    del font["CFF "]
    if "VORG" in font:
        del font["VORG"]
    font["post"].formatType = 3.0
    font["head"].glyphDataFormat = 0
    font.sfntVersion = "\x00\x01\x00\x00"


def charset(path: Path) -> set:
    """The code points a charset file declares: hexadecimal code points and `low-high` ranges, `#` lines being comments."""
    found = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("#") or not line.strip():
            continue
        for token in line.split():
            low, _, high = token.partition("-")
            found.update(range(int(low, 16), int(high or low, 16) + 1))
    return found


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
    to_truetype(font)

    options = subset_options()
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=font.getBestCmap().keys())
    subsetter.subset(font)

    output = HERE / OUTPUT
    subset.save_font(font, str(output), options)
    digest = sha256(output)
    print(f"{OUTPUT}: {output.stat().st_size} bytes, SHA-256 {digest}")
    if pinned != digest:
        print(f"the output differs from SHA256SUMS ({pinned})", file=sys.stderr)
        return 1
    return 0


def build_common() -> int:
    """The common file: the full file beside this script, cut to the characters of common-charset.txt."""
    full = HERE / OUTPUT
    for name in (OUTPUT, COMMON_OUTPUT):
        if pinned_digest(name) is None:
            print(f"{HERE / 'SHA256SUMS'} has no SHA-256 for {name}, so the output could not be checked", file=sys.stderr)
            return 1
    if sha256(full) != pinned_digest(OUTPUT):
        print(f"{full} is not the file SHA256SUMS pins, so the common file would not follow from it", file=sys.stderr)
        return 1
    wanted = charset(HERE / COMMON_CHARSET)
    # The head, hhea and maxp tables keep the full font's numbers, so a PDF holds the same font program from either file.
    font = TTFont(full, recalcTimestamp=False, recalcBBoxes=False)
    unmapped = wanted - set(font.getBestCmap())
    if unmapped:
        print(f"{COMMON_CHARSET} holds {len(unmapped)} characters the full font does not map (first: U+{min(unmapped):04X})", file=sys.stderr)
        return 1

    options = subset_options()
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=wanted)
    subsetter.subset(font)
    # A font read from a file pads its glyphs to 1 byte when it is written again; fontkit's subsetter wants 4 (see to_truetype).
    font["glyf"].padding = 4

    output = HERE / COMMON_OUTPUT
    subset.save_font(font, str(output), options)
    digest = sha256(output)
    size = output.stat().st_size
    print(f"{COMMON_OUTPUT}: {size} bytes, SHA-256 {digest}")
    if size > COMMON_BUDGET:
        print(f"{COMMON_OUTPUT} is {size} bytes, more than its budget of {COMMON_BUDGET}: shrink {COMMON_CHARSET}", file=sys.stderr)
        return 1
    if pinned_digest(COMMON_OUTPUT) != digest:
        print(f"the output differs from SHA256SUMS ({pinned_digest(COMMON_OUTPUT)})", file=sys.stderr)
        return 1
    return 0


def subset_options() -> subset.Options:
    options = subset.Options()
    options.layout_features = ["locl"]
    options.hinting = False
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.drop_tables += ["BASE", "vhea", "vmtx", "VORG", "DSIG", "GPOS", "GDEF"]
    options.flavor = "woff"
    return options


def main() -> int:
    if len(sys.argv) != 2:
        print("Run: python3 vendor/noto-sans-cjk/build.py <path to NotoSansMonoCJKsc-Regular.otf> | --common", file=sys.stderr)
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
