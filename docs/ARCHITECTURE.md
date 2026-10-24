# Caotang — Architecture

> Status marks: 📐 **spec** (implementable as written, and the code follows it) · 📝 **draft** (shape known, details open) · 🧭 **planned** (specified and decided, not built: the code does not do it yet).
> Each module has its own spec in [architecture/](architecture/). The standing decisions behind them are in [decisions.md](decisions.md).

## 0. Product thesis

Scrivener's successful cousin: the structure-first writing environment novelists actually need — binder → corkboard → editor → compile — with an AI that **drives the app like a harness**: an operator holding tools over binder, editor, corkboard, notes and export. Not a chat sidebar.

Two promises:

1. **Local-first & BYOK** — the manuscript never leaves the machine except through the writer's own configured provider (base URL + key + model, stored locally).
2. **Agent as power tool** — "summarize chapter 2 and mark its scenes draft" is one instruction the agent executes through the same command surfaces the human uses, with plan preview, visibility and undo.

## 1. Principles

1. **Local-first** — all state on device; whole-project export/import as a portable artifact.
2. **Files are ownable** — the on-disk project format (folder of Markdown + JSON manifest) is the source of truth; IndexedDB is the working copy, never the only copy.
3. **BYOK only** — streaming chat calls straight from the browser to the writer's provider; no Caotang server, no accounts, no telemetry.
4. **Agent = tools + plan loop + undo** — every agent action routes through the app's command bus (same commands the UI emits), grouped into undoable turns. No tool-less "AI features".
5. **Small core** — the module set below is closed; anything else goes to the roadmap, not the codebase.
6. **Testable headless** — every module works without a browser (Vitest) and the whole app works scripted (Playwright); the agent harness is testable against the mock provider.

## 2. Module map

Each module: responsibility → owns → key surfaces → spec. Dependencies flow downward (UI modules never touch persistence directly; everything goes through commands).

### 2.1 `project-store` 📐
- **Responsibility:** load/validate/save a project; binder tree, document texts, metadata; codex entry records; format versioning and migrations; autosave pipeline; crash safety and the recovery ladder (`caotang.json.bak.1..3`).
- **Owns:** project manifest, binder tree, document store, codex entry records and their redundancy files, statuses/labels vocabulary. The browser working store is IndexedDB.
- **Spec:** [architecture/project-format.md](architecture/project-format.md).

### 2.2 `binder` (UI) 📐
- **Responsibility:** tree view — manuscript → folders → text documents (three tiers, mirroring Scrivener; folder-in-folder tolerated by the format, never created by the UI); drag-drop reorder/reparent; status/label chips; inline rename.
- **Owns:** binder UI state only (tree data lives in project-store); view-mutation commands (`view.*` class) are ephemeral.
- **Surfaces:** emits the same `binder.*` commands the agent uses (command-bus §9). Spec: [architecture/ui-modules.md](architecture/ui-modules.md) §2.

### 2.3 `editor` (UI) 📐
- **Responsibility:** rich-text editing of one document; autosave; word/char counts; session targets; focus mode; ghost-preview region for agent drafts; selection ⇄ `TextAnchor` bridge.
- **Owns:** editor view state, selection, the writer's keystroke undo lane (two-lane model).
- **Surfaces:** engine-agnostic `EditorApi` seam over Tiptap 3 / ProseMirror with `@handlewithcare/remark-prosemirror` as the Markdown boundary. Spec: [architecture/editor-engine.md](architecture/editor-engine.md).

### 2.3a `codex` 📐
- **Responsibility:** per-project knowledge base of recurring entities (characters, locations, objects, lore, subplots); mention detection over manuscript text; include-policy filtering feeding context assembly; agent read/write surface.
- **Owns:** codex entries (manifest `codex[]` + `codex/<id>.md` redundancy), mention-detection caches.
- **Surfaces:** agent tools `codex.read` / `codex.write`; codex panel and inspector chips; pure detection function. Spec: [architecture/codex.md](architecture/codex.md).

### 2.3b `context-assembly` 📐
- **Responsibility:** the read half of every model call — fixed eight-layer prompt stack, token budgets, deterministic truncation, prompt preview, cost estimates. Keyed context (synopses + mention-keyed codex), no embeddings.
- **Owns:** assembled `messages[]`, layer budgets, drop reasons.
- **Spec:** [architecture/context-assembly.md](architecture/context-assembly.md).

### 2.3c `coherence` 📐
- **Responsibility:** the app checks the story instead of only storing it — deterministic checks (timeline arithmetic, alias collisions, declared presence/POV, order drift; zero model calls) and a model review run as an evidence pipeline through the harness; findings inbox.
- **Owns:** `coherence.json` (findings, runs, scene metadata, world rules), check registry.
- **Spec:** [architecture/coherence.md](architecture/coherence.md).

