# import-textbundle — the TextBundle and TextPack reader

Status: built (#282, epic #263); reader, Worker, preview and UI. Package `@caotang/import-textbundle`.

TextBundle (a `.textbundle` folder) and TextPack (its zip) are the open interchange of the Apple writing apps: Markdown plus `assets/`
plus `info.json`. This reader is a **thin layer over the Markdown reader** ([import-markdown.md](import-markdown.md), #280): it finds the
bundle's text and info, names the app, applies that app's comments, tags and Content Blocks, and hands the body to the Markdown reader.
Like the other readers it has **no DOM and no third-party dependencies**, so it runs on the main thread, in a `'self'` Worker and in Node.

## 1. Inputs and outputs

- `readTextBundle(archive)` reads a TextBundle folder or TextPack zip opened by `@caotang/import-read/zip`. It returns
  `{ ok: true, value }` or `{ ok: false, error }`; nothing throws for anything about the input.
- The value is a `TextBundleImport`: the Markdown reader's `ImportDocument`, per-file front-matter facts, title, resolved picture bytes,
  the detected `app`, and `notices` naming what was mapped or kept out.
- Errors: `no-text` (no `text.md`/`.markdown`/`.mdown`/`.mkd`), `fountain` (a `text.fountain` bundle routes to the screenplay importer),
  `ask-encoding`, `too-large`, `too-many-lines`, `archive`.

## 2. App detection and mappings

`info.json`'s `creatorIdentifier` names the app; without it the bundle is `generic`.

- **Ulysses** — `%%` comments (a whole line or inline, to the line's end) and `++inline++` comments become notes, never dropped. Material
  sheets are excluded by Ulysses itself.
- **Bear** — `#tag`, `#nested/tag` and closed `#multi word tag#` become keywords; a leading `# H1` equal to the title is stripped. A
  `.bear2bk` backup is a zip of TextBundles with creation/modification dates.
- **iA Writer** — the trailing Authorship block (`---` … `...`) is kept out of the body and reported; `[%key]` variables stay as text.
  Content Blocks import in index order, images come in, CSV as paragraphs with a warning.

## 3. Pictures and the keep-everything rule

The bundle's `assets/` pictures are resolved against the archive through the Markdown reader's image tokens; footnotes stay as `[^n]`
(decision 3). Comments go to notes, never dropped. One bundle is one document; many bundles are a folder/zip import. The commit is the
shared preview's one `binder.importTree`, so one Undo takes all of it back, pictures included.
