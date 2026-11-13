# import-markdown — the Markdown reader

Status: built (#280, epic #263). Package `@caotang/import-markdown`.

The Markdown reader turns a single `.md` file, a folder of chapters and scenes, or a zip of either, into the import block list
([import-core.md](import-core.md) §2) with its front matter mapped and its losses. Like the other readers it has **no DOM and no
third-party dependencies**, so it runs on the main thread, in a `'self'` Worker and in Node. Deciding where chapters and scenes start
is the shared splitter's job; this reader only emits blocks and the per-file front-matter facts.

## 1. Inputs and outputs

- `readMarkdownFile(bytes, fileName, { encoding? })` reads one file. `readMarkdownArchive(archive, { encoding? })` reads a folder or
  zip opened by `@caotang/import-read/zip`. Both return `{ ok: true, value }` or `{ ok: false, error }`; nothing throws for anything
  about the input.
- The value is a `MarkdownImport`: the `ImportDocument` (blocks, footnotes, losses, metadata, assets), a `frontMatter` record keyed by
  the blocks' `sourceUnit`, and a `title`.
- Errors: `ask-encoding` (the preview offers its encoding picker), `too-large`, `too-many-lines` (the plain-text reader's caps),
  `no-markdown` (an archive with no `.md`/`.markdown`/`.mdown`/`.mkd` file), `archive` (an entry could not be read).

## 2. Body dialect

The body is normalised to the Caotang dialect (CommonMark plus GFM strike and images, footnotes as inline `[^n]`):

- ATX headings (`#`…`######`) keep their level; an **empty heading** is left empty so the splitter reads it as a scene break.
- A **setext underline** (`===` level 1, `---` level 2) under a paragraph line is a heading, not a thematic break.
- Thematic breaks (`***`, `---`, `* * *`, `___`) become break blocks with their marker.
- **Tables degrade to prose** (cells joined by ` — `) with a `table` loss; **task lists degrade** to `[todo]`/`[done]` prose with a
  `formatting` loss. Nothing is dropped silently.
- Footnote definitions are collected into the side table; `[^n]` references stay inline. Fenced code blocks are kept whole.
- Every block carries `src.sourceUnit` = the file it came from, so a change of file is a boundary the splitter can use.

## 3. Front matter

A leading `---` (YAML) or `+++` (TOML) fence is split from the body; an opener with no closer is not front matter. YAML is read by the
store's own codec (`@caotang/store/frontmatter`, extended for imports — [project-format.md](project-format.md) §3); TOML by a small
reader for its common subset (`key = value`, strings, numbers, bools, arrays of scalars).

The mapping: `title`/`author`/`language` → metadata; `synopsis`|`summary`|`description` → synopsis; `tags`|`keywords` → keywords;
`status`, `label`, `pov` as written; `day`|`storyDay` → a numeric day offset; `prologue: true` / `epilogue: true` → the story part.
**Every other key is kept verbatim as a YAML block in `notes`** (the keep-everything rule), including nested lists and maps the codec
preserves as literal blocks.

## 4. Folder and zip structure

Each Markdown file is a scene (`sourceUnit`); the shared splitter turns a change of directory into a chapter boundary
(`chapters: { kind: 'unit' }` or heading rules, chosen by the preview). Files are read in **numeric-prefix natural order** (`2.md`
before `10.md`), residue (`__MACOSX/`, `._*`, `.DS_Store`) left out. The title is the first file's `title`, else the folder/file name
with its extension and leading number stripped.

## 5. Pictures

Relative image targets are registered as assets and, in an archive, resolved against the files nearest the referencing file's folder;
the asset keeps its byte count. Remote targets (`http:`, `https:`, protocol-relative) are **not fetched** — they are the preview's
opt-in (epic #263 decision 10). The preview rewrites kept references to `import:assets/…` and routes the bytes through the picture
pipeline.
