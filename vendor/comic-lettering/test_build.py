"""Checks the files build.py writes. Run: python3 -m unittest vendor/comic-lettering/test_build.py (fontTools 4.61.1).

The checks that need the upstream TrueType files run only when CAOTANG_COMIC_LETTERING_SOURCE names the directory that holds
them; the rest read the files in this directory. `test/comic-lettering-fonts.test.ts` checks the checked-in files without
Python, so CI does not depend on this.
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import build  # noqa: E402

SOURCE = os.environ.get("CAOTANG_COMIC_LETTERING_SOURCE")


class BuiltFiles(unittest.TestCase):
    def test_the_files_are_the_ones_sha256sums_pins(self):
        for _, output_name in build.FONTS.values():
            self.assertEqual(build.sha256(HERE / output_name), build.pinned_digest(output_name), output_name)

    def test_each_file_is_a_truetype_woff_without_a_signature(self):
        for _, output_name in build.FONTS.values():
            font = TTFont(HERE / output_name)
            self.assertEqual(font.flavor, "woff", output_name)
            self.assertIn("glyf", font, output_name)
            self.assertNotIn("DSIG", font, output_name)

    def test_every_glyph_is_padded_to_four_bytes(self):
        for _, output_name in build.FONTS.values():
            font = TTFont(HERE / output_name)
            self.assertTrue(all(offset % 4 == 0 for offset in font["loca"].locations), output_name)


@unittest.skipUnless(SOURCE, "CAOTANG_COMIC_LETTERING_SOURCE names the directory of the five source files")
class FromSources(unittest.TestCase):
    def test_the_outlines_and_layout_tables_are_the_sources(self):
        for source_name, (_, output_name) in build.FONTS.items():
            source = TTFont(Path(SOURCE) / source_name)
            built = TTFont(HERE / output_name)
            self.assertEqual(source.getBestCmap(), built.getBestCmap(), output_name)
            for table in ("GSUB", "GPOS", "GDEF", "hmtx", "name", "OS/2", "cmap", "fpgm", "prep", "cvt "):
                self.assertEqual(source.getTableData(table), built.getTableData(table), f"{output_name} {table}")
            for glyph in source.getGlyphOrder():
                a = source["glyf"][glyph].getCoordinates(source["glyf"])
                b = built["glyf"][glyph].getCoordinates(built["glyf"])
                self.assertEqual((list(a[0]), a[1], a[2]), (list(b[0]), b[1], b[2]), f"{output_name} {glyph}")

    def test_two_builds_give_the_same_bytes(self):
        with tempfile.TemporaryDirectory() as scratch:
            for source_name, (_, output_name) in build.FONTS.items():
                first = Path(scratch) / f"a-{output_name}"
                second = Path(scratch) / f"b-{output_name}"
                build.convert(Path(SOURCE) / source_name, first)
                build.convert(Path(SOURCE) / source_name, second)
                self.assertEqual(first.read_bytes(), second.read_bytes(), output_name)


if __name__ == "__main__":
    unittest.main()
