# import-textbundle — the TextBundle and TextPack reader

Status: built (#282, epic #263); reader, Worker, preview and UI. Package `@caotang/import-textbundle`.

TextBundle (a `.textbundle` folder) and TextPack (its zip) are the open interchange of the Apple writing apps: Markdown plus `assets/`
plus `info.json`. This reader is a **thin layer over the Markdown reader** ([import-markdown.md](import-markdown.md), #280): it finds the
bundle's text and info, names the app, applies that app's comments, tags and Content Blocks, and hands the body to the Markdown reader.
Like the other readers it has **no DOM and no third-party dependencies**, so it runs on the main thread, in a `'self'` Worker and in Node.

## 1. Inputs and outputs

- `readTextBundle(archive)` reads a TextBundle folder, a TextPack zip, a Ulysses group export or a Bear `.bear2bk` backup opened by
  `@caotang/import-read/zip`. It returns `{ ok: true, value }` or `{ ok: false, error }`; nothing throws for anything about the input.
- The value is a `TextBundleImport`: the Markdown reader's `ImportDocument`, per-file front-matter facts, title, resolved picture bytes,
  the detected `app`, `notices` naming what was mapped or kept out, `bundles` (one `TextBundleNote` per bundle, in import order, with its
  title, tags, unit and dates) and `container` (`single`, `bear-backup` or `group`).
- **One bundle is one document**, unchanged: its unit is its text file's name and no heading is added. **Many bundles are one document
  with a chapter per note**: each note gets an `# <title>` heading, its unit is its own `text.md` path, and its picture tokens are
  namespaced so two notes' pictures keep their own bytes. A Bear backup reads oldest first by `creationDate`; every other container keeps
  its folder order, numbers natural (`2` before `10`).
- Errors: `no-text` (no `text.md`/`.markdown`/`.mdown`/`.mkd`), `fountain` (a `text.fountain` bundle routes to the screenplay importer),
  `ask-encoding`, `too-large`, `too-many-lines`, `archive`.

## 2. App detection and mappings

`info.json`'s `creatorIdentifier` names the app; without it the bundle is `generic`. In a container the first app named wins.

- **Ulysses** — `%%` comments (a whole line or inline, to the line's end) and `++inline++` comments become notes, never dropped. Material
  sheets are excluded by Ulysses itself, so an export holds only the sheets the writer chose.
- **Bear** — `#tag`, `#nested/tag` and closed `#multi word tag#` become keywords **in the order the note wrote them**; a leading `# H1`
  equal to the title is stripped. A `.bear2bk` backup is a zip of TextBundles; `bundleDates` reads `creationDate`/`modificationDate` from
  `info.json` or from Bear's own `net.shinyfrog.bear` dictionary. The project has no date field, so the preview keeps them as a note line
  (`Created …` · `Modified …`) and the report says so.
- **iA Writer** — the trailing Authorship block (`---` … `...`) is kept out of the body and reported; `[%key]` variables stay as text.
  **Content Blocks** (`src/ia.ts`): a line holding only a path rooted at `/` stands for that file, in the order the index lists them.
  `/Chapter 1.md` takes the file's text in (recursively, depth 8, a cycle kept out and reported); `/images/x.png "caption"` becomes
  `![caption](images/x.png)` so the bundle resolves its bytes; `/data.csv` (or `.tsv`) becomes one paragraph per row, its cells joined with
  a comma and a space, reported as an approximation because the columns are not kept. A path no file carries, and a file the import does
  not read (a `.pdf`), keep their line as text and are named in the report. A fenced code block is never read for blocks. The archive's
  text files are read only when a body actually names one.

## 3. Pictures and the keep-everything rule

Each picture resolves against its own bundle's folder and `assets/` first, then anywhere in the container; a remote target is left alone
(the download opt-in is the preview's). Footnotes stay as `[^n]` (decision 3). Comments go to notes, never dropped. The commit is the
shared preview's one `binder.importTree`, so one Undo takes all of it back, pictures included.

## 4. The preview

`apps/desktop/src/import-preview/textbundle-source.ts` shows the container through the shared splitter source. Two choices belong to the
writer, not the reader:

- **Bear tags** — a chip offered when a Bear container has tags: `Keywords on each note` (the default) or `A folder per tag`. With folders,
  the notes are grouped under a folder per tag segment (`#harbour/night` nests), the first tag placing the note and every tag staying on it
  as a keyword; an untagged note stays at the top. A tag folder spans the blocks of the notes it holds. This is a plan choice, so it does
  not re-read.
- **Where it goes** — a Bear backup is a note app's archive, so its top-level nodes carry `place: 'research'` and the import lands in
  Research; sorting it by tag into folders sends it to the manuscript instead. Every other container goes where the writer's **Into**
  choice says.

The report names each mapping and each approximation: Ulysses comments, Bear tags, Bear dates, Content Blocks taken in, CSV as paragraphs,
and every block line that stayed as text.
