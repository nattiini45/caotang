#!/usr/bin/env python3
"""Builds NotoColorEmoji.bin, the colour emoji both PDFs draw as vector Type 3 glyphs, from Noto's COLRv1 font.

Run: python3 vendor/noto-color-emoji/build.py <path to Noto-COLRv1.ttf>

The source is the file README.md names, and its SHA-256 is checked before anything is built. The output is written beside this
script and compared with SHA256SUMS: the build fails when they differ, and fails before it starts when SHA256SUMS has no line for
the output. The same source, the same fontTools version and the same zlib give the same bytes.

The steps:

1. Every emoji of Unicode's emoji-test.txt (the file packages/pdf-fonts/test/fixtures keeps; fully-qualified sequences and
   components) is laid out through the font's own `ccmp` ligatures, by the small GSUB reader in this file, to the one glyph the
   font draws it with. A sequence the font does not draw as one glyph is named and left out; the PDFs print it in the monochrome
   font. The emoji are keyed by their code points without the variation selectors, so a cluster finds its key whatever the
   writer typed.
2. Each glyph's paint graph is flattened to PDF operators (paint.py): a coloured Type 3 glyph is one string of operators, with
   the shadings, graphics states and soft masks it names kept once in a pool all glyphs share.
3. The glyphs are stored in blocks of about 48 kB, each deflated alone, so a PDF with a few emoji inflates only the blocks it
   needs. The index (keys, glyph table, pool) is deflated too. The layout is written in README.md.
4. Every operator the glyphs and the pool use is checked against a whitelist (paths, colours, shadings, graphics states, clips),
   and the file is refused when it is larger than its budget.
"""

import hashlib
import json
import re
import struct
import sys
import zlib
from pathlib import Path
from typing import Optional

import fontTools
from fontTools.ttLib import TTFont

sys.path.insert(0, str(Path(__file__).resolve().parent))

from paint import Compiler, Pool  # noqa: E402

FONTTOOLS_VERSION = "4.61.1"
SOURCE_REPOSITORY = "https://github.com/googlefonts/noto-emoji"
SOURCE_COMMIT = "e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e"
SOURCE_PATH = "2D/fonts/Noto-COLRv1.ttf"
SOURCE_SHA256 = "b8e25ea68db82f9e4d0aee921f4420be2be39887bd5c893a2ad98710531f9d0c"
OUTPUT = "NotoColorEmoji.bin"
EMOJI_LIST = "../../packages/pdf-fonts/test/fixtures/emoji-test-17.0.txt"
# The most the file may be: 8 MB (docs/decisions.md), with a target of 6 MB.
BUDGET = 8 * 1024 * 1024
TARGET = 6 * 1024 * 1024
BLOCK = 48 * 1024
MAGIC = b"CEMJ"
VERSION = 1
HERE = Path(__file__).resolve().parent

# The operators a glyph may hold: paths, one fill, clips, graphics-state stack and matrix, colours, shadings and graphics states.
CONTENT_OPERATORS = {"m", "l", "c", "h", "re", "f", "W", "n", "q", "Q", "cm", "g", "rg", "sh", "gs", "Do"}
# The names a pool entry may use (shading, function and graphics-state dictionaries). No string, stream or reference.
POOL_NAMES = {
    "ShadingType", "ColorSpace", "DeviceRGB", "DeviceGray", "Coords", "Domain", "Function", "Extend",
    "FunctionType", "C0", "C1", "N", "Functions", "Bounds", "Encode", "BM", "SoftLight", "ca",
}
TOKEN = re.compile(r"\s*(\[|\]|<<|>>|/[A-Za-z0-9]+|-?[0-9]+(?:\.[0-9]+)?|true|false)")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pinned_digest(name: str) -> Optional[str]:
    """The SHA-256 SHA256SUMS pins for a file name, or None when SHA256SUMS is missing or has no line for it."""
    sums = HERE / "SHA256SUMS"
    if not sums.is_file():
        return None
    for line in sums.read_text().splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[1].strip().split(" ")[0] == name:
            return parts[0]
    return None


