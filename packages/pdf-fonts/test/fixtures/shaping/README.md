# Shaping spike (issue #34)

`golden.json` is the result of the gate that decided whether fontkit 1.1.1 may shape Arabic and Hebrew. `scripts/shaping-spike.mjs`
(a scratch script: harfbuzzjs is installed in a directory of its own and is in no package.json) shapes 78 samples with both
engines on the vendored Noto Sans Arabic 2.013 and Noto Sans Hebrew 3.001 and lists, for each, the HarfBuzz 1.6.3 glyphs
(the reference), the fontkit glyphs, and whether they agree. Glyphs are left to right as drawn, with advance and offsets in
font units.

| Samples | Agree |
| --- | --- |
| Arabic without marks: plain words and sentences, lam-alef (`لا`, `لأ`, `لإ`, `لآ`), Persian and Urdu letters, ZWNJ, digits | 41 of 41 |
| Hebrew without points, including final forms, maqaf and gershayim | 13 of 13 |
| Arabic with harakat, shadda or dagger alef | 6 of 11 (one throws in fontkit) |
| Hebrew with niqqud or cantillation | 4 of 8 |
| The marked samples with their marks removed | 19 of 19 |

What it decides (docs/decisions.md, the Arabic and Hebrew entry):

- Unmarked Arabic matches HarfBuzz, so Arabic ships on fontkit 1.1.1.
- A combining mark is not shown to place like HarfBuzz places it (the glyph ids differ where fontkit composes shadda with a
  vowel or a shin dot with a vowel differently, and one text makes fontkit throw), so Hebrew points and cantillation and
  Arabic tashkeel are left out of the drawn run, and the compile log says how many. `/ActualText` keeps them for copy and search.
- The marked samples agree once their marks are removed, which is the text the drawn run is shaped from.

To run it again: `HARFBUZZJS=<scratch>/node_modules/harfbuzzjs/dist/index.mjs node packages/pdf-fonts/scripts/shaping-spike.mjs`.
`test/shaper.test.ts` checks the fontkit backend against this file.
