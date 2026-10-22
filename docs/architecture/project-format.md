# Project format — on-disk artifact spec (v1)

> Status: built.
> This spec defines the **portable artifact** — what a Caotang project looks like as a folder of files. The *browser working store* is IndexedDB (§8), with one hard constraint: **lossless round-trip to this artifact is the acceptance test for any runtime store.**

## 1. Shape

One project = one directory:

```
<project-name>/
  caotang.json        # manifest: structural truth + project-local vocabulary + codex entries
  caotang.json.bak.N  # rolling manifest snapshots, N = 1..3 (§4)
  docs/               # one file per document node, FLAT, opaque-id filenames
    n_7K2QX9M4A1.md
    n_3W8RN2TQ6C.md
  codex/              # one redundancy file per codex entry (codex.md §3)
    c_5H8QK2M9RT.md
  exports/            # compile artifacts (disposable, gitignored)
  sessions.jsonl      # append-only writing-session stats (never rewritten)
  .gitignore          # exports/
```

Rules:

- **Flat `docs/`, opaque-id filenames** — the tree lives in `caotang.json`; document files are named `<id>.md` (or `<id>.fountain` and `<id>.ink` by kind, §3) where `id = "n_" + 10 chars of Crockford base32` (32^10 ≈ 10^15, collision-checked at generation). Rationale: novelWriter chose random hex handles deliberately so renames/reorgs never touch disk; folder-mirroring layouts (Manuskript-style) churn the directory on every reparent and litter sync histories. The cost — filenames are meaningless to humans — is paid for by `ToC.md` (§7).
- **No other files.** Loaders **ignore** unknown files (forward compatibility), never error. novelWriter's stricter "no extra files" rule is rejected: sync services and editors drop stray files into folders, and ignoring beats rejecting.
- **Single canonical layout.** Zip is a *deliverable* (§7), never a working mode — Manuskript's zip mode caused crashes and data loss (issue #741).

## 2. `caotang.json` — manifest schema v1

Pretty-printed JSON, 2-space indent, keys in the fixed order shown below (stable ordering so git diffs stay readable). One array element per line for the `tree` array (writers, formatters keep this).

```json
{
  "app": "caotang",
  "formatVersion": 1,
  "project": {
    "id": "p_9XK2M4Q7RZ",
    "name": "The Lighthouse Keeper",
    "createdAt": "2026-09-08T14:00:00.000Z",
    "modifiedAt": "2026-09-08T15:32:10.000Z"
  },
  "vocabulary": {
    "statuses": [
      { "id": "draft",  "name": "Draft",  "color": "#8a8a8a" },
      { "id": "revised", "name": "Revised", "color": "#4a90d9" },
      { "id": "final",  "name": "Final",  "color": "#3fa66a" }
    ],
    "labels": [
      { "id": "act-1", "name": "Act 1", "color": "#d9a44a" }
    ]
  },
  "tree": [
    { "id": "root",       "parentId": null,   "type": "root",     "title": "The Lighthouse Keeper", "order": 0,  "status": null, "label": null, "keywords": [], "synopsis": "", "notes": "" },
    { "id": "manuscript", "parentId": "root", "type": "folder",   "title": "Manuscript",            "order": 10, "status": null, "label": null, "keywords": [], "synopsis": "", "notes": "" },
    { "id": "research",   "parentId": "root", "type": "folder",   "title": "Research",              "order": 20, "status": null, "label": null, "keywords": [], "synopsis": "", "notes": "" },
    { "id": "n_7K2QX9M4A1", "parentId": "manuscript", "type": "folder", "title": "Chapter 1", "order": 10, "...": "..." },
    { "id": "n_3W8RN2TQ6C", "parentId": "n_7K2QX9M4A1", "type": "document", "title": "The Landing", "order": 10, "status": "draft", "label": "act-1", "keywords": ["sea", "grief"], "synopsis": "Elena returns to the island.", "notes": "Fix pacing in the last three paragraphs." }
  ],
  "derived": {
    "wordCounts": { "n_3W8RN2TQ6C": 2143 },
    "computedAt": "2026-09-08T15:32:10.000Z"
  },
  "codex": [
    { "id": "c_5H8QK2M9RT", "name": "Elena Voss", "aliases": ["Lena"], "type": "character", "description": "The lighthouse keeper's daughter; returns after nine years abroad.", "includePolicy": "detected", "caseSensitive": false, "exclude": [], "attachments": ["n_3W8RN2TQ6C"], "keywords": ["protagonist"], "origin": "manual", "sources": [], "createdAt": "2026-09-09T10:00:00.000Z", "updatedAt": "2026-09-09T10:00:00.000Z" }
  ]
}
```