### 2.4 `corkboard` (UI) 📐
- **Responsibility:** index-card view of a container's children: title, status and synopsis per card; drag-reorder writes back to binder order; S/M/L card sizes.
- **Surfaces:** no commands of its own — every board gesture maps onto the binder command set. Spec: [architecture/ui-modules.md](architecture/ui-modules.md) §3.

### 2.5 `inspector` (UI) 📐
- **Responsibility:** per-document side panel: synopsis, notes, keywords, label/status, codex attach and mention chips.
- **Spec:** [architecture/ui-modules.md](architecture/ui-modules.md) §4.

### 2.6 `agent-harness` 📐
- **Responsibility:** the in-app AI operator. Tool registry mirroring the command bus; plan → act → verify → report loop; editable plan cards; ghost previews with Apply / Retry / Discard; per-turn checkpoints; permission model (auto for reversible operations, confirm for destructive operations and exports, a hard-deny class no flow can approve); activity log.
- **Owns:** agent sessions, tool registry, plan state, activity log.
- **Spec:** [architecture/agent-harness.md](architecture/agent-harness.md); range edits use [architecture/edit-anchors.md](architecture/edit-anchors.md).

### 2.7 `provider-gateway` 📐
- **Responsibility:** BYOK client: streaming chat calls, model listing, token accounting, retries/backoff, abort; deterministic **mock provider** for tests and the built-in demo provider; sealed key storage (AES-GCM under a non-extractable WebCrypto key).
- **Owns:** provider profiles, connection state, the local request log.
- **Spec:** [architecture/provider-gateway.md](architecture/provider-gateway.md).

### 2.8 `exporter` 📐
- **Responsibility:** compile — select binder subset → flatten → render → emit, to Markdown, plain text, Word (`docx`, lazy-loaded) and EPUB 3.3, plus the media formats; saved recipes.
- **Owns:** compile pipeline, render templates.
- **Spec:** [architecture/exporter.md](architecture/exporter.md), [architecture/epub-metadata.md](architecture/epub-metadata.md).

### 2.9 `settings` 📐
- **Responsibility:** provider profiles, editor preferences, session targets, theme (light/dark), data and persistence state, context budgets, MCP servers.
- **Owns:** app-level settings state — never project state; the agent cannot change it.
- **Spec:** [architecture/ui-modules.md](architecture/ui-modules.md) §5.

### 2.10 Cross-cutting: **command bus + undo** 📐
- **Responsibility:** the spine every module talks through. Single command bus; UI and agent both emit commands; each command is validated first (pure `validate` before any effect), permission-gated, atomic, reversible (inverse or compensation) and logged. Undo groups = one agent turn or one user gesture, shown as "restore to before this turn" checkpoint rows.
- **Owns:** command descriptors, permission gate, undo groups, `callId` dedupe, per-document revision conflicts, activity log.
- **Spec:** [architecture/command-bus.md](architecture/command-bus.md).

### 2.11 `edit-anchors` 📐
- **Responsibility:** make agent range edits survive drift between plan time and apply time: quote + offset anchors resolved by a ladder (exact → near-offset → fuzzy context → unique global → ask back), never a silent fallback.
- **Spec:** [architecture/edit-anchors.md](architecture/edit-anchors.md).

### 2.12 `binder-filters` 📐
- **Responsibility:** named saved queries over the binder tree (text, status, label, keywords, word counts, recent dates; conjunctive); view-only.
- **Spec:** [architecture/binder-filters.md](architecture/binder-filters.md).

### 2.13 `goals-progress` 📐
- **Responsibility:** the daily session target, project goals with deadline pacing, weekly and monthly goals, the sprint timer and the writing history over `sessions.jsonl`.
- **Spec:** [architecture/goals-progress.md](architecture/goals-progress.md).

### 2.14 `codex-panels` 📐
- **Responsibility:** the per-entry appearance view ("which documents mention this entry"), built from the existing mention caches; codex panel search and filter.
- **Spec:** [architecture/codex-panels.md](architecture/codex-panels.md).

### 2.16 `extensibility` (MCP client and server) 📐
- **Responsibility:** connect writer-configured MCP servers (Streamable HTTP in the browser), expose their tools through a search-then-load surface (`tool.search`), and serve Caotang's own registry to other tools through the separate `caotang-mcp` process.
- **Security posture:** off by default; per-server opt-in; per-call confirmation unless trusted for reads; tool pinning against changed tools; tool text and results are untrusted; no agent-driven installs.
- **Spec:** [architecture/extensibility.md](architecture/extensibility.md).

