"""Checks the files build.py writes, for both weights. Run: python3 -m unittest vendor/noto-sans-cjk/test_build.py (fontTools 4.61.1).

The checks that need the upstream OTFs run only when CAOTANG_NOTO_CJK_SOURCE names the Regular (and CAOTANG_NOTO_CJK_BOLD_SOURCE
the Bold); the rest read the files in this
directory. The test `packages/pdf-fonts/test/common-fonts.test.ts` checks the checked-in files without Python, so CI does not depend on this.
"""

import hashlib
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import build  # noqa: E402


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def scratch_copy(work: Path) -> None:
    """Copies what `build.py --common` reads into a scratch directory."""
    names = ["SHA256SUMS", build.COMMON_CHARSET] + [weight.output for weight in build.WEIGHTS]
    for name in names:
        shutil.copy(HERE / name, work / name)


class CommonFont(unittest.TestCase):
    def test_the_files_are_the_ones_sha256sums_pins(self):
        for weight in build.WEIGHTS:
            for name in (weight.output, weight.common_output):
                self.assertEqual(sha256(HERE / name), build.pinned_digest(name), name)

    def test_the_cmap_is_exactly_the_declared_charset(self):
        declared = build.charset(HERE / build.COMMON_CHARSET)
        for weight in build.WEIGHTS:
            self.assertEqual(set(TTFont(HERE / weight.common_output).getBestCmap()), declared, weight.name)

    def test_every_declared_character_is_in_the_full_font(self):
        declared = build.charset(HERE / build.COMMON_CHARSET)
        for weight in build.WEIGHTS:
            self.assertLessEqual(declared, set(TTFont(HERE / weight.output).getBestCmap()), weight.name)

    def test_the_bold_maps_what_the_regular_maps(self):
        # The PDF writers pick a file from the Regular's tables (noto-cjk-coverage.ts, noto-common-coverage.ts), for the Bold too.
        for kind in ("output", "common_output"):
            regular = set(TTFont(HERE / getattr(build.REGULAR, kind)).getBestCmap())
            bold = set(TTFont(HERE / getattr(build.BOLD, kind)).getBestCmap())
            self.assertEqual(regular, bold, kind)

    def test_the_bold_is_a_bold(self):
        font = TTFont(HERE / build.BOLD.output)
        self.assertEqual(font["OS/2"].usWeightClass, 700)
        self.assertEqual(font["name"].getDebugName(6), "NotoSansMonoCJKsc-Bold")
        self.assertIn("glyf", font)
        self.assertNotIn("CFF ", font)

    def test_each_file_is_within_its_budget(self):
        for weight in build.WEIGHTS:
            common = (HERE / weight.common_output).stat().st_size
            full = (HERE / weight.output).stat().st_size
            self.assertLessEqual(common, build.COMMON_BUDGET, weight.name)
            self.assertLessEqual(full, build.FULL_BUDGET, weight.name)
            self.assertLess(common, full, weight.name)

    def test_two_builds_give_the_same_bytes(self):
        with tempfile.TemporaryDirectory() as scratch:
            work = Path(scratch)
            scratch_copy(work)
            original_here, original_argv = build.HERE, sys.argv
            build.HERE = work
            try:
                sys.argv = ["build.py", "--common"]
                self.assertEqual(build.main(), 0)
                first = {w.name: (work / w.common_output).read_bytes() for w in build.WEIGHTS}
                for weight in build.WEIGHTS:
                    (work / weight.common_output).unlink()
                self.assertEqual(build.main(), 0)
                for weight in build.WEIGHTS:
                    self.assertEqual((work / weight.common_output).read_bytes(), first[weight.name], weight.name)
            finally:
                build.HERE, sys.argv = original_here, original_argv
            for weight in build.WEIGHTS:
                self.assertEqual(first[weight.name], (HERE / weight.common_output).read_bytes(), weight.name)

    def test_the_build_fails_over_its_budget(self):
        with tempfile.TemporaryDirectory() as scratch:
            work = Path(scratch)
            scratch_copy(work)
            original_here, original_budget = build.HERE, build.COMMON_BUDGET
            build.HERE, build.COMMON_BUDGET = work, 1_000_000
            try:
                for weight in build.WEIGHTS:
                    self.assertEqual(build.build_common(weight), 1, weight.name)
            finally:
                build.HERE, build.COMMON_BUDGET = original_here, original_budget

    def test_the_build_fails_for_a_character_the_font_does_not_map(self):
        with tempfile.TemporaryDirectory() as scratch:
            work = Path(scratch)
            scratch_copy(work)
            with open(work / build.COMMON_CHARSET, "a", encoding="utf-8") as charset:
                charset.write("0378\n")
            original_here = build.HERE
            build.HERE = work
            try:
                for weight in build.WEIGHTS:
                    self.assertEqual(build.build_common(weight), 1, weight.name)
            finally:
                build.HERE = original_here

    def test_the_build_refuses_a_source_that_is_not_pinned(self):
        with tempfile.TemporaryDirectory() as scratch:
            other = Path(scratch) / "other.otf"
            other.write_bytes(b"OTTO not the font")
            self.assertIsNone(build.weight_of(other))
            self.assertEqual(build.build_full(other), 1)


@unittest.skipUnless(os.environ.get("CAOTANG_NOTO_CJK_SOURCE"), "CAOTANG_NOTO_CJK_SOURCE names the upstream OTF")
class FromTheSource(unittest.TestCase):
    def test_the_full_build_gives_the_pinned_files(self):
        original_argv = sys.argv
        sources = [os.environ["CAOTANG_NOTO_CJK_SOURCE"]]
        if os.environ.get("CAOTANG_NOTO_CJK_BOLD_SOURCE"):
            sources.append(os.environ["CAOTANG_NOTO_CJK_BOLD_SOURCE"])
        sys.argv = ["build.py", *sources]
        try:
            self.assertEqual(build.main(), 0)
        finally:
            sys.argv = original_argv


if __name__ == "__main__":
    unittest.main()
