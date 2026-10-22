# @caotang/font-noto-cjk

Noto Sans Mono CJK SC Regular, version 2.004, as a TrueType WOFF file. Both PDF writers embed it, subset to the glyphs a file
uses, for text the PDF's built-in fonts cannot encode: Chinese (simplified and traditional), Japanese kana and kanji, Korean
Hangul, and also Greek and Cyrillic. The screenplay PDF needs the Mono family, whose Greek, Cyrillic and halfwidth forms are one
Courier column wide; the storyboard contact sheet uses it too, so its Greek and Cyrillic are monospaced.

The app serves the file from its own origin and fetches it only for an export that needs it. The MCP server reads it from this
package, or from `fonts/` beside its bundle.

## Source

- Font: Noto Sans Mono CJK SC Regular 2.004, © 2014-2021 Adobe, licensed under the SIL Open Font License 1.1 (LICENSE).
- File: <https://github.com/notofonts/noto-cjk/raw/Sans2.004/Sans/Mono/NotoSansMonoCJKsc-Regular.otf> (16,393,784 bytes).
- Tag: `Sans2.004` of <https://github.com/notofonts/noto-cjk> (commit `523d033d6cb47f4a80c58a35753646f5c3608a78`).
- LICENSE is <https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/LICENSE> with the font's copyright notice (Adobe, Reserved Font Name 'Source') above it, as the font's own copy carries it.

SHA256SUMS holds the SHA-256 of the source file and of the built file.

## How the file is built

`python3 build.py NotoSansMonoCJKsc-Regular.otf`, with fontTools 4.61.1 (use a virtual environment: the script refuses any other
version). The script checks the source's SHA-256, then:

1. converts the CFF outlines to TrueType outlines (@pdf-lib/fontkit cannot subset a CID-keyed CFF font correctly), each glyph
   padded to 4 bytes;
2. keeps every character the font maps, and drops the glyphs only OpenType layout reaches, the layout tables, the vertical
   metrics and the hinting;
3. writes WOFF 1.0, and compares the result with SHA256SUMS.

The built file is 7,219,856 bytes, against 16,393,784 for the upstream OTF. This is a Modified Version under the OFL. The font
declares no Reserved Font Name, so it keeps its name. Han characters are drawn in their Simplified Chinese forms, because the
regional forms are reached only through layout features.

`packages/pdf-fonts/src/coverage/noto-cjk-coverage.ts` lists the code points the font maps; it is generated from the built file.