class Shaper:
    """The font's `ccmp` feature, applied to a run of code points: ligatures, multiple and single substitutions and the contexts that call them."""

    def __init__(self, font: TTFont):
        self.cmap = font.getBestCmap()
        gsub = font["GSUB"].table
        self.lookups = gsub.LookupList.Lookup
        indexes = {i for record in gsub.FeatureList.FeatureRecord if record.FeatureTag == "ccmp" for i in record.Feature.LookupListIndex}
        self.order = sorted(indexes)

    def shape(self, codes: list) -> list:
        # The font maps no variation selector, so shaping drops them, as HarfBuzz does.
        glyphs = [self.cmap.get(c, ".notdef") for c in codes if c not in (0xFE0E, 0xFE0F)]
        for index in self.order:
            glyphs = self.run(self.lookups[index], glyphs)
        return glyphs

    def run(self, lookup, glyphs: list) -> list:
        glyphs = list(glyphs)
        i = 0
        while i < len(glyphs):
            result = self.at(lookup, glyphs, i)
            if result is None:
                i += 1
            else:
                glyphs, i = result
        return glyphs

    def at(self, lookup, glyphs: list, i: int):
        for table in lookup.SubTable:
            result = self.apply(lookup.LookupType, table, glyphs, i)
            if result is not None:
                return result
        return None

    def apply(self, kind: int, table, glyphs: list, i: int):
        glyph = glyphs[i]
        if kind == 1 and glyph in table.mapping:
            return glyphs[:i] + [table.mapping[glyph]] + glyphs[i + 1:], i + 1
        if kind == 2 and glyph in table.mapping:
            replacement = table.mapping[glyph]
            return glyphs[:i] + replacement + glyphs[i + 1:], i + len(replacement)
        if kind == 4:
            for ligature in table.ligatures.get(glyph, []):
                parts = ligature.Component
                if glyphs[i + 1:i + 1 + len(parts)] == parts:
                    return glyphs[:i] + [ligature.LigGlyph] + glyphs[i + 1 + len(parts):], i + 1
            return None
        if kind in (5, 6) and table.Format == 3:
            if kind == 5:
                back, inputs, ahead = [], table.Coverage, []
            else:
                back, inputs, ahead = table.BacktrackCoverage, table.InputCoverage, table.LookAheadCoverage
            if i < len(back) or i + len(inputs) + len(ahead) > len(glyphs):
                return None
            for k, coverage in enumerate(reversed(back)):
                if glyphs[i - 1 - k] not in coverage.glyphs:
                    return None
            for k, coverage in enumerate(inputs):
                if glyphs[i + k] not in coverage.glyphs:
                    return None
            for k, coverage in enumerate(ahead):
                if glyphs[i + len(inputs) + k] not in coverage.glyphs:
                    return None
            for record in table.SubstLookupRecord:
                result = self.at(self.lookups[record.LookupListIndex], glyphs, i + record.SequenceIndex)
                if result is not None:
                    glyphs = result[0]
            return glyphs, i + len(inputs)
        return None


def emoji_list(path: Path) -> list:
    """The code points of each fully-qualified emoji and component of Unicode's emoji-test.txt, in the file's order."""
    found = []
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^([0-9A-F ]+?)\s*;\s*(fully-qualified|component)\b", line)
        if match:
            found.append([int(code, 16) for code in match.group(1).split()])
    return found


def key_of(codes: list) -> str:
    return "-".join(f"{c:x}" for c in codes if c not in (0xFE0E, 0xFE0F))


def check_text(text: str, where: str, names: set) -> None:
    """A pool entry holds numbers, arrays, dictionaries and the names POOL_NAMES lists, and nothing else."""
    at = 0
    text = text.strip()
    while at < len(text):
        match = TOKEN.match(text, at)
        if not match:
            raise SystemExit(f"{where}: {text[at:at + 30]!r} is not a number, a name or a bracket")
        token = match.group(1)
        if token.startswith("/") and token[1:] not in names:
            raise SystemExit(f"{where}: the name {token} is not in the whitelist")
        at = match.end()


def check_content(content: str, where: str) -> None:
    for token in content.split():
        if token.startswith("/"):
            continue
        if re.fullmatch(r"-?[0-9]+(?:\.[0-9]+)?", token):
            continue
        if token not in CONTENT_OPERATORS:
            raise SystemExit(f"{where}: the operator {token!r} is not in the whitelist")


