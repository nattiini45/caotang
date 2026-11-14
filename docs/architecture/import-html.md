# import-html — the HTML page and Google Docs web-page reader

Status: built (#299, epic #263): walker, reader, Worker, preview, UI, guides and e2e. Package `@caotang/import-html`. The walker is
shared by the EPUB (#296), AO3 (#297), Kanka (#293) and Notion imports.

## 1. What it reads

A saved HTML page, a Google Docs "Web page (.html, zipped)" export, and the HTML exports of Ulysses, Bear and iA Writer. The reader
is an **own XHTML walker** over the shared XML reader (`@caotang/import-read/xml`): no DOM, no third-party dependency, so it runs on
the main thread, in a `'self'` Worker and in Node. It reads well-formed XHTML; a lenient export is made readable by self-closing the
HTML void elements and decoding the HTML named entities the XML reader does not know. Markup that is not well-formed XML is refused
with the parser's reason, never guessed at.

## 2. The walker

The walker turns the page into the import block list (`import-core`) with the signals the splitter uses:

- `h1`–`h6` become heading blocks at their level; `<hr>` becomes a scene break.
- Paragraphs, list items (`- ` / `1. `), blockquotes (`> `) and code blocks become Markdown paragraphs. Emphasis (`<strong>`/`<b>`,
  `<em>`/`<i>`) and inline code render as Markdown; a table degrades to prose with a loss.
- Centred text is a signal: `text-align` from the inline style and from the resolved `<style>` class rules; `font-weight: bold` over
  a whole paragraph is `allBold`; `page-break-before` / `break-before: page` is `pageBreakBefore`.
- `<script>`, `<style>`, `<iframe>`, `<noscript>`, `<template>`, the `<head>` and form controls are dropped and counted; event
  attributes (`on…`) are counted. Nothing dropped is ever executed.
- Links pass the safe-href rule (http(s), mailto, or a relative target); a `javascript:` or other scheme keeps its text and is counted.
- Images: a `data:` URI is decoded and a relative path resolved from the zip; both become picture refs. A remote http(s) image is
  listed as not downloaded unless the writer opts in (decision 10).

## 3. The reader

`readHtmlFile` reads one page; `readHtmlZip` / `readHtmlArchive` read a Google Docs web-page zip (one `.html` plus its images), each
page a `sourceUnit`. The title is the page's `<title>`, else the file name. The zip is opened by `@caotang/import-read/zip`
(`unzipSync` inside our own `'self'` Worker) with its size and entry-count caps and its zip-bomb guard.

## 4. Safety and limits

No script runs, no network fetch is made, and every imported text goes through `scanImport` in the preview, which lists the hits.
The parse runs off the main thread with a timeout and a cancel through the preview's reader host. The reader is a lazy chunk loaded
on first use; it never lands in the entry chunk. There is no `eval`, `new Function` or WebAssembly anywhere in the chain.

## 5. What is lost

Scripts, styles, iframes and form controls are dropped and counted; unsafe link schemes keep their text; tables degrade to prose;
remote images are listed, not fetched. The losses report names each, so nothing is dropped silently.
