# @caotang/font-noto-emoji

Noto Emoji Regular, version 3.006, the monochrome (black-and-white) Noto emoji font, as a static TrueType WOFF file. Both PDF
writers embed it, subset to the glyphs a file uses, for emoji: every fully-qualified emoji of Unicode Emoji 17.0, with
ZWJ sequences, skin-tone sequences, flags, keycaps and tag sequences drawn through the font's own ligatures.

The app serves the file from its own origin and fetches it only for an export that holds an emoji. The MCP server reads it
from this package, or from `fonts/` beside its bundle.

## Source

- Font: Noto Emoji 3.006, © 2013 Google LLC, licensed under the SIL Open Font License 1.1 (LICENSE).
- File: <https://fonts.gstatic.com/s/notoemoji/v65/bMrnmSyK7YY-MEu6aWjPDs-ar6uWaGWuob-r0jwv.ttf>, the static weight-400 TrueType
  file the Google Fonts CSS API serves for Noto Emoji (885,544 bytes), fetched on 2026-10-22 with
  `curl -A curl/8 'https://fonts.googleapis.com/css2?family=Noto+Emoji:wght@400'` for the URL and `curl -O <the URL>` for the
  file. Its `name` table reads "Version 3.006". Upstream builds it in googlefonts/emoji-bw;
  [googlefonts/noto-emoji](https://github.com/googlefonts/noto-emoji) ships only the colour fonts, and the
  [google/fonts](https://github.com/google/fonts/tree/main/ofl/notoemoji) copy is still at 3.002 (issue
  [#7937](https://github.com/google/fonts/issues/7937)). The URL is not pinned by a commit and its `/v65/` segment changes
  when Google updates the font, so the size and the SHA-256 below are what pin the file; when google/fonts or a public
  emoji-bw release carries 3.006 or later, point the pin there (the same bytes or a newer version).
- LICENSE is `ofl/notoemoji/OFL.txt` of google/fonts, unchanged.

SHA256SUMS holds the SHA-256 of the source file and of the built file.

## How the file is built

`python3 build.py NotoEmoji-3.006.ttf`, with fontTools 4.61.1 (`pip install fontTools==4.61.1`). The script checks the
source's SHA-256, then:

1. keeps every character the font maps and every glyph its `ccmp` ligatures reach, keeps GSUB (both PDFs lay emoji
   out through it with fontkit), and drops the vertical metrics and the grid-fitting tables (the source is already a static
   TrueType font, so there is no instancing step);
2. pads each glyph to 4 bytes, writes WOFF 1.0, and compares the result with SHA256SUMS.

This is a Modified Version under the OFL. The font declares no Reserved Font Name, so it keeps its name. It is
monochrome: emoji print in black, and a skin-tone modifier draws the figure without a tone.

Emoji 17.0 is whole: 16.0's 🫩 🫆 🪾 🫜 🪉 🪏 🫟 and the flag of Sark 🇨🇶, and 17.0's 🫪 and 🛘, are one glyph each. HarfBuzz
lays out every fully-qualified emoji of 17.0 as one glyph. fontkit, which both PDFs use, does so for all but 36: the woman and
man walking, kneeling or running facing right (🚶‍♀️‍➡️, with or without a skin tone). Both PDFs draw those with the glyph
HarfBuzz gives them, from a table in packages/pdf-fonts that scripts/emoji-coverage.mjs generates; the font draws them
without a gender sign, as it draws 🚶‍♀️. The font and Unicode's emoji list move together: the test in
packages/pdf-fonts/test/coverage.test.ts fails when the list in the repository is newer than the Emoji version the font
supports.
