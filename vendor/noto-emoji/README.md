# @caotang/font-noto-emoji

Noto Emoji Regular, version 3.002, the monochrome (black-and-white) Noto emoji font, as a static TrueType WOFF file. The PDF
exporter embeds it, subset to the glyphs a file uses, for emoji: every fully-qualified emoji of Unicode Emoji 15.1, with
ZWJ sequences, skin-tone sequences, flags, keycaps and tag sequences drawn through the font's own ligatures.

The app serves the file from its own origin and fetches it only for an export that holds an emoji. The MCP server reads it
from this package, or from `fonts/` beside its bundle.

## Source

- Font: Noto Emoji 3.002, © 2013 Google LLC, licensed under the SIL Open Font License 1.1 (LICENSE).
- File: <https://raw.githubusercontent.com/google/fonts/b979dba422e445492b0eb9951ac52ee0b4d648c3/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf>,
  the variable font (weight 300–700) Google Fonts publishes, from commit `b979dba422e445492b0eb9951ac52ee0b4d648c3` of
  <https://github.com/google/fonts> ("Update Noto Emoji to the 3.002 release", 2024-06-05). Upstream builds it in
  googlefonts/emoji-bw; [googlefonts/noto-emoji](https://github.com/googlefonts/noto-emoji) ships only the colour fonts.
- LICENSE is `ofl/notoemoji/OFL.txt` at the same commit, unchanged.

SHA256SUMS holds the SHA-256 of the source file and of the built file.

## How the file is built

`python3 build.py 'NotoEmoji[wght].ttf'`, with fontTools 4.61.1. The script checks the source's SHA-256, then:

1. instances the variable font at weight 400 (Regular) into a static TrueType font;
2. keeps every character the font maps and every glyph its `ccmp` ligatures reach, keeps GSUB (the exporter lays emoji
   out through it with fontkit), and drops the vertical metrics and the grid-fitting table;
3. writes WOFF 1.0, and compares the result with SHA256SUMS.

This is a Modified Version under the OFL. The font declares no Reserved Font Name, so it keeps its name. It is
monochrome: emoji print in black, and a skin-tone modifier draws the figure without a tone.

Emoji added after Unicode Emoji 15.1 (16.0's 🫩 🫆 🪾 🫜 🪉 🪏 🫟, and later) are not in the font; 16.0's flag of Sark prints as
its two regional-indicator letters.
