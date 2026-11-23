# Import: Plottr outline (#290)

Status: **built**. Adapter `@caotang/import-plottr`; the preview is [import-preview.md](import-preview.md), the codex write is
[codex.md](codex.md) §7.1. A `.pltr` is **plain JSON** — no archive, no markup — so the reader needs nothing but `JSON.parse` and the
shared text cap ([import-read.md](import-read.md)).

## 1. What it reads

A **Plottr project file** (`.pltr`), verified on a real 698 kB file written by Plottr 2023.7:

| Top-level key | What it is |
|---|---|
| `file`, `series`, `ui`, `featureFlags` | file version and series metadata (name, premise) |
| `books` | `{ <bookId>: { id, title }, allIds: […] }` — more than one means a series file |
| `beats` | per book: `{ children: { <parentId>: [childIds], "null": [topIds] }, index: { <id>: { id, bookId, position, title } } }`; older files use a flat array with a `children` list per beat |
| `cards` | the scene cards: `{ id, beatId, lineId, position, positionWithinLine, title, description, tags, characters, places }` — `description` is a **Slate** document |
| `lines` | plotlines: `{ id, bookId, title }`; a `bookId` of `"series"` sits above the books |
| `characters`, `places` | worldbuilding entries: `name`, `description` (a tagline), `notes` (Slate), `tags`, `categoryId`, `imageId`, `bookIds`, and one own key per **custom attribute** |
| `customAttributes`, `attributes` | the attribute definitions; the values are the entity's extra keys |
| `categories` | `{ characters: [{ id, name }], places: […] }` — entry groups |
| `notes` | free notes: `title`, `content` (Slate), `tags`, `bookIds`, `imageId` |
| `tags` | `{ id, title }` |
| `images` | `{ <id>: { name, path, data } }` — `data` is a `data:` URL; Plottr labels PNGs as JPEG, so the bytes are **sniffed** |

**Not a Plottr file.** A JSON document with no `file` record and no `beats` map is refused with a plain message, as is malformed
JSON and a file past the text cap. A file with no books is empty. Keys a newer Plottr writes are tolerated and named in the
losses report.

## 2. Books and the beat tree

A book's beats become **folders**: the `children`/`index` maps are walked from the `null` bucket, each beat's child beats become
child folders and its cards become **scenes** in `position` order (stacked cards — the same position on different lines — follow
`positionWithinLine`). A card whose beat is not in the chosen book's tree lands in a folder named **Unsorted**.

A **series file** (more than one book) offers the book as a **chip** in the preview; re-reading keeps the same file. Series-level
lines, beats and plotlines sit above the books and are named in a notice, not imported.

## 3. Scenes, codex and research

- **Card → scene.** The title is the scene title; the Slate description is walked to Markdown and kept as the **synopsis** (at
  most 2,000 characters — longer text continues in the scene's body). The card's **tags** and its **plotline** become keywords
  (`Plotline: <title>` — the import model has no typed threads). The characters and places the card names go into the scene's
  notes; the entries themselves are codex rows, attached where their name appears.
- **Character / place → codex row.** `description` is the entry's description; its category and tags become keywords. The full
  Slate notes and every custom attribute go on a Research page named `<name>: Details`, marked `preferPage` so the page is always
  created. A character's own image is kept **inside** the page text.
- **Note → Research document** with its tags as keywords and its image in the body.
- **Pictures.** `data:` images are decoded locally and their type sniffed; nothing is fetched. They ride the shared pictures
  option (`Import # pictures`), and they are part of the one undo step.

## 4. Lost or approximated

Colours, UI state, templates and Plottr's own ids are dropped; Plottr stores no prose and no dates — the order carries the
story. Plotlines land as keywords, not typed threads; custom attributes as page text, not fields. The losses report names the
dropped kinds, the series-level plotlines and any unknown keys.

## 5. The reader

`readPlottr(bytes, { bookId?, labels? })` in `packages/import-plottr` is a pure function: it runs on the main thread, in the
preview's `'self'` Worker and in Node. It decodes UTF-8 inside the shared 32 MB text cap and returns folders, scenes, codex rows,
research pages, decoded pictures and losses — no side effects, no network. The Slate walker (`slateToMarkdown`) renders
paragraphs, headings, lists, marks and safe links, and keeps the text of an unsafe link without the target.
