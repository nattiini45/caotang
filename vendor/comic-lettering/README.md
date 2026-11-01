# @caotang/font-comic-lettering

The two faces of Caotang's comic lettering, as TrueType WOFF files: **Comic Neue** 2.003 (Regular, Italic, Bold, Bold Italic) for
balloon and caption text, and **Bangers** 2.100 (Regular) for sound effects. Both are under the SIL Open Font License 1.1; the
licence texts are `LICENSE-ComicNeue.txt` and `LICENSE-Bangers.txt`, the `OFL.txt` of each family in google/fonts, unchanged.
The comic page view, the comic PDF and the CBZ rasteriser draw with them (docs/architecture/comics.md §4).

The app serves the files from its own origin; the Node hosts read them from this package, or from `fonts/` beside a bundle.
Neither face has Light weights here: the lettering uses Regular and Bold, with their obliques for emphasis, thoughts and radio.

## Source

All five files come from <https://github.com/google/fonts> at commit `6157dfaa640ca5738b4d1a7070fe389c3036d7fc`, as
`https://raw.githubusercontent.com/google/fonts/6157dfaa640ca5738b4d1a7070fe389c3036d7fc/ofl/<family>/<file>`:

| Source file | Bytes | Upstream |
|---|---|---|
| `ofl/comicneue/ComicNeue-Regular.ttf` | 57,248 | <https://github.com/crozynski/comicneue>, commit `c5ee07b5eebc4cc6347badfad56cb0c705a2e41e` (as google/fonts records it) |
| `ofl/comicneue/ComicNeue-Italic.ttf` | 54,392 | same |
| `ofl/comicneue/ComicNeue-Bold.ttf` | 55,716 | same |
| `ofl/comicneue/ComicNeue-BoldItalic.ttf` | 55,928 | same |
| `ofl/bangers/Bangers-Regular.ttf` | 93,148 | <https://github.com/googlefonts/bangers>, commit `ca6d2f15db343ee373e9c62a127f3a48cd251228` (as google/fonts records it) |

- Comic Neue: Copyright 2014 The Comic Neue Project Authors (Craig Rozynski, Hrant Papazian). Bangers: Copyright 2010 The
  Bangers Project Authors (Vernon Adams). Neither declares a Reserved Font Name, so the converted files keep their names.
- `ofl/comicneue/OFL.txt` and `ofl/bangers/OFL.txt` at the same commit are the licence files.

SHA256SUMS holds the SHA-256 of each source file and of each built file.

## How the files are built

`python3 build.py <directory holding the five source .ttf files>`, with fontTools 4.61.1 (use a virtual environment: the script
refuses any other version). The script checks each source's SHA-256, converts it, and compares each output with SHA256SUMS: the
build fails when they differ, and fails before it starts when SHA256SUMS has no line for an output. The same sources, fontTools
and zlib give the same bytes (`python3 -m unittest test_build.py` checks it, and that the glyph outlines and every layout table
are the source's). Three things change, and this is a Modified Version under the OFL:

1. the file is stored as WOFF 1.0 (zlib), with TrueType (`glyf`) outlines, which a browser loads and which fontkit reads and subsets;
2. each glyph is padded to 4 bytes, which fontkit's subsetter needs (Bangers and Comic Neue Bold Italic are padded to 2 upstream);
3. the DSIG table is dropped, since a signature of the original file does not hold for the converted one.

The outlines, hinting, `cmap`, `GSUB`, `GPOS`, `GDEF` and the name table are the source's, and the font is not subset. The
repository test `test/comic-lettering-fonts.test.ts` checks every file against SHA256SUMS and the WOFF structure.

## What the fonts hold

- Comic Neue: 328 glyphs (344 in the obliques), Latin with accents, `ß` (U+00DF), no `ẞ` (U+1E9E), `—` and `–`. `GSUB` has
  only `aalt`, `case`, `ccmp`, `frac`, `ordn` and `sups`. The capital `I` is one glyph, drawn with a top and bottom bar in every
  weight, and there is no plain-stem alternate (see docs/architecture/comics.md §4, crossbar I).
- Bangers: 597 glyphs, Latin, `ß` and `ẞ`, `GSUB` with `aalt`, `case`, `ccmp`, `frac`, `locl`, `ordn`, `sups` and `zero`. Its
  capital `I` is a slanted stem with no bars.
