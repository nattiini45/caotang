# Colour emoji: checking the pictures in real readers

Colour emoji are vector pictures drawn as Type 3 glyphs (screenplay.md §5.3, storyboard.md §6). The unit tests read the file back; the
pictures themselves are looked at, in more than one reader, because Type 3 fonts with shadings, soft masks and blend modes are where
readers differ.

## What runs where

| Reader | Where | How |
| --- | --- | --- |
| pdf.js | here, in Chromium | `tools/render-colour-emoji.mjs`; `tools/pdf-validate/check.mjs` also opens each corpus file in pdf.js and reads its text |
| PDFium, MuPDF | here, when Python has `pypdfium2` and `pymupdf` (scratch tooling: `pip install pypdfium2 pymupdf`, not part of `pnpm install`) | `tools/render-colour-emoji.mjs` |
| Poppler (`pdftocairo`, `pdftotext`, `pdffonts`), Ghostscript, MuPDF's `mutool`, qpdf | CI's `pdf-validate` job, which now holds `screenplay-colour-emoji.pdf` and `sheet-colour-emoji.pdf`; `tools/render-colour-emoji.mjs` runs `pdftocairo` and `gs` too when they are on PATH | `node tools/pdf-validate/check.mjs <dir> --external` |
| Acrobat, macOS Preview | not checked here | the owner |

## Running it

```sh
CAOTANG_PDF_OUT=/tmp/pdfs pnpm exec vitest run packages/exporter/test/pdf-write-corpus.test.ts
node tools/pdf-validate/check.mjs /tmp/pdfs
node tools/render-colour-emoji.mjs /tmp/pdfs /tmp/renders
```

The renders are `<name>-pdfjs.png`, `-pdfium.png`, `-mupdf.png`, `-poppler.png` and `-ghostscript.png`, page 1 at three times its size. Open
them side by side: a glyph that one engine draws differently (a missing gradient, a black box where a soft mask is, a flag without its
soft-light shading) fails the check, whatever the others show. The script's exit code says only that an engine could not draw a file.

## Before and after

`CAOTANG_PDF_OUT` also holds the black-and-white twins (`screenplay-emoji.pdf`, `sheet-cjk-emoji.pdf`: the option off), so one run gives the
before and the after of the same emoji. A rendering that is visibly wrong in pdf.js, PDFium or MuPDF stops the feature (docs/decisions.md): the
option is removed and the monochrome path stays.
