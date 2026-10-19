# @caotang/font-noto-cjk

Noto Sans CJK SC Regular, version 2.004, as a TrueType WOFF file. The PDF exporter embeds it, subset to the glyphs a file
uses, for text the PDF's built-in Helvetica cannot encode: Chinese (simplified and traditional), Japanese kana and kanji,
Korean Hangul, and also Greek and Cyrillic.

The app serves the file from its own origin and fetches it only for an export that needs it. The MCP server reads it from
this package, or from `fonts/` beside its bundle.

## Source

- Font: Noto Sans CJK SC Regular 2.004, © 2014-2021 Adobe, licensed under the SIL Open Font License 1.1 (LICENSE).
- File: <https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf>
- Tag: `Sans2.004` of <https://github.com/notofonts/noto-cjk> (commit `523d033d6cb47f4a80c58a35753646f5c3608a78`).
- LICENSE is <https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/LICENSE>, unchanged.

SHA256SUMS holds the SHA-256 of the source file and of the built file.

## How the file is built

`python3 build.py NotoSansCJKsc-Regular.otf`, with fontTools 4.61.1. The script checks the source's SHA-256, then:

1. converts the CFF outlines to TrueType outlines (pdf-lib's fontkit cannot subset a CID-keyed CFF font correctly);
2. keeps every character the font maps, and drops the glyphs only OpenType layout reaches, the layout tables, the
   vertical metrics and the hinting;
3. writes WOFF 1.0, and compares the result with SHA256SUMS.

This is a Modified Version under the OFL. The font declares no Reserved Font Name, so it keeps its name. Han characters
are drawn in their Simplified Chinese forms, because the regional forms are reached only through layout features.
