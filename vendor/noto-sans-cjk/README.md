# @caotang/font-noto-cjk

Noto Sans Mono CJK SC Regular and Bold, version 2.004, as TrueType WOFF files. Both PDF writers embed it, subset to the glyphs a file
uses, for text the PDF's built-in fonts cannot encode: Chinese (simplified and traditional), Japanese kana and kanji, Korean
Hangul, and also Greek and Cyrillic. The screenplay PDF needs the Mono family, whose Greek, Cyrillic and halfwidth forms are one
Courier column wide; the storyboard contact sheet uses it too, so its Greek and Cyrillic are monospaced.

The Bold sets the same text in a bold place: the storyboard contact sheet's title, page label and number chip (storyboard.md §6),
read only when one of them holds such text. The screenplay PDF draws no bold and does not read it. Without it, or when it cannot be
read, a bold run is the Regular thickened by a stroke (`@caotang/pdf-fonts`, embolden.ts).

The package holds two files of each weight. Of the Regular: `NotoSansMonoCJKsc-Regular.woff`, every character of the font (10,692,940 bytes), and
`NotoSansMonoCJKsc-Regular-common.woff`, the same font cut to the characters of everyday use (1,956,568 bytes, about a fifth). A PDF
whose characters are all in the common file reads only that; one character outside it reads the full file, and prints like any
other, so a PDF holds the same glyphs whichever file was read (`@caotang/pdf-fonts/common`).

Of the Bold, the same two: `NotoSansMonoCJKsc-Bold.woff` (10,786,312 bytes) and `NotoSansMonoCJKsc-Bold-common.woff` (1,968,608
bytes). Each maps exactly the characters of the Regular's file of its kind, so the Regular's coverage tables choose the Bold's file too.

Why this Bold: it is the Mono family's own Bold, the weight beside the Regular in the same upstream release, so its Greek, Cyrillic
and halfwidth forms are monospaced as the Regular's are, it has the same `locl` forms, and it maps the same characters; Noto Sans CJK
(proportional) Bold would change those widths in a bold place. Like the Regular it is built to TrueType outlines, never CFF, since
@pdf-lib/fontkit 1.1.1 writes broken CFF subsets.

The app serves the files from its own origin and fetches one only for an export that needs it. The MCP server reads them from this
package, or from `fonts/` beside its bundle.

## Source

- Font: Noto Sans Mono CJK SC Regular and Bold 2.004, © 2014-2021 Adobe, licensed under the SIL Open Font License 1.1 (LICENSE).
- Files: <https://github.com/notofonts/noto-cjk/raw/Sans2.004/Sans/Mono/NotoSansMonoCJKsc-Regular.otf> (16,393,784 bytes) and
  <https://github.com/notofonts/noto-cjk/raw/Sans2.004/Sans/Mono/NotoSansMonoCJKsc-Bold.otf> (16,958,476 bytes).
- Tag: `Sans2.004` of <https://github.com/notofonts/noto-cjk> (commit `523d033d6cb47f4a80c58a35753646f5c3608a78`).
- LICENSE is <https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/LICENSE> with the font's copyright notice (Adobe, Reserved Font Name 'Source') above it, as the font's own copy carries it. Both weights carry the same notice.

SHA256SUMS holds the SHA-256 of each weight's source file and of its two built files.

## How the file is built

`python3 build.py NotoSansMonoCJKsc-Regular.otf NotoSansMonoCJKsc-Bold.otf` (either or both; the common step that follows cuts both weights' common files, so both full files must be beside the script), with fontTools 4.61.1 (use a virtual
environment: the script refuses any other version). The script tells the weight by the source's SHA-256 (`WEIGHTS` in build.py), and
refuses a file that is neither, then builds that weight's full file:

1. converts the CFF outlines to TrueType outlines (@pdf-lib/fontkit cannot subset a CID-keyed CFF font correctly), each glyph
   padded to 4 bytes;
