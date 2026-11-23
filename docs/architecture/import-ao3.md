# Import: AO3 (Archive of Our Own)

> Status: **built** (#297, epic #263). The package `packages/import-ao3` (`@caotang/import-ao3`) reads an AO3 work download —
> HTML or EPUB — into the import block list and the work's own metadata, over the shared XHTML walker
> ([import-html.md](import-html.md)) and the shared EPUB reader ([import-epub.md](import-epub.md)). The desktop's **Import AO3…**
> opens it in the shared preview ([import-preview.md](import-preview.md)). No DOM, no third-party dependency, no script ever run.

## 1. What it reads

AO3 offers an HTML and an EPUB download of every work. Both carry the same preface beside the prose: the tag list, the title and
byline, a summary, notes above chapter one, notes on each chapter, and end notes. This adapter keeps the prose as the manuscript and
the preface as metadata, so a work imported from either download has the same structure and the same facts.

A page that carries none of AO3's structure (`#workskin`, the `dl.work.meta` tag list) is refused as **not an AO3 download** rather
than imported as a page of tags.

## 2. The preface

Read from AO3's own classes, which are stable:

| AO3 | Caotang |
|---|---|
| `dd.rating`, `dd.warning`, `dd.category`, `dd.fandom`, `dd.relationship`, `dd.character`, `dd.freeform` | keywords, in AO3's order, deduplicated |
| `dd.character` | codex rows of type `character`, offered for confirmation (decision 6) |
| `.summary` in the work's preface | the import's synopsis |
| `.notes` in the work's preface | notes on the first node |
| `.chapter .notes` / `.chapter .summary` | notes / synopsis on that chapter |
| `#work_endnotes` | notes on the last node |
| `dd.series`, `dd.language`, `dd.stats` (published, updated, words, chapters) | one note, so nothing the download carried is lost |
| `h2.title`, `h3.byline` | the work's title and author |

Keywords past what a scene holds (32) are listed in the report rather than dropped.

## 3. The text

The prose is read by the shared walker with `skip: AO3_SKIP` — `#work_endnotes`, `.meta`, `.summary`, `.notes`, `.byline` — so the
preface is not imported twice: the walker returns each skipped region with the block index it sat before, and this adapter matches
it to the preface it parsed. The work's `h2.title` and each chapter's `h3.title` stay in the text, where the splitter reads them: the
title becomes the book title and the chapter headings become chapters. A chapter heading's own link to the site (`[Chapter 1](#)`)
is dropped, its text kept, because the anchor points nowhere in a download.

For the EPUB download the chapters and their titles come from the book's navigation ([import-epub.md](import-epub.md) §3); the page
holding the preface is left out of the chapter list. `<hr>` and symbol lines split scenes in both.

## 4. Pictures, safety and limits

A `data:` picture is decoded and an in-zip picture resolved by the EPUB reader; a remote http(s) picture is listed as not downloaded —
this import has no download switch and makes no request at all. Scripts, styles, iframes and audio/video players are removed and counted, never run.
The zip is opened with the shared caps and zip-bomb guard, the parse runs in the preview's `'self'` Worker with a timeout and the
dialog's Cancel, and every imported text — bodies, synopses, notes, codex descriptions and the contents' titles — goes through
`scanImport`, which lists the hits. Nothing is written before **Import**, which commits one `binder.importTree` that one Undo takes
back. The reader is a lazy chunk; there is no `eval`, `new Function` or WebAssembly anywhere in the chain.

## 5. What is not kept

The site's own navigation and links, the tag list as prose (it is metadata instead), the preface's formatting (its paragraphs are
kept as plain prose), CSS, and any script or player. The report names each. A work behind a login, or a page saved from the site
rather than downloaded, is not an AO3 download and is refused.

## 6. What is not built

- Fetching a work from its URL: Caotang makes no network request for an import. The writer downloads the file first.
- AO3's series and gift/exchange metadata beyond the series line, and the comments a work carries.
