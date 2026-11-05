# Landing assets

`export-page.webp` is the top page of the Export tile ("If you can type it, you can print it"). It is a real screenplay PDF page
written by Caotang's own renderer (`createPdfRenderer` in `packages/screenplay`, with the Node font loaders of `@caotang/pdf-fonts` and
`colourEmoji: true`), not a drawing, so the Chinese, Arabic and emoji in it are what the export prints. Made on 2026-11-02 from:

```fountain
INT. FERRY TERMINAL - NIGHT

Rain on the glass.

Mei slides a letter across.

MEI
The address is 灯塔路 7号.
Ask for سارة at the harbour. ⚓

The clerk reads it twice.

CLERK
Sara keeps the light now.
```

Rasterised and cropped with Poppler and ImageMagick (the crop is 90–450 pt across and 0–336 pt down a US Letter page, at 120 dpi; the
tile shows it at half size, so it is sharp at 2x):

```sh
pdftoppm -r 120 -png -x 150 -y 0 -W 600 -H 560 script.pdf page
magick page-1.png -quality 84 -define webp:method=6 export-page.webp
```
