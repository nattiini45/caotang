# @caotang/font-noto-devanagari

Noto Sans Devanagari Regular, version 2.007, as the static TrueType file of the Noto project's release. Both PDF writers embed
it, subset to the glyphs a file uses, for Hindi, Marathi, Nepali and Sanskrit text. It keeps `GSUB`, `GPOS` and `GDEF`, which
the shaper reads for conjuncts, the reordered short i, reph and the stacked marks.

The app serves the file from its own origin and fetches it only for an export that holds Devanagari text. The MCP server reads
it from this package, or from `fonts/` beside its bundle.

## Source

- Font: Noto Sans Devanagari 2.007, © 2022 The Noto Project Authors, licensed under the SIL Open Font License 1.1 (LICENSE, the
  `OFL.txt` of the release, unchanged).
- Release: <https://github.com/notofonts/devanagari/releases/tag/NotoSansDevanagari-v2.007>, the archive
  <https://github.com/notofonts/devanagari/releases/download/NotoSansDevanagari-v2.007/NotoSansDevanagari-v2.007.zip> (18,449,254 bytes).
- File: `NotoSansDevanagari/unhinted/ttf/NotoSansDevanagari-Regular.ttf` of that archive (184,228 bytes), copied as it is. It is
  a static weight-400 font with TrueType (`glyf`) outlines, which a PDF can embed (the CFF builds are not used: fontkit 1.1.1
  writes broken CFF subsets).

SHA256SUMS holds the SHA-256 of the archive and of the file. Check the file with `sha256sum -c SHA256SUMS` from this folder
(the archive line is for whoever fetches it again).

The file is not modified, so there is no build script. The font declares no Reserved Font Name.
