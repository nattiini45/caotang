# @caotang/font-noto-arabic

Noto Sans Arabic Regular, version 2.013, as the static TrueType file of the Noto project's release. Both PDF writers embed it,
subset to the glyphs a file uses, for Arabic, Persian and Urdu text (the basic letters; Nastaliq is not drawn). It keeps
`GSUB`, `GPOS` and `GDEF`, which the shaper reads for the joining forms and the lam-alef ligatures.

The app serves the file from its own origin and fetches it only for an export that holds Arabic-script text. The MCP server
reads it from this package, or from `fonts/` beside its bundle.

## Source

- Font: Noto Sans Arabic 2.013, © 2022 The Noto Project Authors, licensed under the SIL Open Font License 1.1 (LICENSE, the
  `OFL.txt` of the release, unchanged).
- Release: <https://github.com/notofonts/arabic/releases/tag/NotoSansArabic-v2.013>, the archive
  <https://github.com/notofonts/arabic/releases/download/NotoSansArabic-v2.013/NotoSansArabic-v2.013.zip> (18,777,381 bytes).
- File: `NotoSansArabic/unhinted/ttf/NotoSansArabic-Regular.ttf` of that archive (142,140 bytes), copied as it is. It is a
  static weight-400 font with TrueType (`glyf`) outlines, which a PDF can embed (the CFF builds are not used: fontkit 1.1.1
  writes broken CFF subsets).

SHA256SUMS holds the SHA-256 of the archive and of the file. Check the file with `sha256sum -c SHA256SUMS` from this folder
(the archive line is for whoever fetches it again).

The file is not modified, so there is no build script. The font declares no Reserved Font Name.