> The `codex[]` array (data model, policies, detection, write path: [architecture/codex.md](codex.md)) is **additive in format v1** — no `formatVersion` bump (no wild artifacts exist before implementation; versioning starts at first release). Loaders tolerant of its absence; entries absent = empty codex. Codex provenance fields (`origin`, `sources` — codex.md §2) are additive the same way; loaders tolerate their absence (missing `origin` = `'manual'`).
> A top-level `coherence.json` file (findings/runs/sceneMeta — [architecture/coherence.md](coherence.md), post-v0.1 module) lands beside `caotang.json` **without any manifest change**: §1's "loaders ignore unknown files" rule makes it additive by construction. Findings are recomputable; dismissal state is the only accepted loss on corruption (coherence.md §3 recovery posture). A scene's `threads` (a handle, the document that pays it off, an optional note: coherence.md §5.5) is an additive field of its `sceneMeta` record: a file without it loads unchanged, and an empty list means none.
> **Additive arrays `filters[]` and `goals[]`:** saved binder queries ([architecture/binder-filters.md](binder-filters.md) — `SavedFilter`) and project completion goals ([architecture/goals-progress.md](goals-progress.md) — `ProjectGoal`) join `codex[]`/`recipes[]` as **additive in format v1** (same argument: no wild artifacts exist pre-implementation). Loaders tolerate absence; per-item tolerance rules live in the owning specs (unknown criteria keys dropped with the §6 unknown-field notice; malformed filter/goal objects dropped with a load warning — a broken saved query or goal never blocks a project load).
> **Additive tree-node fields (v0.2):** `tree[]` nodes gain `createdAt`/`updatedAt` (ISO-8601, app-maintained, non-editable in the first pass) for the v0.2 date-criteria package — [binder-filters.md](binder-filters.md) §2.1. Additive in format v1, loaders tolerate absence (absent = node never matches date criteria); content-touching mutations bump `updatedAt`, structure ops (`binder.move`) deliberately do not.
> **Media-track additivity (no formatVersion bump, same argument as `codex[]`/`coherence.json`):** (1) the tree-node `type` vocabulary widens with `shot` (storyboard) and `dialogue`/`beat`-class container kinds ([architecture/storyboard.md](storyboard.md) §2.1, [architecture/dialogue-narrative.md](dialogue-narrative.md) §2.1) — loaders tolerant of unknown types (kept in memory, rendered as inert nodes with an "unknown type" chip, never dropped: unknown-type nodes may carry irreplaceable content); (2) per-node `kind` field + per-kind metadata objects (`ShotMeta`, dialogue container metadata, `screenplay`/`branching`/`storyboard` kind markers) join as unknown-tolerant fields per §6; (3) an `assets/` directory (storyboard.md §2.2 — flat opaque-id image files) is additive by §1's ignore-unknown-files rule; (4) body files may carry `.fountain`/`.ink` extensions for non-prose document kinds (screenplay.md §2.1, dialogue-narrative.md §2.1) — the `docs/` flat layout is unchanged; (5) media exporter recipes are new entries in the exporter's closed recipe shape (exporter.md §3 note). No wild artifacts exist pre-implementation; v1 is defined to include the vocabulary.
> **Additive keys as built (still no formatVersion bump, the argument above).** `project` carries `language` (a BCP-47 tag, the source of EPUB's `dc:language`), `identifier` (`{uuid, isbn?}`: the EPUB unique identifier, `urn:uuid:` minted once at create and never regenerated, and an ISBN stored as `urn:isbn:` in ISBN-13 form, an ISBN-10 converted), `coverAssetId` (an `assets/` file id, or null) and `author` (the byline; absent or empty means none) — epub-metadata.md. An older project is given a `language` from the app locale and an `identifier` once, on open, and written back (a folder only when no MCP lock is present). A `tree[]` node carries `kind` (a marker: `screenplay` on a document, `storyboard` on a folder, `branching` on a dialogue container), `shot` (a shot's stored metadata, storyboard.md §2.2) and `dialogue` (a dialogue container's metadata: `speaker`, `locBaseline`, `engineTarget`, `autoLineIds`, dialogue-narrative.md §2.1). The top-level `recipes[]` (exporter.md §2) joins `filters[]` and `goals[]`. Loaders tolerate the absence of every one of these, and an unknown `kind` loads as a kept string. Recipes, filters and goals change only through their commands (command-bus §9: `recipe.save` and `recipe.delete`, `binder.saveFilter` and `binder.deleteFilter`, `project.saveGoal` and `project.deleteGoal`).

### Field contracts

| Field | Type / domain | Contract |
|---|---|---|
| `formatVersion` | integer ≥ 1 | Bump on any breaking change; see §6. |
| `project.id` | `"p_" + 10 base32` | Generated once, immutable. |
| `tree[].id` | `"n_" + 10 base32`, unique | Stable opaque handle; **never** derived from title. Reserved ids: `root`, `manuscript`, `research` (fixed roots, not deletable). |
| `tree[].parentId` | existing node id | Root's parent is `null`. Loader rejects unknown parents (or routes to recovery, §5). |
| `tree[].type` | `root \| folder \| document` | Exactly three tiers is the **UI** constraint (binder = manuscript → folder → document); the format tolerates folder-in-folder beyond that but v0.1 UI never creates it. `document` nodes have a file in `docs/`. |
| `tree[].order` | non-negative integer | Sibling ordering. **Gap-encoded**: created at `maxSiblingOrder + 10`; move = set one node's order. Renormalize (compact to 10,20,30…) only when a sibling exceeds order `1_000_000` or on manifest rewrite. Insert between two nodes with gap < 1 → renormalize that sibling set first. |
| `tree[].status` / `.label` | vocabulary id or `null` | Must exist in `vocabulary`. Unknown value on load → keep string, surface as "unknown status" chip, never drop data. |
| `tree[].keywords` | string[] | Free tags (Scrivener-style; niche but cheap). Max 32 per node, each ≤ 64 chars. |
| `tree[].synopsis` | string ≤ 2000 chars | Corkboard/inspector card text. |
| `tree[].notes` | string ≤ 50_000 chars | Inspector long-form notes. Plain Markdown, **not** in `docs/` for v0.1 (simplicity; file-split candidate in v0.2 if notes get long — assumption flagged). |
| `derived.wordCounts` | map id → int | **Derived, rebuildable, allowed stale.** Never a reason to reject a manifest; loader recomputes on open if absent. |
| `project.author` | string, optional | The byline on the title page and as the EPUB and DOCX creator. Absent or empty means none (epub-metadata.md). |
| `project.language` | BCP-47 tag, optional | The source of EPUB's `dc:language`. Absent on an old project until its first open, which writes the app locale. |
| `project.identifier` | object, optional: `uuid` (`urn:uuid:` and a UUID), `isbn` (`urn:isbn:` and thirteen digits, or null) | The EPUB unique identifier. Minted once and never regenerated; an ISBN-10 is stored in ISBN-13 form (epub-metadata.md). |
| `project.coverAssetId` | an `assets/` file id, or null | The cover image, which `project.importAsset` writes. |
| `tree[].kind` | string, optional | The media-track kind marker: `screenplay` on a document, `storyboard` on a folder, `branching` on a dialogue container. Unknown values load as kept strings (§2 note above). |
| `tree[].shot` | object, optional | A shot's stored metadata (storyboard.md §2.2). The store carries it unread; `@caotang/storyboard` owns its fields. |
| `tree[].dialogue` | object, optional | A dialogue container's metadata: `speaker`, `locBaseline`, `engineTarget`, `autoLineIds` (dialogue-narrative.md §2.1). |
| `tree[].style` | string, optional | The scene's export style (exporter.md §2, Per-scene styling): `normal` or `section`. Additive: absent is `normal`, and a project written before the field loads unchanged; no `formatVersion` bump. An unknown value loads as a kept string with a load notice, and the exporter renders it as `normal`. Changed only by `binder.setMeta`. |
| `recipes[]` | array, optional | Saved export recipes (exporter.md §2), changed only by `recipe.save` and `recipe.delete`. |
| — | — | **No secrets, ever.** Provider keys/URLs live in app-level settings, not in the artifact (projects get zipped, shared, committed). |

### Validation (load-time, in order)

1. Parse JSON → hard fail with "not a Caotang project" if `app !== "caotang"`.
2. `formatVersion` > current → **refuse with clear message** (forward-compat: never guess-upgrade); < current → run migrations (§6). A refusal at this step (an `app` that is not `caotang`, or a `formatVersion` above this build's) is not offered the §5 ladder, because a rebuild would write this build's format over a file another build wrote. The message names what the file is and says nothing was written.
3. Schema validation of every field per the table above. First violation reported with node id and field path (`tree[4].order: expected integer ≥ 0, got -1`).
4. Referential integrity: parent ids resolve; ids unique; document ids have files; **orphan body files (no tree entry) are imported as "Recovered" documents**, never deleted. The body files are `docs/<id>.md`, `.fountain` and `.ink` (§3). **Where they go:** a `Recovered` folder beneath the manuscript, created on demand, because the binder draws the manuscript and research and nothing else, so a folder under the root would hold documents nobody could see. A project that has a `Recovered` folder under the root loads with that folder moved under the manuscript, and nothing in it changes.

## 3. Document files

One body file per document-like node, named by the node's kind (the list below). Body = the manuscript text, the screenplay or the dialogue. **YAML front matter** (delimited `---`) carries node-local metadata as *redundancy insurance* — the manifest is structural truth, front matter keeps each file individually meaningful and enables recovery (§5).

**Body files by kind (`packages/store/src/paths.ts`):**

- **`docs/<id>.md`** is prose: a document with no kind, or a kind that is not a screenplay. It has the YAML front matter described below.
- **`docs/<id>.fountain`** is a screenplay document (`kind: 'screenplay'`). It is Fountain text with the same front matter as a prose file (screenplay.md §2.1).
- **`docs/<id>.ink`** is a dialogue container (`type: 'dialogue'`). It is **raw Ink with no front matter**, so the file is valid Ink on its own, and its node metadata lives in the manifest's `dialogue` object (dialogue-narrative.md §2.2).
- An **older `.md` file** of a node whose kind now has its own file still loads. The next save writes the kind's file.
- On import, a `.ink` file is taken whole and its node is marked `branching`. A `.fountain` file's front matter is read as a prose file's, and its node is marked `screenplay`. A body file that is not UTF-8 is held in the tree, and nothing rewrites it.
- **Removal:** a save removes only the body files of documents the session deleted, under any of these extensions. A save into a folder this session opened (the desktop's Save to folder, and the MCP server's save) names only those documents, so a file another writer put in the folder stays, and the check in §4 refuses a save over a document file another program changed, removed or added. A copy saved into a folder it was not taken from removes no body file. Only a write that passes no list at all removes every body file the manifest does not own (the whole-folder sweep of `writeProject`), which is the recovery's write back to a folder. **This one-file-per-node layout is load-bearing, not just portable: the editor engine's confirmed performance envelope requires it** (ProseMirror's bottleneck is visible DOM nodes, not words; editor-engine.md §12 mandates one editor instance per document node and rejects a single-manuscript doc).

```markdown
---
id: n_3W8RN2TQ6C
title: The Landing
status: draft
label: act-1
keywords: [sea, grief]
synopsis: >-
  Elena returns to the island after nine years.
---

The ferry was late, as always.

***
```

- **Front matter holds node-local facts only: `id`, `title`, `status`, `label`, `keywords`, `synopsis`.** It deliberately does **not** hold `parentId`/`order` — duplicating structure would force doc-file rewrites on every reorder/reparent (disk churn + git noise + sync conflicts), defeating the opaque-id design. Structure recovery is `.bak`-first (§5). Rejected alternative: full structure in front matter ("truth = files only") — write amplification on every drag.
- **No title heading in the body.** Compile inserts headings from node titles (Scrivener model: `chapter = folder, scene = document` — titles are structural). Keeps files paste-agnostic. There are no per-document heading overrides (§9 A2).
- **Scene separator inside a document = `***` (CommonMark thematic break)**, mapped at compile time to the configured separator. Rich-text ceiling cases (alignment, scoped endnotes) render in-editor and style at compile — never stored as non-Markdown.
- **Inline annotations** (comments, agent notes) are *not* v0.1 — deferred to the Markdown-superset decision, which depends on the editor engine and on syntax round-trip.
- Front matter is YAML parsed by `gray-matter`-class tooling; writer emits **stable key order, `>-` folded synopsis**, so diffs stay minimal.

## 4. Write path (atomicity & crash safety)

- **Browser working store (v0.1):** every mutation is one IndexedDB transaction (atomic by construction). Debounced autosave: flush ≥ 800 ms after last edit, plus flush on `visibilitychange`/`pagehide`/`beforeunload`. A flush that starts during teardown is not guaranteed to finish, so the typing not yet saved is also kept in `localStorage` (`caotang.pending.<projectId>`, the pending journal), synchronously on those three events and once per debounce window while the writer types; an entry leaves it when the store holds that body, and the next open of the project reads it before the editor mounts (editor-engine §9). The editor's undo journals are kept beside it in the app database `caotang-app` (version 2, object stores `editor-history` and its index `editor-history-meta`), never in the project store, a bundle or an export (editor-engine §7 rule 6). Every mutation bumps a per-document `revision` counter (used by agent tools for optimistic concurrency, see agent-harness.md §3). An undo is a mutation too: it writes the earlier body back and bumps the counter, so the counter never moves back (command-bus §5).
- **Artifact writes (export / backup / "save to folder"):** assemble the full folder in memory → write via temp name → atomic rename, or emit a zip Blob. This is the novelWriter temp-fsync-rename pattern; the torn-write class of autosave corruption cannot occur in the artifact.
- **Folder saves check the folder first.** A save into a folder another writer may share compares the folder with what its writer last loaded or saved: the `caotang.json` text, and a SHA-256 digest of every document body and every codex file (`codex/c_*.md`). The writer takes these digests when it opens the folder and after each save. A document or codex file that changed, was removed or was added since then refuses the save, and nothing is written until the writer says to replace it. A `caotang.json` that another program removed after the writer last loaded or saved it is the same question: the save is refused, and saving writes the manifest back from the writer's copy. Each file is checked against its digest again just before it is written or removed, so a change made during the save is refused at that file. The refusal names each document by its title and each codex entry by its name. Accepting a recovery (§5) makes the same check against the offer: the folder's `caotang.json` must still be the text the offer read, and each document and codex file must still hold the digest the offer took. Otherwise nothing is written, and the writer is told which files changed.
- **Ordering rule for a save.** Document and codex files are written before the manifest, so a crash between the two leaves an orphan file, which the next load recovers (§2 step 4), and never a manifest that names a file that is not there. A deleted document's body file is removed only after the manifest that stops naming it is written (§3, the removal rule). So a crash in that step also leaves an orphan, and the next load recovers it.
- **Changed-only rule for a save.** A save writes only the body and codex files whose text differs from the text the file already holds. A document or codex file that is unchanged is not written again, so a save never rewrites a file another program may have edited since the writer read it. The manifest is written on every save.
- **Rolling manifest snapshots (N=3):** before overwriting `caotang.json` in an artifact write, the previous manifest is rotated to `caotang.json.bak.1` (…bak.2, bak.3 shifting down; the oldest falls off). Only the manifest gets snapshots — docs are content files, every write of which is in the undo log already. *(Rationale: Obsidian's lesson is that recovery depth should be automatic and boring — File Recovery keeps 7 days of snapshots by default; append-only JSONL precedent truncates at last-known-good, so multiple generations give the loader a scan-back ladder instead of a single chance.)* The recovery ladder (§5) tries `bak.1` → `bak.2` → `bak.3` in order.
- **What is canonical where:** doc **body text** — the file body (irreplaceable content). Tree/vocabulary — manifest. Front matter — redundancy copy of metadata. `derived.*` — rebuildable, never trusted over a recompute. `sessions.jsonl` — append-only, never rewritten, survives everything except full folder loss.
- **The session log in a folder.** A save to a folder writes `sessions.jsonl` as the folder's own lines stand, followed by the browser's lines the folder does not hold, so the file is only appended to: no line the folder holds is dropped, reordered or rewritten, a damaged line included. Opening a folder appends to the browser's copy every line of the folder's log it does not hold, so the writing history a folder holds comes back when the project is opened from it after it was removed from this browser. Two logs that differ are merged, never refused: every line of both is kept, and the folder's own lines come first. Two lines are the same session when their start, end, words and documents match (in order), and each line answers for one line only. The log is written before any project file, so nothing is lost if the save stops after it.

Severity tiering (from novelWriter's model): content = `docs/*` (irreplaceable) · structure = `caotang.json` (recoverable from `.bak`, worst-case partial rebuild §5) · derived = `derived.*`, `exports/` (disposable) · stats = `sessions.jsonl` (append-only, keep).

## 5. Recovery contract

Loader steps when `caotang.json` is unparseable:

1. Try the rolling snapshots in turn — `caotang.json.bak.1` → `bak.2` → `bak.3` (legacy `caotang.json.bak` tolerated for hand-made artifacts) — first parse wins → offer load, tell the user which path succeeded.
2. Both dead → **rebuild-from-front-matter** (user-visible, explicit consent): scan `docs/*.md`, parse front matter → recreate document nodes with their metadata. Documents land flat under a synthesized `Recovered` folder, sorted by `synopsis`-absent order fallback = filename. Folder structure and vocabulary are **lost** (folders have no files; statuses/labels without a manifest can't validate) — the report says exactly that. This is the honest bound of the single-manifest choice; see docs/decisions.md.
3. After any recovery, the rebuilt project is written as a **new** manifest; the corrupt original is preserved as `caotang.json.corrupt-<timestamp>`.
4. **Codex recovery (codex.md §3):** the rebuild pass also scans `codex/*.md`; entries are restored from their redundancy files (description, aliases, policies survive; dangling attachment ids dropped with warning). Orphan codex files with no manifest entry are imported the same way orphan `docs/*.md` are.

## 6. Versioning & migrations

- `formatVersion` is an integer; v1 is the first stable format.
- Migrations run **load-time, in-memory first**: `v(n) → v(n+1)` functions in a fixed registry, each with a unit test fixture pair. A migration failure aborts the open with the project untouched.
- Writers always save at the **current** version (no rolling forward on unrelated edits).
- Unknown-tolerance: unknown fields on load are preserved in memory and **dropped on next save**, with a one-time notice that names each such field. The open counts only these as dropped; the other things a load noticed (an identity made at open, a migration, a document held because its text is not UTF-8) are said as their own sentences. (Rationale: round-tripping unknown fields forever turns the manifest into an append-only log; explicit drop-notice beats silent divergence both ways. Rejected: strict reject — breaks harmless third-party annotation.)

## 7. Portable deliverables

- **Zip bundle:** `<project-name>.caotang`, a zip with `caotang.json` at zip-root (never nested under a directory). Import accepts zip or directory; export is lossless both ways. A file the load could not read because its bytes are not UTF-8 — a document body or a codex redundancy file — is the one thing an export refuses rather than leaves out: there is no text to carry, and a bundle that dropped it would ship a project without it. A save in place is never affected, because the folder holds that file already. The extension is `.caotang`, not `.zip`, so an OS opens it with Caotang rather than an archive tool.
- **ToC.md** (generated on export): human-readable map `order — title — status — filename`, so an opaque-id folder is navigable without Caotang. Cheap, addresses the hex-name ergonomic cost; goes in `exports/`, not the tree.

## 8. Runtime store vs artifact (explicit split)

v0.1 is a browser app. Browsers cannot hold a user-visible folder as the working copy without File System Access API (Chromium-only, per-session permission). Therefore:

- **Runtime truth:** IndexedDB (OPFS sync access handles stay a reserved fallback if word-count or scan performance ever demands them). All commands read/write the runtime store.
- **Artifact:** exported on demand (zip download or directory write where available), and auto-suggested on close-if-dirty. Import creates a fresh working copy.
- **A project remembers its folder.** Where folder access exists, the folder a project was saved to, or opened from as its own project, is kept as its `FileSystemDirectoryHandle` in the app database (`folder:<projectId>`, apps/desktop folder-memory.ts) and forgotten when the project is removed. The projects list's **Reopen folder** asks for permission from the click (`queryPermission`, then `requestPermission`) and falls back to the folder picker when permission is refused or the folder is gone. A folder whose project this browser keeps in a version that is not the same book asks, rather than copying without a word: **Use the folder's version** (the browser's copy is replaced under the same id, with both writing histories; the browser's copy is held in memory as a bundle first, and put back under its id if the folder's version then fails to open), **Keep this browser's version and save it to the folder** (a folder save, checked against this browser's version of each file the folder holds, so each document it would write over is named in the changed-documents question first), or **Open as a separate copy** (a fresh id, which cannot be saved into that folder, as before). A folder save first asks whose project the folder's `caotang.json` names (lifecycle `saveFolder`, integrity-model `folderProjectRoute`): **the book a separate copy was made from** (the copy's fresh id records the original's, on the session and in the app database as `copied-from:<projectId>`, so it holds after a reload) is refused, since writing the copy there would turn that book into the copy; **any other project** is the another-project question ("This folder already holds another project", whose **Save over it** writes through the same folder save, with the old `caotang.json` rotated to `caotang.json.bak.1` and no backup of the documents); and **this project's own id** is never called another project. For this project's own folder the save is checked against the folder copy this session holds, or, when it holds none (after a reload), against the copy kept for it in the app database (`folder-copy:<projectId>`: the folder's name, `caotang.json` text, documents named, and file digests and titles, written whenever the folder is opened as the project's own or saved to). That kept copy counts only for the folder the project remembers (`isSameEntry`), or, where no handle is remembered, a folder of the same name. A folder that still matches it is saved straight away; one with changed documents or codex files goes through the changed-documents question, and a changed `caotang.json` through the changed question. With no copy at all for that folder, the save asks "This folder holds an earlier save of this project" (verdict `earlier`), saying that saving writes this tab's version over the folder's documents and that the folder's version is not kept beyond a backup of its `caotang.json`. A folder save that the changed-documents, another-project or earlier-save question stops also offers **Save as a new folder…**, which takes only an empty folder and saves there through the same folder save. A handle in the origin's private file system (the end-to-end suite's stand-in picker) is not remembered, because Chromium closes the page reading one back in a private profile.
- **Acceptance test (hard):** open artifact → mutate → export → diff against in-memory project state = empty; round-trip twice with a reorg in between = identical docs content. This test guards the "files are ownable" principle (ARCHITECTURE §1.2) without pretending the browser is a filesystem.
- A native desktop wrap (Tauri) would promote the artifact folder to the *primary* store; this spec is already written so no format change is needed — the runtime store is a cache/view in that world, matching Principle 2 exactly.

## 9. Assumptions & open questions

| # | Assumption / question | Status |
|---|---|---|
| A1 | Notes stay in manifest (≤ 50k chars/node) for v0.1 | Explicit; split to `docs/<id>.notes.md` in v0.2 if real projects complain. |
| A2 | No per-doc heading overrides in v0.1 | Current rule: compile inserts headings from node titles (§3). |
| A3 | Single manifest + front-matter redundancy + rolling snapshots is SPOF-sufficient for v0.1 | **Precedent-backed**: every shipping survivor uses single-manifest (novelWriter) or no-manifest (Obsidian); write path (temp→rename, single IndexedDB transaction) kills the torn-write class; rolling snapshots ×3 adopted from Obsidian's automatic-recovery-depth lesson. |
| A4 | Crockford base32 ids, 10 chars | Collision check at generation; renames never touch disk. |
| A5 | `sessions.jsonl` schema | One JSON line per session: `{startedAt, endedAt, wordsWritten, docIds[]}` — spec'd here, no research needed. |