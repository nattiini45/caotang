#!/usr/bin/env python3
"""Builds the five WOFF files of @caotang/font-comic-lettering from the Comic Neue and Bangers TrueType files of google/fonts.

Run: python3 vendor/comic-lettering/build.py <directory holding the five source .ttf files>

The sources are the files README.md names, at the google/fonts commit it names, and each one's SHA-256 is checked before
anything is built. The outputs are written beside this script, and each SHA-256 is compared with SHA256SUMS: the build fails
when they differ, and fails before it starts when SHA256SUMS or its line for an output is missing. The same sources and the
same fontTools version (and zlib) give the same bytes.

The outlines, hinting and layout tables are not touched; the font is not subset. Three things change:

1. The file is stored as WOFF 1.0 (zlib), which the PDF writers unpack before fontkit reads it and a browser loads as it is.
2. Each glyph is padded to 4 bytes, because fontkit's subsetter copies glyph data as it finds it (Bangers and Comic Neue Bold
   Italic are padded to 2 upstream).
3. The DSIG table is dropped: a digital signature of a file that is no longer that file is a false claim.
The head table keeps its upstream dates, so the output does not depend on when it was built.
"""

import hashlib
import sys
from pathlib import Path
from typing import Optional

import fontTools
from fontTools.ttLib import TTFont

FONTTOOLS_VERSION = "4.61.1"
HERE = Path(__file__).resolve().parent

# source file name -> (SHA-256 of the source, output file name)
FONTS = {
    "ComicNeue-Regular.ttf": ("a0ee5a37c8b27c4db0700137d928598b1e23b0089e1546a8961909176b779360", "ComicNeue-Regular.woff"),
    "ComicNeue-Italic.ttf": ("e06bfd1552f5c9464c5665733ffd69239b0593885dbb9e059688a5900f78cf98", "ComicNeue-Italic.woff"),
    "ComicNeue-Bold.ttf": ("3e7e5fccfd7e0788f317b43312151c1bd5cf058c9697a8d83eac3939050bd61e", "ComicNeue-Bold.woff"),
    "ComicNeue-BoldItalic.ttf": ("5c312c2a2fa64eee82f3b87fcfab8f3b12a5e59b043124401d322eb323cfbf16", "ComicNeue-BoldItalic.woff"),
    "Bangers-Regular.ttf": ("4160a7311de9342674cce9160cde9fcbb30f48190397d86ff1b70b455af65824", "Bangers-Regular.woff"),
}


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


def convert(source: Path, output: Path) -> None:
    font = TTFont(source, recalcTimestamp=False, recalcBBoxes=False)
    if "DSIG" in font:
        del font["DSIG"]
    font["glyf"].padding = 4
    font.flavor = "woff"
    font.save(output)


def main() -> int:
    if len(sys.argv) != 2:
        print("Run: python3 vendor/comic-lettering/build.py <directory holding the five source .ttf files>", file=sys.stderr)
        return 2
    if fontTools.version != FONTTOOLS_VERSION:
        print(f"fontTools {FONTTOOLS_VERSION} is required (found {fontTools.version})", file=sys.stderr)
        return 1
    source_dir = Path(sys.argv[1])
    for name, (source_digest, output_name) in FONTS.items():
        source = source_dir / name
        if not source.is_file() or sha256(source) != source_digest:
            print(f"{source} is not the pinned source (SHA-256 {source_digest})", file=sys.stderr)
            return 1
        if pinned_digest(output_name) is None:
            print(f"{HERE / 'SHA256SUMS'} has no SHA-256 for {output_name}, so the output could not be checked", file=sys.stderr)
            return 1
    status = 0
    for name, (_, output_name) in FONTS.items():
        output = HERE / output_name
        convert(source_dir / name, output)
        digest = sha256(output)
        print(f"{output_name}: {output.stat().st_size} bytes, SHA-256 {digest}")
        if pinned_digest(output_name) != digest:
            print(f"{output_name} differs from SHA256SUMS ({pinned_digest(output_name)})", file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
