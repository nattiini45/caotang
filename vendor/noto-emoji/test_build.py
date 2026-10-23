"""Checks the files build.py writes. Run: python3 -m unittest vendor/noto-emoji/test_build.py (fontTools 4.61.1).

The check that needs the upstream TTF runs only when CAOTANG_NOTO_EMOJI_SOURCE names it; the rest read the files in this
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


def stage(work: Path) -> None:
    for name in ("SHA256SUMS", build.COMMON_LIST, build.OUTPUT):
        shutil.copy(HERE / name, work / name)


class CommonFont(unittest.TestCase):
    def test_the_files_are_the_ones_sha256sums_pins(self):
        for name in (build.OUTPUT, build.COMMON_OUTPUT):
            self.assertEqual(sha256(HERE / name), build.pinned_digest(name), name)

    def test_the_cmap_is_exactly_the_listed_code_points(self):
        self.assertEqual(set(TTFont(HERE / build.COMMON_OUTPUT).getBestCmap()), build.listed(HERE / build.COMMON_LIST))

    def test_every_listed_code_point_is_in_the_full_font(self):
        self.assertLessEqual(build.listed(HERE / build.COMMON_LIST), set(TTFont(HERE / build.OUTPUT).getBestCmap()))

    def test_it_is_within_its_budget_and_smaller_than_the_full_font(self):
        size = (HERE / build.COMMON_OUTPUT).stat().st_size
        self.assertLessEqual(size, build.COMMON_BUDGET)
        self.assertLess(size, (HERE / build.OUTPUT).stat().st_size)

    def test_two_builds_give_the_same_bytes(self):
        with tempfile.TemporaryDirectory() as scratch:
            work = Path(scratch)
            stage(work)
            original_here, original_argv = build.HERE, sys.argv
            build.HERE = work
            try:
                sys.argv = ["build.py", "--common"]
                self.assertEqual(build.main(), 0)
                first = (work / build.COMMON_OUTPUT).read_bytes()
                (work / build.COMMON_OUTPUT).unlink()
                self.assertEqual(build.main(), 0)
                self.assertEqual((work / build.COMMON_OUTPUT).read_bytes(), first)
            finally:
                build.HERE, sys.argv = original_here, original_argv
            self.assertEqual(first, (HERE / build.COMMON_OUTPUT).read_bytes())

    def test_the_build_fails_over_its_budget(self):
        with tempfile.TemporaryDirectory() as scratch:
            work = Path(scratch)
            stage(work)
            original_here, original_budget = build.HERE, build.COMMON_BUDGET
            build.HERE, build.COMMON_BUDGET = work, 100_000
            try:
                self.assertEqual(build.build_common(), 1)
            finally:
                build.HERE, build.COMMON_BUDGET = original_here, original_budget

    def test_the_build_fails_for_a_code_point_the_font_does_not_map(self):
        with tempfile.TemporaryDirectory() as scratch:
            work = Path(scratch)
            stage(work)
            with open(work / build.COMMON_LIST, "a", encoding="utf-8") as listing:
                listing.write("0378\n")
            original_here = build.HERE
            build.HERE = work
            try:
                self.assertEqual(build.build_common(), 1)
            finally:
                build.HERE = original_here


@unittest.skipUnless(os.environ.get("CAOTANG_NOTO_EMOJI_SOURCE"), "CAOTANG_NOTO_EMOJI_SOURCE names the upstream TTF")
class FromTheSource(unittest.TestCase):
    def test_the_full_build_gives_the_pinned_files(self):
        original_argv = sys.argv
        sys.argv = ["build.py", os.environ["CAOTANG_NOTO_EMOJI_SOURCE"]]
        try:
            self.assertEqual(build.main(), 0)
        finally:
            sys.argv = original_argv


if __name__ == "__main__":
    unittest.main()
