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

- `h1`–`h6` become heading blocks at their level; `<hr>` becomes a scene break. A heading's `text` is the plain title the splitter
  names a chapter or scene with, while its `md` keeps the emphasis: `<h1>Chapter <em>One</em></h1>` is the title `Chapter One`.
- Paragraphs, list items (`- ` / `1. `), blockquotes (`> `) and code blocks become Markdown paragraphs. A code block's fence is
  longer than any run of backticks inside it, so the code cannot close its own fence. Emphasis (`<strong>`/`<b>`,
  `<em>`/`<i>`) and inline code render as Markdown. **Literal prose stays literal**: a text node's `\`, backtick, `*`, `_`, `[`, `]`
  and `<` are escaped, and a paragraph that would begin with `#`, `>`, `-`, `+` or a list number has that marker escaped, so
  `Use *literal* syntax` and `[link](https://example.test)` are the writer's words and not markup. Each block carries the unescaped
  words as its `text` beside the Markdown.
- A table degrades to prose with a loss: a space between cells and a line between rows, so two names never run into one word. A
  dropped element inside a table or a `<pre>` contributes no text at all.
- Centred text is a signal: `text-align` from the inline style and from the resolved `<style>` class rules; `font-weight: bold` over
  a whole paragraph is `allBold`; `page-break-before` / `break-before: page` is `pageBreakBefore`. A wrapper carries its own signals
  down to the blocks inside it, a descendant's own style winning over the inherited one; a wrapper's page break belongs to the first
  block it produces, not to every block under it. The class rules are read by a forward scan rather than a scanning regex, so a page
  of unclosed `<style>` tags or of dots with no brace cannot make the read quadratic.
- `<script>`, `<style>`, `<iframe>`, `<noscript>`, `<template>`, the `<head>`, form controls and `<audio>`/`<video>` players are dropped
  and counted; event attributes (`on…`) are counted. Nothing dropped is ever executed. **Scripts, iframes and event attributes are counted once over the
  whole document**, the head and the inside of dropped elements included, so a page's own `<script>` in its head is reported.
- **Stylesheets are counted over the whole document**, head included: every `<style>` element and every `<link rel="stylesheet">`.
  The body walk never reaches the head, so counting only what it drops would report nothing for the usual export. The report says the
  stylesheet was dropped and that only alignment, bold and page breaks are kept, since those are the signals `classStyles` reads.
- Links pass the safe-href rule (http(s), mailto, or a relative target); a `javascript:` or other scheme keeps its text and is counted.
  The destination is written percent-encoded wherever it carries `\`, `(`, `)`, `<`, `>`, a quote, a bracket or whitespace, so an href
  cannot close its own link and have the rest read as new markup the safe-href rule never saw.
- Images: a `data:` URI is decoded and a relative path resolved from the zip; both become picture refs. A relative path reaches the
  page's own folder first and then the archive root, with `./` and `../` climbing (a path that would leave the archive is refused).
  A picture the file names but the import cannot read — a target the archive does not carry, or any relative target in a lone page,
  which has no archive to resolve against — **keeps its alt text** in the block or the sentence that named it and is counted as one
  `image-unreadable` loss naming up to twenty targets and the count of the rest. A ref with no bytes behind it is never written into
  the writer's manuscript.
- **Only bytes the store will take are offered as a picture.** The commit runs the picture pipeline strictly over the whole batch
  (`pictures.md` §6.4), so one refused picture would refuse the entire import. Before a `data:` URI or an archive entry becomes an
  asset it must be a PNG, JPEG or WebP of at most 16 MB and 50 megapixels, the size read from its header exactly as the pipeline reads
  it; a size the header does not state is not held against it. Everything else — a GIF, an SVG, an oversized photo — takes the same
  path as an unreadable target: its alt text stays and a loss names it, saying whether the format or the size was the reason. An
  embedded `data:` picture is named as "an embedded picture", never as its URI. A remote image — any scheme but `data:`, and a
  protocol-relative `//host/path` — is **listed and never downloaded**: this source offers no network option, so the import makes no
  request at all. Decision 10's opt-in is the preview's seam (`PreviewOption.network`); wiring a download for HTML is not built.

`htmlToBlocks(html, options?)` takes the page's `unit` (written as every block's `sourceUnit`) and its `refPrefix`, the namespace of
its picture refs (`import:html-image-` by default). A reader of several pages gives each its own prefix, so two pages' pictures never
share a ref.

Besides the blocks it returns three tables a reader of a structured book needs (the EPUB import, [import-epub.md](import-epub.md)):

- `anchors`: every element `id` to the first block it produced, a wrapper's id included, so a navigation entry's fragment can be
  resolved to a block.
- `noterefs`: an `<a epub:type="noteref" href="#fn">` (or `role="doc-noteref"`) is written as `[^n]` in the text, numbered in reading
  order, and returned with its fragment and block.
- `notes`: an `<aside epub:type="footnote" id="fn">` (or `role="doc-footnote"`) is kept out of the text and returned as its Markdown,
  so the reader can write it as the footnote definition of the scene that holds its reference (decision 3).

## 3. The reader

**The size is checked before the file is read into memory.** `htmlSizeRefusal(fileName, size, maxBytes)` answers with a sentence
naming the file and the cap, and **Import HTML…** calls it with `file.size` before `arrayBuffer`: the text reader's cap for a page,
the archive's for a zip. A pick past the cap is refused at once rather than allocating the whole file on its way to the reader's own
check.

`readHtmlFile` reads one page; `readHtmlZip` / `readHtmlArchive` read a Google Docs web-page zip (one `.html` plus its images), each
page a `sourceUnit` with its own picture refs (`import:html-image-<page>-<n>`). Footnote references and definitions the walker
extracts reach the document's `footnotes` table; in an archive their labels are numbered across every page, so two pages that both
use `fn1` keep two distinct notes. The title is the page's `<title>`, else the file name. The zip is opened by
`@caotang/import-read/zip` (`unzipSync` inside our own `'self'` Worker) with its size and entry-count caps and its zip-bomb guard.

## 4. Safety and limits

No script runs, no network fetch is made, and every imported text goes through `scanImport` in the preview, which lists the hits.
The parse runs off the main thread with a timeout and a cancel through the preview's reader host. The reader is a lazy chunk loaded
on first use; it never lands in the entry chunk. There is no `eval`, `new Function` or WebAssembly anywhere in the chain.

## 5. What is lost

Scripts, styles, iframes, form controls and audio/video players are dropped and counted; unsafe link schemes keep their text; tables degrade to prose;
remote images are listed, not fetched; a picture the store would refuse keeps its alt text and is named with its reason. The losses
report names each, so nothing is dropped silently.