2. keeps every character the font maps, with the regional forms its `locl` feature reaches (the Japanese, Korean, Traditional
   Chinese and Hong Kong forms of a Han character, and of fullwidth punctuation) and the GSUB lookups behind it, and drops the
   glyphs only other layout features reach, GPOS and GDEF, the vertical metrics and the hinting;
3. writes WOFF 1.0, and compares the result with SHA256SUMS. The build fails when a full file is larger than 11 MB (11 * 1024 * 1024
   bytes, `FULL_BUDGET` in build.py).

Each weight's common file is then cut from its full file, the same way, to the characters of `common-charset.txt`, with the regional forms
of those characters, and compared with SHA256SUMS. `python3 build.py --common` builds only the common files of both weights, from the full
files beside the script, with no source download. The build fails when a common file is larger than 2 MB (2 * 1024 * 1024 bytes,
`COMMON_BUDGET` in build.py), or when `common-charset.txt` names a character the full font does not map. A common file keeps its
full file's `head`, `hhea` and `maxp` numbers, so fontkit cuts the same font program from either file.

## The common character set

`common-charset.txt` lists the code points of the common file, as hexadecimal code points and ranges. `charset.py` writes it from
the full font and Unihan (`python3 charset.py Unihan.zip`, <https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip>, Unicode 18.0.0,
under the Unicode License, <https://www.unicode.org/terms_of_use.html>); the file is checked in, and the build never needs Unihan.
The set is:

- every character the full font maps outside the Han blocks and the Hangul syllables: Latin, punctuation, fullwidth forms, kana,
  Bopomofo, Hangul jamo, Greek, Cyrillic and symbols (3,020 code points);
- the 2,350 Hangul syllables of KS X 1001, the Korean standard's syllables of everyday use;
- 4,460 Han characters from Unihan: `kTGH` serial 1 to 3500 (level 1 of the Table of General Standard Chinese Characters, 2013, the
  Simplified Chinese characters of everyday use), `kJoyoKanji` (the Japanese joyo kanji) and `kGradeLevel` 1 or 2 (Hong Kong's
  first two primary grades, the Traditional Chinese characters of everyday use).

The set is a working set, and a document can hold a character outside it: a rarer Han character, a Hangul syllable outside KS X
1001, a Traditional Chinese character of a later grade. That document reads the full file. Raising the Hong Kong grade to 3 adds
133 characters for 66 kB, and was left out. `packages/pdf-fonts/test/common-fonts.test.ts` checks the
file's cmap against `common-charset.txt`, its size against the budget, its SHA-256 against SHA256SUMS, and that it draws every
character it holds as the full file does, in the forms of every language; `test_build.py` checks the same without Node, and that
two builds give the same bytes, for both weights, and that the Bold maps what the Regular maps (`python3 -m unittest test_build.py`).
`packages/pdf-fonts/test/bold-cjk-font.test.ts` checks the Bold's files the same way in Node.

The built Regular is 10,692,940 bytes, against 16,393,784 for the upstream OTF; the `locl` forms are 3,473,084 of them (the build
without them was 7,219,856 bytes). The built Bold is 10,786,312 bytes, against 16,958,476. Each is a Modified Version under the OFL.
The font declares no Reserved Font Name, so it keeps its name (`NotoSansMonoCJKsc-Regular`, `NotoSansMonoCJKsc-Bold`). A Han character is drawn in its Simplified Chinese form, the font's cmap, unless a PDF writer asks for the
forms of a language: `layout(character, undefined, 'hani', tag)` in fontkit, with the tag `hanLocaleTag` gives for the
project's language (`packages/pdf-fonts/src/han-locale.ts`: `JAN ` for Japanese, `KOR ` for Korean, `ZHT ` for Traditional
Chinese, `ZHH ` for Hong Kong).

`packages/pdf-fonts/src/coverage/noto-cjk-coverage.ts` lists the code points the full font maps, and `noto-common-coverage.ts` the
code points the common file maps; they are generated from the built files.
