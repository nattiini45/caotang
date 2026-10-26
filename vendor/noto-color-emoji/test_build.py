"""Checks the file build.py writes. Run: python3 -m unittest vendor/noto-color-emoji/test_build.py (fontTools 4.61.1).

These read the files in this directory; the build itself (about three minutes, from the upstream font) runs only when
CAOTANG_NOTO_COLRV1_SOURCE names Noto-COLRv1.ttf. `packages/pdf-fonts/test/colour-emoji.test.ts` checks the checked-in file
without Python, so CI does not depend on this.
"""

import hashlib
import json
import os
import struct
import sys
import unittest
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import build  # noqa: E402


def read_index() -> dict:
    data = (HERE / build.OUTPUT).read_bytes()
    version, packed, _ = struct.unpack(">III", data[4:16])
    assert data[:4] == build.MAGIC and version == build.VERSION
    return json.loads(zlib.decompress(data[16:16 + packed]))


class ColourEmojiFile(unittest.TestCase):
    def test_it_is_the_file_sha256sums_pins(self):
        digest = hashlib.sha256((HERE / build.OUTPUT).read_bytes()).hexdigest()
        self.assertEqual(digest, build.pinned_digest(build.OUTPUT))

    def test_it_is_within_its_budget(self):
        self.assertLessEqual((HERE / build.OUTPUT).stat().st_size, build.BUDGET)

    def test_the_source_is_pinned_by_commit_and_digest(self):
        index = read_index()
        self.assertEqual(index["source"]["commit"], build.SOURCE_COMMIT)
        self.assertEqual(index["source"]["sha256"], build.SOURCE_SHA256)
        self.assertEqual(build.pinned_digest("Noto-COLRv1.ttf"), build.SOURCE_SHA256)

    def test_every_emoji_of_the_list_is_in_it(self):
        keys = set(read_index()["keys"].split("\n"))
        wanted = {build.key_of(codes) for codes in build.emoji_list((HERE / build.EMOJI_LIST).resolve())}
        self.assertEqual(wanted - keys, set())

    def test_the_whitelist_refuses_what_a_glyph_may_not_hold(self):
        build.check_content("0 0 m 10 0 l 10 10 l h f", "ok")
        for bad in ("0 0 m BT", "(text) Tj", "0 0 m /F1 Tf", "q 1 0 0 1 0 0 cm /x0 Do Q ET"):
            with self.assertRaises(SystemExit, msg=bad):
                build.check_content(bad, "bad")
        build.check_text("<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1 1] >>", "ok", build.POOL_NAMES)
        for bad in ("<< /S /JavaScript >>", "<< /Length 5 >>", "(string)", "1 0 R"):
            with self.assertRaises(SystemExit, msg=bad):
                build.check_text(bad, "bad", build.POOL_NAMES)

    @unittest.skipUnless(os.environ.get("CAOTANG_NOTO_COLRV1_SOURCE"), "set CAOTANG_NOTO_COLRV1_SOURCE to rebuild from the upstream font")
    def test_a_build_gives_the_checked_in_bytes(self):
        self.assertEqual(build.build(Path(os.environ["CAOTANG_NOTO_COLRV1_SOURCE"])), 0)


if __name__ == "__main__":
    unittest.main()
