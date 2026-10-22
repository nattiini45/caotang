# @caotang/font-noto-hebrew

Noto Sans Hebrew Regular, version 3.001, as the static TrueType file of the Noto project's release. Both PDF writers embed it,
subset to the glyphs a file uses, for Hebrew text. It keeps `GSUB`, `GPOS` and `GDEF`.

The app serves the file from its own origin and fetches it only for an export that holds Hebrew text. The MCP server reads it
from this package, or from `fonts/` beside its bundle.

## Source

- Font: Noto Sans Hebrew 3.001, © 2022 The Noto Project Authors, licensed under the SIL Open Font License 1.1 (LICENSE, the
  `OFL.txt` of the release, unchanged).
- Release: <https://github.com/notofonts/hebrew/releases/tag/NotoSansHebrew-v3.001>, the archive
  <https://github.com/notofonts/hebrew/releases/download/NotoSansHebrew-v3.001/NotoSansHebrew-v3.001.zip> (3,734,185 bytes).
- File: `NotoSansHebrew/unhinted/ttf/NotoSansHebrew-Regular.ttf` of that archive (16,836 bytes), copied as it is. It is a
  static weight-400 font with TrueType (`glyf`) outlines.

SHA256SUMS holds the SHA-256 of the archive and of the file. Check the file with `sha256sum -c SHA256SUMS` from this folder
(the archive line is for whoever fetches it again).

The file is not modified, so there is no build script. The font declares no Reserved Font Name.