### 2.17 `sdk` (Node) 📐
- **Responsibility:** run the agent against a project folder from a script, a CLI or CI (`@caotang/sdk`): `openProject`, an approval policy in place of the cards, a diff before anything is saved, the provider key held in memory. It owns the Node folder session (the single-writer lock, the folder-drift checks, the write queue) that the MCP server shares, and builds its harness with the same `createProductHarness` the desktop does.
- **Spec:** [architecture/agent-harness.md](architecture/agent-harness.md) §11. Its README: [../packages/sdk/README.md](../packages/sdk/README.md).

### 2.18 `pictures` 🧭
- **Responsibility:** one picture registry with hashes and dedup, links from the project, a folder, a document or a paragraph, inline pictures in prose carried into EPUB, Word and Markdown, the import pipeline (HEIC, pixel budget, GPS strip), vision input for the agent, MCP pictures in both directions, and handwriting transcription.
- **Owns:** `assets[]` and `assetLinks[]` in the manifest, the pure `packages/pictures` selectors, the thumbnail store, the retention inventory a sweep must read. A host capability gate (browser canvas; Node's WebP→PNG path only) refuses a picture operation a host cannot run. Specified, not built.
- **Spec:** [architecture/pictures.md](architecture/pictures.md).

### 2.19 `timeline` 🧭
- **Responsibility:** an interactive view of the story on story time, reading order or both, where every edit gesture is a proposal the writer approves and applies as one undoable `timeline.apply`; prologues, the main story and epilogues as declared parts (§5.2.2); both axes in the project language's direction while the data stays in logical order; timeline exports, agent tools and an MCP resource from one pure layout package, with confirmed MCP writes reporting typed persisted, conflict or partial outcomes.
- **Owns:** `packages/timeline` (layout, calendar lens, medium adapters), the proposed-changes tray (view state). Scene timing stays in `coherence.json` `sceneMeta`. Specified, not built.
- **Spec:** [architecture/timeline.md](architecture/timeline.md); the coherence-model change is [architecture/coherence.md](architecture/coherence.md) §5.2.2.

### 2.20 `i18n` 🧭
- **Responsibility:** one interface language, kept apart from the project (content) language: compiled message catalogs with a per-message English fallback, locale-aware formatting and sorting, a mirrored right-to-left interface, the agent writing to the writer in the interface language, translatable finding and notice text, and export boilerplate in the project language.
- **Owns:** `packages/i18n` (locale resolution, `Intl` formatters, collation, bidi isolation, the `MessageRef` type), the desktop catalogs under `apps/desktop/src/i18n/`, the interface-language app setting. Specified, not built.
- **Spec:** [architecture/i18n.md](architecture/i18n.md).

## 3. Data model (sketch)

```
Project        { id, name, formatVersion, createdAt, settingsRef }
BinderNode     { id, parentId, type: manuscript|folder|document,
                 title, order, status?, label?,
                 synopsis, keywords[], notesRef? }
Document       { binderNodeId, content (rich text / MD), wordCount, updatedAt }
StatusLabel    { id, name, color, kind: status|label }   // project-local vocabulary
AgentSession   { id, scope (doc|project), messages[], toolCalls[], plan?, undoGroupId }
CodexEntry     { id, name, aliases[], type, description (md), includePolicy: always|detected|manual|never,
                 caseSensitive?, exclude[], attachments[], keywords[], origin: manual|agent|import,
                 sources?: EntrySource[], createdAt, updatedAt }   // codex.md §2
CoherenceFinding{ id, runId, class: deterministic|llm, checkId, type, severity, status: open|dismissed|fixed,
                 factGroup, evidence: Evidence[1-2], reasoning?, modelMeta?, dismissedReason?, supersededBy? }  // coherence.md §3
SceneMeta       { pov?, dayOffset?, durationDays?, after?, expectedPresent?, storyPart?: main|prologue|epilogue }   // coherence.md §5.2, §5.2.2 (writer-declared; absence inherits)
ExportRecipe   { include[], template, format }
AssembledPrompt{ messages[], layers[{id, included, tokens, dropped[]}], estimate }  // context-assembly.md §4
TextAnchor     { from, to, exact, prefix, suffix, capturedRevision }              // edit-anchors.md §2
AssetRecord    { id, file, mime, sha256, bytes, width?, height?, caption?, alt?, decorative?, tags?, source?, transcription? }  // pictures.md §2.1 (planned)
AssetLink      { id, assetId, target: project|node|paragraph, role: reference|card|source, order, note?, when? }        // pictures.md §2.1 (planned)
ComicBook      { readingDirection, letteringFace, capsTransform, esszett, pageSize, scriptDocId? }                       // comics.md §2 (planned)
ComicPage      { size, layout?, panels: Panel[] }                                                                       // comics.md §2 (planned)
Panel          { id, rect, assetId?, crop?, border?, balloons: Balloon[] }                                              // comics.md §2 (planned)
TimelineOp     { op: meta|move|shift|picture-when, …, expect }                                                         // timeline.md §4.3 (planned)
MessageRef     { id, values?, message }                                                                          // i18n.md §3.2 (planned)
Command        { id, name, params, issuedBy: user|agent, turnId?, callId?, createdAt }  // command-bus.md §2
ActivityEntry  { at, command, issuedBy, turnId?, callId?, undoGroupId?, source?: native|mcp, affected[], tokensSpent?, summary, defect? } // command-bus.md §8
AskBack        { code, reason, candidates?, revisionDrift?, options[] }           // agent-harness.md §2
LossWarning    { code: unsupported-node|lossy-attribute|lossy-structure, mdastType, position?, detail }  // editor-engine.md §3.3
SavedFilter    { id, name, root?, criteria: FilterCriteria, createdAt, updatedAt }         // binder-filters.md §2
ProjectGoal    { id, nodeId, metric, comparator: at-least|at-most|about, target, deadline?, archived?, createdAt, updatedAt }  // goals-progress.md §2.2
McpServerConfig{ key, name, transport: 'http', url, auth, enabled, trustReads, pinnedTools, addedAt }  // extensibility.md §3.2 (app settings, never project files)
```

Additive manifest arrays (`codex[]`, `recipes[]`, `filters[]`, `goals[]`) and per-node `createdAt`/`updatedAt` join format v1 without a `formatVersion` bump. MCP server configs are not project data: they live in app settings, never in `caotang.json`, so a committed project can never carry a server URL or token.

## 4. Explicit non-goals

Collaboration and sync in the local version, a plugin system, a theme marketplace, version history beyond git, **embedding/RAG context retrieval** (keyed context is the design; revisit only with usage evidence), a **codex relations graph**. Screen and media formats were once on this list and are now built (§6).

## 5. Scope non-negotiables

Any change that breaks one of these needs a strong case:

- Local-first files are the source of truth.
- Your own key, with no Caotang server in the path.
- No telemetry, no credit meters, no AI feature gates.
- Plain-text artifacts (Markdown, Fountain, Ink, JSON, CSV).
- Agent actions are tool-routed, previewed and undoable.

## 6. Screen & media track 📐

Caotang covers games, video and film as well as prose. The full inventory lives in [architecture/media-track.md](architecture/media-track.md); the summary:

| Capability | One-line scope | Attaches to | Spec |
|---|---|---|---|
| **Screenwriting & script formatting** | screenplay layout (scene headings, dialogue, parentheticals, transitions); Fountain and Final Draft import and export | `document.kind`, editor layout, `exporter` | [screenplay.md](architecture/screenplay.md) |
| **Cutscenes & game narrative** | branching dialogue in Ink, choices, conditions, variables, VO cues, loc-ready line ids | new binder node kinds, `exporter` (Ink / JSON / loc CSV) | [dialogue-narrative.md](architecture/dialogue-narrative.md) |
| **Storyboarding & shot planning** | scene → shot breakdown: frame, camera, action, dialogue covered, duration; shot list exports | `shot` node kind, corkboard variant with image fields, `inspector` | [storyboard.md](architecture/storyboard.md) |
| **AI video prompt packs** | per-shot prompt packs for several video models. **Caotang writes prompts; it does not render video** — generation stays in the writer's own tool with their own account | `context-assembly`, `codex`, `exporter` (vendor templates), harness tools | [video-prompt-pack.md](architecture/video-prompt-pack.md) |
| **Plot coherence & continuity** | deterministic checks (structure + codex, no model call) and model-judged findings (evidence-cited reports, never silent edits) | `coherence` module over `codex` + `context-assembly` | [coherence.md](architecture/coherence.md) |
| **Comics** 🧭 | comic books, pages, panels and balloons; comic scripts (full script or Marvel method) linked explicitly by `scriptDocId`; lettering rules; comic PDF, CBZ and fixed-layout EPUB. The CBZ and the comic EPUB are made in the browser only; the PDF is written by both hosts. Specified, not built | `comic` node kind, `comic-page` nodes, picture registry, `exporter` | [comics.md](architecture/comics.md) |
| **One story, many outputs** | a single narrative source compiled to prose, screenplay, game dialogue, storyboard, prompt pack and report targets — media targets are **export recipes**, not separate apps | the `exporter` contract and per-kind renderers | [media-track.md](architecture/media-track.md) §1 |