def build(source: Path) -> int:
    if sha256(source) != SOURCE_SHA256:
        print(f"{source} is not the pinned source (SHA-256 {SOURCE_SHA256})", file=sys.stderr)
        return 1
    pinned = pinned_digest(OUTPUT)
    if pinned is None:
        print(f"{HERE / 'SHA256SUMS'} has no SHA-256 for {OUTPUT}, so the output could not be checked", file=sys.stderr)
        return 1
    list_path = (HERE / EMOJI_LIST).resolve()
    font = TTFont(source, recalcTimestamp=False)
    shaper = Shaper(font)
    wanted = emoji_list(list_path)
    order = font.getGlyphOrder()
    bases = {r.BaseGlyph for r in font["COLR"].table.BaseGlyphList.BaseGlyphPaintRecord}
    unit = 1000 / font["head"].unitsPerEm

    # A first pass finds the layer shapes that more than one emoji fills with a solid colour: those are drawn as shared forms.
    outlines = {}
    first = Compiler(font, Pool(), outlines=outlines)
    names = []
    for codes in wanted:
        glyphs = shaper.shape(codes)
        if len(glyphs) == 1 and glyphs[0] in bases and glyphs[0] not in names:
            names.append(glyphs[0])
    for name in names:
        first.compile(name)
    shared = {glyph for glyph, users in first.uses.items() if len(users) >= 2}

    pool = Pool()
    compiler = Compiler(font, pool, shared, outlines)
    chunks = []  # the text of each pool entry and each glyph record, in the order they are stored
    blocks = []
    state = {"text": [], "size": 0}
    where = {}

    def flush():
        if not state["text"]:
            return
        raw = "".join(state["text"]).encode("ascii")
        blocks.append((zlib.compress(raw, 9), len(raw)))
        state["text"], state["size"] = [], 0

    def store(text: str):
        """Appends a chunk to the current block (starting another past BLOCK bytes); its place is (block, offset, length)."""
        if state["size"] and state["size"] + len(text) > BLOCK:
            flush()
        place = (len(blocks), state["size"], len(text))
        state["text"].append(text)
        state["size"] += len(text)
        return place

    pool_places = []
    glyph_rows = []
    record_of = {}
    glyph_of_name = {}
    keys = []
    seen = set()
    glyph_of_key = []
    left_out = []
    for codes in wanted:
        key = key_of(codes)
        if key in seen:
            continue
        glyphs = shaper.shape(codes)
        if len(glyphs) != 1 or glyphs[0] not in bases:
            left_out.append(key)
            continue
        name = glyphs[0]
        if name not in glyph_of_name:
            content, ids, bbox = compiler.compile(name)
            check_content(content, name)
            # What the glyph names is stored before the glyph, so a document that reads the glyph finds it in the same block or the one before.
            for number in range(len(pool_places), len(pool.entries)):
                pool_places.append(store(pool.entries[number][1:] + "\n"))
            advance = round(font["hmtx"].metrics[name][0] * unit)
            identity = (content, tuple(ids), advance, bbox)
            if identity not in record_of:
                record_of[identity] = len(glyph_rows)
                glyph_rows.append([*store(f"{' '.join(ids)}\n{content}\n"), advance, *bbox])
            glyph_of_name[name] = record_of[identity]
        seen.add(key)
        keys.append(key)
        glyph_of_key.append(glyph_of_name[name])
    flush()

    for number, entry in enumerate(pool.entries):
        kind, body = entry[0], entry[1:]
        if kind == "p":
            check_content(body, f"pool {number}")
            continue
        if kind == "m":
            extras, _, shading = body.partition("|")
            check_text(extras, f"pool {number}", POOL_NAMES)
            body = shading
        check_text(body, f"pool {number}", POOL_NAMES)

    offsets = []
    at = 0
    for packed, raw in blocks:
        offsets.append([at, len(packed), raw])
        at += len(packed)
    index = {
        "version": VERSION,
        "unitsPerEm": 1000,
        "source": {"repository": SOURCE_REPOSITORY, "commit": SOURCE_COMMIT, "path": SOURCE_PATH, "sha256": SOURCE_SHA256},
        "keys": "\n".join(keys),
        "glyphOf": glyph_of_key,
        "glyphs": [value for row in glyph_rows for value in row],
        "pool": [value for place in pool_places for value in place],
        "kinds": "".join(entry[0] for entry in pool.entries),
        "blocks": [value for row in offsets for value in row],
    }
    packed_index = zlib.compress(json.dumps(index, separators=(",", ":"), ensure_ascii=True).encode("ascii"), 9)
    raw_index = len(json.dumps(index, separators=(",", ":"), ensure_ascii=True))
    data = MAGIC + struct.pack(">III", VERSION, len(packed_index), raw_index) + packed_index + b"".join(packed for packed, _ in blocks)

    output = HERE / OUTPUT
    output.write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    raw_total = sum(raw for _, raw in blocks)
    print(f"{OUTPUT}: {len(data)} bytes ({len(data) / 1048576:.2f} MB), SHA-256 {digest}")
    print(f"  {len(keys)} emoji keys, {len(glyph_rows)} glyphs in {len(blocks)} blocks ({raw_total} bytes), pool {len(pool.entries)} entries ({len(shared)} shared shapes), index {len(packed_index)} bytes packed")
    print(f"  left out ({len(left_out)}): {' '.join(left_out[:20])}")
    if len(data) > BUDGET:
        print(f"{OUTPUT} is {len(data)} bytes, more than its budget of {BUDGET}", file=sys.stderr)
        return 1
    if len(data) > TARGET:
        print(f"note: {OUTPUT} is over its target of {TARGET} bytes")
    if pinned != digest:
        print(f"the output differs from SHA256SUMS ({pinned})", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print("Run: python3 vendor/noto-color-emoji/build.py <path to Noto-COLRv1.ttf>", file=sys.stderr)
        return 2
    if fontTools.version != FONTTOOLS_VERSION:
        print(f"fontTools {FONTTOOLS_VERSION} is required (found {fontTools.version})", file=sys.stderr)
        return 1
    return build(Path(sys.argv[1]))


if __name__ == "__main__":
    sys.exit(main())
