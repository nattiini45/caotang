# Import preview — one dialog for every structured import, committed as one undo step

> Status: **partly built** (#267). Built: the shared preview dialog (`apps/desktop/src/import-preview/`), its source interface, its
> model (manual edits, the virtualised text pane, the mapping, the codex rows, the report, the commit), the commit command
> `binder.importTree` (bus `descriptors-import.ts`, store `commands-import.ts`), the Twee import moved onto it, the splitter source
> for the block list of #266 (`splitter-source.ts`, import-core.md §5.1), and **Import plain text…** and **Import RTF…** through it. Not built: the other format readers that
> feed it (#268 is the shared readers; each reader is its own issue), the Worker host the readers will run in, the **New project** destination, POV and day as mapping
> targets, and the Final Draft import's move onto the dialog (#265 extended its own dialog; moving it onto this one is a follow-up).
> Cross-refs: block list and splitter = Imports epic #263 (research notes `doc-formats.md` §10); commands = [command-bus.md](command-bus.md) §9
> (`binder.importTree`) · codex rows = [codex.md](codex.md) §7.1 · pictures = [pictures.md](pictures.md) D5 (inline spelling) and §6.4
> (the pipeline) · Twee = [dialogue-narrative.md](dialogue-narrative.md) §4 · the injection scan = issue #54.

## 1. What it is for

A Word file, a Scrivener project, a Markdown folder or a CSV of characters arrives as one long thing that has to become chapters,
scenes, notes and codex entries. The writer has to see that proposal and correct it before anything is written, and one Undo has
to take the whole import back. Every structured import shows the same dialog, after the Twee and Script import precedent: nothing
is written until **Import**; the import is one undo step; what the import cannot keep, and what reads like instructions to an AI,
is listed first.

## 2. Sources: readers plug in

The dialog never parses. A **source** (`ImportPreviewSource`, `model.ts`) has read its file (in a `'self'` Worker where the format
needs one) and answers one question as often as asked: *given these rule chips, these options and these manual splits, what is the
proposed tree?* A source gives:

| Part | What it is |
|---|---|
| `load(progress, signal)` | Reads the file once, with a progress line the dialog shows and the dialog's Cancel as the abort. Optional. |
| `chips()` | The rule chips, each a choice: chapters at (Heading n / style "X" / "Chapter N" lines / page breaks / none), scenes at, Parts nest or flatten, front matter to manuscript / Research / skip. The splitter source (`splitter-source.ts`) makes these from #266's `Detected`. |
| `options()` | Reader toggles: tracked changes, comments → notes, underline → italics, images, snapshots, codex auto-detect (decisions 5 and 6, on by default). An option with `network` (host, count, size) is a network step (decision 10): it starts **off** whatever the source says, and its label names the host, the count and the size. |
| `plan(settings, overrides)` | The proposed tree (`PreviewNode`: part, chapter, scene, text, front, back), the text pane's blocks, the ✂ markers with the reason for each, the counts, the losses (`LossWarning`s) and the sanity flags, a flag with a one-click fix as overrides. Pure and fast: it is run again on every chip change. |
| `fields()`, `codexRows()`, `pictures()`, `metadata()` | What there is to map: front-matter keys or columns, codex rows (name, type, the passage that names it, a page of its own text), pictures (staged bytes behind an `import:` ref the bodies use). |
| `scanExtra()` | Text the reader kept out of the tree (RTF hidden text, deleted revisions, field codes, link targets) that the injection scan reads too; its hits are listed by what they are, with no node. |
| `report(plan)`, `importLabel(plan)`, `commit`, `readOnly` | For a source whose import is not a binder tree (the Twee import: one dialogue container, written with `dialogue.importInk`). |

## 3. Rules first, manual edits second

A chip change re-runs `plan`. The manual edits are kept apart from the rules, so the re-run can keep them: splits by block index
(`noSplit`, `sceneAt`, `chapterAt`, the shape of #266's `SplitOverrides`), and binder edits by node id (a new title, left out, a
sibling order). When the writer has made any, a rule change **asks first**: keep the edits with the new rule, discard them, or keep
the old rule. Import waits while it asks.

- **Text pane.** Each ✂ marker says why it splits ("Heading 1", "scene break "* * *"", "your split") and has `×`, which removes the
  split (a manual split is taken back; a rule's split is overridden, and the source writes the break into the scene as `***`).
  Between two blocks, hover or focus shows **+ split here** and **+ chapter here**. Clicking a block selects its node in the binder.
- **Binder pane.** A `tree` with one row per node (`aria-level`, `aria-setsize`, `aria-posinset`), roving focus, and the keys:
  arrows move, Right and Left open and close a folder, F2 renames (Enter commits, Escape cancels, an input method's Enter is its
  own), Space leaves a node out (its checkbox does the same), Alt+Up and Alt+Down reorder among siblings, Ctrl+M (Cmd+M) merges a
  chapter or part with the next one. Selecting a row scrolls the text to it.
- **Virtualised.** The text pane renders only the blocks in view and a few either side, between two spacers whose heights are the
  blocks' measured heights (estimated until measured), found by binary search over prefix sums: a 200,000-word book keeps a few
  dozen blocks in the DOM.
- **Counts.** "Detected: 84,212 words · 24 chapters · 71 scenes · 3 images · 12 comments · 9 footnotes · 4 codex rows" is a live
  region, so a re-split is announced. Tab reaches every control.

## 4. Mapping, codex rows and the report

- **Fields.** Each source field becomes synopsis, keywords, status, label, notes, or is ignored. A status or label value the project
  does not hold (by id or name) is listed with **Add it to the vocabulary**, **Use "…"** (a term the project holds), or **Ignore it**
  (the default). POV and day are not mapping targets yet: they are coherence scene metadata, a command of their own.
- **Codex rows.** Each row has its type and an answer: **Import**, **Skip**, **Rename** or **Import as page only**. A name that a
  codex entry or alias holds, or an earlier row of the same import, case-insensitively, starts as Skip and cannot be imported under
  that name; an import never merges into an entry (codex.md §7). An imported row cites the first imported document that holds its
  quote (its own node first); a row named nowhere in the text but with a page of its own cites that page; any other row is reported
  and not made.
- **Report.** The source's losses; the sanity flags, a fix as a button; the injection scan over every body and its notes
  (`scanImport`, issue #54), each passage named by the node it is in, a link that selects that node; and any lists the source adds.
  The text is imported as it is either way.

## 5. The commit: `binder.importTree`

**Import** builds one command (`buildCommit`) and the session dispatches it through `executeAsync`, its pictures staged as the shot
imports stage theirs. Its params: `parentId` (the manuscript, or a folder of the manuscript: folders are appended, never merged),
`nodes` (the tree in reading order, each naming its parent folder by index; a top-level node goes under `parentId`, or under
research with `place: 'research'`), `vocabulary` (the terms to add), `codex` (`codex.importBatch` entries, which may name an
imported document by index as `node`), and `pictures`.

- **What the preview decides before the command.** A node left out is not sent, nor anything under it, nor a picture only its text
  used (the status line says so). A scene or front matter at the top of an import into the manuscript gets a folder of its own name,
  because a document goes inside a chapter. Keywords, synopsis and notes are fitted to the binder's limits. Every body is checked
  through the store's own save and parse (`keepsImportedBody`); one that would not come back unchanged blocks Import and is named.
- **What the command checks** (whole batch, before anything is written; every failing node listed): the node shapes and limits, a
  parent that is an earlier folder, the chapter rule, the terms, the picture refs (`import:` tokens, each once) and staging ids, and
  the codex rows through `codex.importBatch`'s own validator against a projection in which a placeholder stands for each new
  document. The store's apply checks every body's round trip again before its first write.
- **What the apply does.** The pictures first (the only await): through the picture pipeline (dedup by hash, the GPS strip), each
  `](import:…` target becoming the picture's `../assets/` path (pictures.md D5), a codex citation in that body moved with it. Then,
  synchronously: the terms, the folders and documents, the codex pages and entries (`origin: 'import'`).
- **One undo.** One compensation takes back the codex entries, the pages, the nodes (last first), the terms and the picture records
  (the files stay, as every picture undo leaves them). Undo returns the manifest to its bytes and every body to what it was.
- **Who may run it.** The writer: `agentRisk: 'never'`. An agent imports one document at a time through `doc.import`. The command is
  registered only with the asset port (its apply awaits), as `asset.importBatch` is: a host without the port (Node, the MCP server)
  leaves it descriptor-only.
- The `imported` mark (decisions.md, issue #54) is set here when that mark is built.

## 6. Loading

The dialog, its model and its styles are a lazy chunk, loaded the first time an import opens a preview (`ImportPreviewHost`, mounted
in the workspace, through `openImportPreview`). The first load carries only the host and the request store. A reader's own code is
its own lazy chunk (#268).
