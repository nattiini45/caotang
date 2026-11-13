# import-novelcrafter — the NovelCrafter manuscript and codex reader

Status: specified (import epic #263, issue #292). The Markdown reader (#280), the splitter (`import-core`) and the preview dialog
(#273) are shared; the codex batch (`codex.importBatch`) commits the entries. The DOCX manuscript variant needs the DOCX reader (#279).

## 1. What it reads

NovelCrafter is an AI-assisted fiction studio. It exports the manuscript as Markdown (or DOCX) and the codex as a zip: one folder per
entry under a type folder (`characters/`, `locations/`, `objects/`, `lore/`…), each holding `entry.md`, `metadata.json` and `notes.md`,
with a thumbnail when the entry has one. This reader is an adapter over the Markdown reader: the manuscript is Markdown, and each
codex entry's `entry.md` is Markdown with front matter. No DOM, no third-party dependencies, so it runs on the main thread, in a
`'self'` Worker and in Node.

A NovelCrafter export zip may hold the codex alone, or the codex and the manuscript together. The reader reads both when both are
there: the codex folders become codex entries, and every Markdown file outside a codex folder becomes the manuscript.

## 2. The manuscript

The manuscript is read by the Markdown reader (`@caotang/import-markdown`) and split by the shared splitter: the heading ladder
(acts optional → chapters → scene titles optional) and the `* * *` scene separators become the chapter and scene structure. A scene's
front-matter `synopsis`/`summary`/`description` becomes its synopsis, and every other front-matter key is kept in notes. The
manuscript's pictures resolve from the export when their bytes are there.

The DOCX manuscript variant is not in this build; it needs the DOCX reader (#279). A writer with a DOCX manuscript exports it as
Markdown from NovelCrafter, or imports the codex here and the manuscript later.

## 3. The codex

Each folder holding an `entry.md` is one codex entry. Its type comes from the type folder above it (`characters/` → character,
`locations/` → location, `objects/`/`items/` → object, `lore/` → lore, `subplots/` → subplot), else a `type:`/`category:` in
`metadata.json` or the front matter, else `other`. The preview lists the entries as rows to confirm or fix (decision 6).

- `entry.md` front matter: `name`/`title` names the entry (else the folder name); `aliases` are kept on the entry; `tags` become
  keywords. Every other front-matter key is a custom field, kept verbatim in the entry's research text (the codex field target, #221).
- `entry.md` body is the entry's description: a short lead becomes the codex description, and the full text goes into the entry's
  research page.
- `metadata.json` relations are kept and rendered as a **Connections** list in the research page (the codex relation target, #223);
  they are listed, not dropped. A `progressions` array is counted and reported as staying in NovelCrafter.
- `notes.md` becomes the entry's research notes, appended to the research page.
- A thumbnail (an image in the entry folder, or one `metadata.json` names) is imported as the entry's picture when present.

The research page carries the description, Connections, notes and custom fields, so nothing is dropped silently. The entry cites its
own research page when the manuscript does not name it, so a codex-only export still commits its entries.

## 4. What is lost

NovelCrafter's progressions, chats, snippets and prompts are not part of the export; the report lists them as staying in NovelCrafter.
The DOCX manuscript variant waits for #279. Nothing else is dropped silently: every unmapped front-matter key, relation and note is
kept in the research text and counted.

## 5. Safety and limits

The zip is opened by `@caotang/import-read/zip` (`unzipSync` inside our own `'self'` Worker) with its size and entry-count caps and its
zip-bomb ratio guard; the read has a timeout and a cancel through the preview's reader host. No script runs, no network fetch is made,
and every imported text (bodies, synopses, notes, codex descriptions) goes through `scanImport` in the preview, which lists the hits.
The reader is a lazy chunk loaded on first use; it never lands in the entry chunk.

## 6. The commit

Nothing is written before the shared preview shows the proposed tree, the codex rows, the counts and the losses report. **Import**
commits one `binder.importTree` (the manuscript and its pictures) plus the codex batch in the same undo group; one Undo removes
everything the import created, pictures included.
