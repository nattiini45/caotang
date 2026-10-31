# @caotang/font-noto-color-emoji

Noto Color Emoji as vector pictures: every emoji of Unicode Emoji 17.0 (3,953 sequences: ZWJ sequences, skin tones, flags, keycaps, tag
sequences and the facing-right figures, each as one picture) compiled to PDF operators. Both PDF writers draw them as Type 3 glyphs when
Colour emoji is on (`@caotang/pdf-fonts/colour` opens the file, `@caotang/pdf-fonts` writes the fonts). It is not a font file and no font
interpreter ships: the run time only reads a string of operators for each emoji and wraps it as a glyph procedure.

The monochrome Noto Emoji (`@caotang/font-noto-emoji`) stays the default for the screenplay PDF, is what Colour emoji off writes byte for
byte, and prints any emoji this file lacks.

## Size, measured

- The file: 5,237,609 bytes (4.99 MB) as stored. Budget 8 MB, target 6 MB (docs/decisions.md). `build.py` refuses a larger file.
- A PDF with 50 distinct emoji (10 with a skin tone, 5 flags, 5 ZWJ sequences, 30 plain), in `packages/exporter/test/colour-emoji.test.ts`:
  the screenplay PDF grows by 188 KB over the monochrome one, the contact sheet by 66 KB. Budget 300 KB each. The screenplay writer
  writes ASCII only, so its glyph procedures are deflated and then written in hexadecimal; pdf-lib deflates the contact sheet's.

## Source

- Font: Noto-COLRv1.ttf of [googlefonts/noto-emoji](https://github.com/googlefonts/noto-emoji) at commit
  `e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e` (2D/fonts/Noto-COLRv1.ttf, 5,038,236 bytes), © Google LLC, SIL Open Font License 1.1
  (LICENSE, the repository's `2D/fonts/LICENSE`). Raw URL:
  `https://raw.githubusercontent.com/googlefonts/noto-emoji/e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e/2D/fonts/Noto-COLRv1.ttf`.
- Why the font and not the SVG files: the repository has no top-level `svg/` directory. `2D/svg` holds 3,751 files (41.7 MB) keyed by
  file name; the COLRv1 font holds the same pictures with the flags' soft-light blend as paint, and is keyed by the font's own ligatures, so
  every Unicode sequence resolves exactly as HarfBuzz resolves it. The Apache-2.0 SVG sources are not used, so no Apache licence file ships.
  The run-time contract is the same either way, so the choice is reversible.
- SHA256SUMS holds the SHA-256 of the source and of the built file.

## How the file is built

`python3 build.py <path to Noto-COLRv1.ttf>`, with fontTools 4.61.1 (`pip install fontTools==4.61.1`), takes about three minutes. The
script checks the source's SHA-256, then:

1. lays out each fully-qualified emoji and component of `packages/pdf-fonts/test/fixtures/emoji-test-17.0.txt` through the font's own
   `ccmp` feature (a small GSUB reader in `build.py`: ligatures, multiple and single substitutions, and the contexts that call them; its
   result equals HarfBuzz's for all 3,953) to the one glyph the font draws it with, keyed by its code points without variation selectors,
   as lower-case hexadecimal joined by dashes (`1f44d-1f3fd`). A sequence the font does not draw as one glyph would be named and left out (none is);
2. flattens that glyph's COLRv1 paint graph to PDF operators (`paint.py`): solid layers as `r g b rg` and an outline, gradients as axial and
   radial shadings (PaintLinearGradient, PaintRadialGradient) clipped to the layer's outline, a gradient whose opacity varies as a
   shading of its colours drawn through a luminosity soft mask of its opacities, opacity as `ca`, PaintComposite SRC_IN as a clip and SOFT_LIGHT
   as the `SoftLight` blend mode (the flags). The font has no sweep gradient, no `PaintColrGlyph` and no extend mode but pad, so none is read;
   anything else stops the build. Transforms are composed into one `cm` around a layer; outlines are TrueType quadratics written as cubics, and
   a pair of quadratics the font cut from one cubic is written as that cubic again (within 0.8 of 1,024 units);
3. stores a layer outline that two or more emoji fill with a solid colour once, as a Form XObject (`Do`), so the five skin tones of a hand share
   one figure, in the file and in a PDF; the other outlines, and every shading, graphics state and soft mask, are stored once too and named by id;
4. packs everything in blocks of about 48 kB, each deflated alone, so a document with a few emoji inflates only the blocks they are in,
   with the index (keys, glyph table, pool table) deflated after the header;
5. checks every operator of every glyph and every name of every pool entry against a whitelist (paths, colours, shadings, graphics
   states, clips, `Do`: no string, no stream, no reference, no text operator), checks the file against its budget and compares it with SHA256SUMS.

## The file

All numbers are big-endian. `CEMJ`, a version (1), the index's deflated length and its length inflated; then the deflated index (JSON:
`keys`, newline-separated; `glyphOf`, the glyph of each key; `glyphs`, eight numbers each: block, offset, length, advance, then the box in
the 1000-unit em; `pool` and `kinds`: block, offset, length and kind letter of each pool entry; `blocks`: offset, deflated length and
length of each block); then the blocks. A glyph is `ids` and a line of operators; a pool entry is `p` (a shape, `path f`), `s` (a shading
dictionary), `g` (an extended graphics state) or `m` (a soft mask: its extra keys, `|`, and the gray shading). `colour-emoji.ts` checks the
file's length and SHA-256 against `coverage/noto-colour-emoji-coverage.ts` (generated by `packages/pdf-fonts/scripts/colour-emoji-coverage.mjs`)
before it reads anything, and refuses any block that holds a character outside names, numbers, white space and brackets.

## Tests

`packages/pdf-fonts/test/colour-emoji.test.ts` checks the file against SHA256SUMS, its budget and the coverage table, every operator and name
against the whitelist, and the Type 3 writer; `test_build.py` checks the same without Node. Rendering was checked in pdf.js, PDFium and MuPDF
with `tools/render-colour-emoji.mjs` (see docs/testing); Poppler and Ghostscript run through the reader checks of #28 when they land, and Acrobat and
Preview are checked by the owner.
