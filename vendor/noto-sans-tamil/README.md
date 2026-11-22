# @caotang/font-noto-tamil

NotoSansTamil Regular, version 2.004, as the static TrueType file of the Noto project's release. Both PDF writers embed
it, subset to the glyphs a file uses, for Tamil text. It keeps `GSUB`, `GPOS` and `GDEF`, which the shaper reads for
conjuncts, reordered vowel signs, reph and the stacked marks.

The app serves the file from its own origin and fetches it only for an export that holds sTamil text. The MCP server
reads it from this package, or from `fonts/` beside its bundle.

## Source

- Font: NotoSansTamil 2.004, © The Noto Project Authors, licensed under the SIL Open Font License 1.1 (LICENSE, the
  `OFL.txt` of the release, unchanged).
- Release: <https://github.com/notofonts/tamil/releases/tag/NotoSansTamil-v2.004>, the archive
  <https://github.com/notofonts/tamil/releases/download/NotoSansTamil-v2.004/NotoSansTamil-v2.004.zip> (15,229,102 bytes).
- File: `NotoSansTamil/unhinted/ttf/NotoSansTamil-Regular.ttf` of that archive (46,600 bytes), copied as it is. It is a static weight-400 font
  with TrueType (`glyf`) outlines, which a PDF can embed (the CFF builds are not used: fontkit 1.1.1 writes broken CFF
  subsets).

SHA256SUMS holds the SHA-256 of the archive and of the file. Check the file with `sha256sum -c SHA256SUMS` from this
folder (the archive line is for whoever fetches it again).

The file is not modified, so there is no build script. The font declares no Reserved Font Name.
