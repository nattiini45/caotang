# Import: EPUB

> Status: **built** (#296, epic #263). The package `packages/import-epub` (`@caotang/import-epub`) reads an EPUB 2 or EPUB 3 book
> into the import block list over the shared XHTML walker ([import-html.md](import-html.md)), and the desktop's **Import EPUB…**
> opens it in the shared preview ([import-preview.md](import-preview.md)). No DOM, no third-party dependency, no script ever run.

## 1. What it reads

A book whose only copy is the EPUB: Vellum, Atticus, Reedsy, Scrivener, Calibre and Ulysses exports. The reader takes the `.epub`
bytes (a zip) and gives back the blocks, the navigation's chapter titles, the matter the book itself marks, the cover and the
pictures, and what it could not keep.

## 2. The package document

- `META-INF/container.xml` names the OPF (`rootfile/@full-path`). Without it the file is not an EPUB and is refused.
- The OPF gives `dc:title`, `dc:creator` and `dc:language` (the document's metadata), the `manifest` (id → href, media type,
  `properties`), the `spine` (reading order, `linear="no"` marked) and the EPUB 2 `<guide>`.
- Every href is resolved against the folder of the file that wrote it, with `.`/`..` collapsed and percent escapes decoded, so a
  spine item is an archive path.
- The cover is the manifest item with `properties="cover-image"`, else `<meta name="cover" content="id">` (EPUB 2). The navigation
  document is the item with `properties="nav"`, else the spine's `toc` attribute names the NCX.
- `rendition:layout: pre-paginated` is a fixed layout: it is not kept, the text is reflowed, and the losses say so.

## 3. The navigation

- **EPUB 3**: the nav document's `<nav epub:type="toc">` (or `role="doc-toc"`), its nested `<ol>` giving each entry's depth.
- **EPUB 2**: the NCX `navMap`, `navPoint` → `navLabel/text` and `content/@src`.
- An entry's fragment (`chapter.xhtml#part-2`) addresses an element id. The walker's `anchors` resolve it to a block, and one XHTML
  file holding several chapters is cut there: each cut is a chapter of its own, its unit `<href>#<fragment>`.
- The nav's titles are the book's own chapter titles. They reach the preview as a table keyed by unit; the preview names the
  proposed chapters with them, so a file called `ch00012.xhtml` never becomes a chapter title.
- **Landmarks** (`<nav epub:type="landmarks">`, else the EPUB 2 guide) mark the cover, title page, contents, copyright page,
  dedication, foreword and preface as front matter, and the acknowledgements, about-the-author, colophon, index, glossary and
  bibliography as back matter. A `linear="no"` spine item is matter too: front before the first linear item, back after it. Matter
  is offered as Research, never dropped silently.

## 4. The text

Each spine item is read by the shared XHTML walker with its own `sourceUnit` and picture-ref namespace. Headings, `<hr>` and symbol
paragraphs are the splitter's scene signals; emphasis, lists, blockquotes and code become Markdown; a table degrades to prose with a
loss. Footnotes are the walker's: an `epub:type="noteref"` link becomes `[^n]` in the text and its `epub:type="footnote"` aside is
written as the definition of the scene that holds the reference (decision 3). Labels are numbered across the whole book, so two
spine items that both use `fn1` keep two distinct notes. A note no reference points at follows its own block, and the splitter keeps
it under "Unreferenced notes".

## 5. Pictures

The cover and every picture a page names are kept: a relative path is read from the zip beside the page, a `data:` URI is decoded.
A remote http(s) picture is listed as not downloaded unless the writer turns it on (decision 10). The cover comes in as a picture;
setting it as the project's cover (`project.coverAssetId`) is **not** part of this import.

## 6. DRM

`META-INF/rights.xml`, or `META-INF/encryption.xml` that encrypts anything but a font, refuses the book with a clear message before
any of it is parsed. The two font-obfuscation algorithms (`http://www.idpf.org/2008/embedding`, `http://ns.adobe.com/pdf/enc#RC`)
hide a font, not the text, and are read normally. An encryption file that is not well-formed is refused as DRM: Caotang does not
break DRM and does not promise to read a book it cannot.

## 7. Safety and limits

The zip is opened by `@caotang/import-read/zip` (`unzipSync` inside our own `'self'` Worker) with its size, entry-count and ratio
caps. The parse runs in the preview's reader host with a timeout and the dialog's Cancel. No script, style, iframe, form control or
audio/video player is kept or run; each is counted. Every imported text goes through `scanImport` in the preview, which lists the
hits. Nothing is written before **Import**, which commits one `binder.importTree` that one Undo takes back. The reader is a lazy
chunk loaded on first use; there is no `eval`, `new Function` or WebAssembly anywhere in the chain.

## 8. What is lost

CSS and the fixed layout, audio and video, scripts, styles, iframes and form controls; tables degrade to prose; remote pictures are
listed, not fetched. The preview's report names each with its count, so nothing is dropped silently.

## 9. What is not built

- The cover as the project's cover (`project.coverAssetId`): it is imported as a picture.
- Fixed-layout page geometry, media overlays (read-along audio) and MathML: the text is kept, the layout and the media are not.
- An EPUB whose spine items are encrypted (DRM): refused, by decision.
