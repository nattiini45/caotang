# Codex — project knowledge base & mention detection (v1)

> Status: built.
> Keyed context (mention detection), zero embeddings: deterministic keyword and mention assembly, no retrieval. Cross-refs: budgets & assembly order = [context-assembly.md](context-assembly.md) · manifest/artifact = [project-format.md](project-format.md) · tools = [agent-harness.md](agent-harness.md) §3.

## 1. Purpose

The codex is the per-project knowledge base of *entities that recur in the prose*: characters, locations, objects, lore, subplots. It exists for exactly two consumers:

1. **Context assembly** — generation calls include codex entries keyed by mention (per policy), never the whole codex.
2. **The agent** — reads/creates/updates entries so the bible stays *maintained* (manual bible entry is the usual chore; Caotang's agent fills the codex from the manuscript).

Explicitly **not** in v0.1 (backlog): relations graph (real power, real context-flood risk; needs prompt-preview debugging first), per-entry typed detail sub-fields, thumbnails, appearance heatmap (cheap derived stat, v0.2), embedding retrieval (rejected).

## 2. Data model

```ts
type CodexType = 'character' | 'location' | 'object' | 'lore' | 'subplot' | 'other';

interface CodexEntry {
  id: string;                    // "c_" + 10 chars Crockford base32 (same generator as node ids; collision-checked)
  name: string;                  // ≤ 120 chars; unique case-insensitively within the project
  aliases: string[];             // ≤ 10, each 1–64 chars; matched exactly like name
  type: CodexType;               // fixed v0.1 enum (custom types = v0.2)
  description: string;           // Markdown; the AI-facing payload; ≤ 2000 chars
  includePolicy: 'always' | 'detected' | 'manual' | 'never';   // default 'detected'
  caseSensitive?: boolean;       // default false (see §4)
  exclude?: string[];            // phrases in which matches are ignored; ≤ 20, each ≤ 64 chars
  attachments: string[];         // node ids (documents or folders) this entry is manually attached to
  keywords: string[];            // free tags; **human-only lane — never sent to the model**
  origin: 'manual' | 'agent' | 'import';   // default 'manual' for UI-created entries
  sources?: EntrySource[];       // provenance citations; present iff origin ≠ 'manual' (may also be set on manual entries)
  createdAt: string; updatedAt: string;   // ISO-8601
}

interface EntrySource {           // where the entry's content came from (a fact tied to its source passage)
  docId: string;                  // manuscript doc the entry was extracted from
  quote: string;                  // ≤ 300 chars verbatim slice (body projection)
  from: number; to: number;       // char offsets into the body projection at extraction time (reporting key, not an anchor — edit-anchors.md §4)
  extractedAt: string;            // ISO-8601
}
```

Field contracts (mirrors project-format §2 discipline — every field has a domain and a failure behavior):

| Field | Contract |
|---|---|
| `name` | Required, non-empty after trim. Load-time duplicate (case-insensitive) → keep both, surface "duplicate codex name" warning chip; writer never silently renames. |
| `aliases` | Deduped, case-insensitive vs `name` and each other; alias equal to another entry's name → load warning, detection resolves to the entry owning it as `name`. |
| `description` | Empty description = entry is **dropped from assembly** even when matched ("filter out empty entries") and flagged in prompt preview as `empty description`. |
| `includePolicy` | Unknown value on load → coerce to `'detected'` + warning (policy enum is closed). |
| `attachments` | Referential integrity at load: dangling ids dropped with warning (never blocks load). |
| `keywords` | Max 32 × 64 chars, same limits as node keywords; **never leaves the machine's assembly layer** — the anti-"eye color 20 times" lane. |
| `origin` | Unknown value on load → coerce to `'agent'` + warning (enum closed). **Canon-outranking rule:** when a coherence finding names both a hand-authored (`origin: 'manual'`) and an agent-inferred entry, the manual entry is canon — fix proposals target manuscript text and entry-side updates route via `codex.write`; coherence.md §4.3 is the consumer of this rule. |
| `sources` | Max 5 per entry; dangling `docId` → source dropped with warning (same rule as `attachments`); offsets are informational (body edits shift them — never re-anchored, never used to apply edits). |

**Provenance semantics:** `codex.write` sets `origin: 'agent'` + `sources[]` automatically on create; the UI codex editor defaults `origin: 'manual'` and lets the writer attach a source citation by picking text (rare, but keeps hand-entries citable). Provenance is **display data in v0.1** (inspector "established from…" line + codex panel badge) and the coherence canon rule's input; it is **not** sent to the model as separate payload (description body already carries the content). `import` origin = an import: the agent's `codex.import` (at most 20 entries per call) or the writer's batch import from the app (`codex.importBatch`, §7.1), or the cast and location rows the writer ticks in a Final Draft script import, which `screenplay.import` makes in its own undo group, each attached to the first imported scene that names it (#265).

## 3. Storage & write path

- **Manifest is structural truth:** `caotang.json` gains a top-level `codex[]` array (full `CodexEntry` objects, same fixed key order discipline as `tree`). Format v1 absorbs it additively — no `formatVersion` bump (versions migrate real data, not spec growth).
- **Per-entry redundancy file:** `codex/<id>.md` — YAML front matter `{id, name, type, includePolicy, caseSensitive, aliases, exclude, attachments, keywords}` + body = `description` Markdown. Written on every entry save via the same atomic write path as documents (temp → rename; project-format §4). This is the doc front-matter pattern applied to codex: **each entry is individually meaningful and survives manifest corruption** — the direct countermeasure to the failure mode where single-asset corruption makes a whole project unreadable.
- **Conflict rule:** manifest wins over redundancy files; missing file → rewritten from manifest; file with no manifest entry → recovered like orphan `docs/*.md` (project-format §2 validation step 4): imported as a codex entry under `codex/`-file metadata, reported in the load notice.
- **Recovery (project-format §5 extended):** the rebuild-from-front-matter pass also scans `codex/*.md`; rebuilt entries land with their stored policy/aliases; descriptions survive; attachment ids that no longer resolve are dropped per the dangling rule.
- **No codex secrets rule** (project-format §2): descriptions are prose, but the no-secrets discipline applies — provider keys/URLs never belong in codex text; loader does not scan for them (documented, not enforced).
- **Series-scope design constraint:** writing tools with a multi-book story commonly ship a shared/promotable codex; Caotang's is single-project in v0.1, but entry ids and the `codex/<id>.md` redundancy layout must assume **no project-local collision domains** (ids globally unique per install) so a future "promote entry to series scope" needs no migration. Boundary recorded in [codex-panels.md](codex-panels.md) §3.

## 4. Mention detection engine

Deterministic, cacheable, and eval-stable. Semantics follow established codex-tracking mechanics minus the taste-driven parts. **Text scanned is the body projection** (project-format.md §3 — stored body minus YAML front matter), the same coordinate system `doc.read` and edit anchors use ([edit-anchors.md](edit-anchors.md) §2).

**Matching rules (in order):**

1. **Terms** = `{name} ∪ aliases` minus exclusion-phrased contexts. Matching is per-term.
2. **Boundary rule:** a term containing only Latin letters/digits must match at word boundaries (`\b`-equivalent: preceded/followed by non-letter-or-digit or string edge). Non-Latin terms (CJK, Cyrillic, etc.) match as plain substrings — `\b` is meaningless without word separators.
3. **Case:** default case-insensitive (Unicode case folding); per-entry `caseSensitive: true` for common-word names ("Will"). Case-sensitive mode still applies the boundary rule.
4. **Exclusion phrases:** per-entry `exclude[]`; occurrences inside any phrase occurrence are dropped. Count survives only if non-excluded occurrences remain.
5. **Auto-pluralization: rejected for v0.1** ("Goblin→Goblins" yes, "Wolf→Wolves" no — heuristic half-failures are worse than an explicit alias list; deterministic aliasing beats magic). Users add plurals as aliases; the codex editor suggests a naive `+s` plural as a one-click alias.
6. **Detection surfaces** (what text is scanned): for a generation call — the instruction text, the focus document's assembly-visible text per mode (draft: none; continue: the tail; rewrite_selection: selection + preceding tail), and the active selection (see context-assembly §5). For `continuity.scan`: full text of all scope docs (expanded budget). Chat/panel messages count as instruction text.

**Implementation & performance:**

```ts
interface MentionIndex {           // cached per document in the runtime store
  docRevision: number;             // doc.revision at build time
  codexRevision: number;           // max entry updatedAt at build time (monotonic counter suffices)
  hits: Map<entryId, number>;      // entryId → mention count in this doc
}
```

- Built per document at document write time (or lazily on first assembly need), invalidated by either revision. v0.1 algorithm: single pass per document over each term (naive multi-term scan) — **evidence-backed**: plain `indexOf` loops beat Aho-Corasick below ~70 keywords (V8's memchr-class scan rates), so at our scale (§10 K3: 100 entries × 120k words) the uncached full-manuscript pass is ~50–200 ms and per-doc caching makes steady-state assembly O(hits); AC escalation trigger = p95 detection pass >100 ms on real projects or >500 concurrent terms (no maintained JS AC library exists, so the escalation also means owning a hand-rolled automaton).
- Detection at **assembly time** for instruction/selection (uncached, small strings); document-body hits come from the cache.
- The engine is a pure function `detect(docs, entries, surfaces) → Map<entryId, {count, where}>` — headless-testable (ARCHITECTURE §1.6), no editor dependency. Editor underline-highlighting of mentions is a **v0.2 UI feature** (depends on the editor's decoration layer); v0.1 UI surfaces hits as counts in the codex panel and inspector chips.

## 5. Include policies (4 states)

| Policy | Sent to model |
|---|---|
| `always` | Every generation call, regardless of detection (genre notes, style guides live here). |
| `detected` *(default)* | Sent when name/alias appears in the call's detection surfaces (§4 rule 6). |
| `manual` | Suppressed even when detected; enters only via `attachments` on the focus doc (or an ancestor folder). |
| `never` | Never sent (private notes, spoilers, reference-only). |

Manual attach is set from the inspector ("Attach to document") or via `codex.write` `attachTo`. Attachments on a folder attach to all descendant documents (folder attach = the common "these lore notes apply to Act 2" case; expansion follows the binder tree at assembly time).

## 6. Context assembly integration

The full ordering, budgets, and the assembly algorithm live in [context-assembly.md](context-assembly.md) (§4 codex layer). Summary of the codex-specific contract:

1. Candidate set = mentions (detected) ∪ `always` entries ∪ `manual` entries attached to focus scope.
2. Filter: `never` out; empty descriptions out.
3. **Sort deterministically:** `always` first, then by `type` (enum order above), then `name` (case-insensitive) — insertion order is independent of mention order, which makes assembled context eval-stable (adopted for §9 evals).
4. Render per entry: `## {name} ({type})` + description body. Aliases are **not** rendered (they're detection keys, not payload).
5. Budget: the codex layer gets its fixed allocation, fitted in two phases (context-assembly A3). Phase one reserves the `always` entries; phase two fits the detected and manual entries into what they leave, pruning from the bottom of the rank order (manual → detected tail), with the prune list surfaced in prompt preview. When the `always` entries fit, this is the same set a flat prune keeps. When they alone exceed the allocation, all of them are still sent, every other entry is dropped, and the layer reports the overflow as a drop ("the codex's always entries need N tokens; the layer's budget is M") and a layer note, so a rule set to `always` never leaves the prompt without the preview saying why. The whole-prompt pass floors the codex at its `always` entries, so a prompt they push over the total budget is reported as over budget, not trimmed. Never truncate an entry's description mid-body — drop whole entries, deterministically.

## 7. Agent tools (added to harness registry — 12 → 14)

Full tool-table rows are in [agent-harness.md](agent-harness.md) §3; the contracts:

**`codex.read`** (read): `query?: string` (case-insensitive substring over name/aliases/description), `type?: CodexType | 'all'`, `includePolicy?: policy | 'all'`, `id?: string` (exact fetch → full description), `limit?: number` (default 25, max 100). Returns entries with description preview (query-hit ±80 chars context, else first 200 chars) + `attachments` + mention counts for the last-written docs when cached. Cap 8k tokens. Empty result is a **result, not an error** ("no entries match; use `codex.write` to create").

**`codex.write`** (write-confirm): `entries: {action: 'create'|'update', id? (required for update), name?, aliases?, type?, description?, includePolicy?, caseSensitive?, exclude?, attachTo?: string[], detachFrom?: string[], visualRefs?: string[] (asset ids, at most 10; an update replaces the list)}[]`, ≤ 20 entries per call. A picture named twice is one reference: the preview and the saved entry hold the list once. The plan card names each visual reference by its picture's file name, and names a picture the project no longer holds as one that is no longer in the project (video-prompt-pack.md §3). A `visualRefs` id that names no picture in the project is kept and reported missing by the prompt pack, not refused and not dropped at load (video-prompt-pack.md §3). Batch validated as a whole **before** execution (all ids resolve, no case-insensitive name collisions within batch or project, type enum valid). Plan card shows old→new diff per entry (create = full proposed content; description over 2000 chars = truncation **proposed in the card**, never silent). One undo group for the batch; per-entry compensation inside. Errors name the next corrective tool (unknown id → "use `codex.read` with query"; collision → names the existing entry). Effects: manifest `codex[]` + `codex/<id>.md` written; mention caches invalidated; codex panel refreshes. **Provenance:** agent-created entries get `origin: 'agent'` + `sources[]` citing the manuscript docs the extraction ran over (docId + quoted span per source, ≤ 5); agent updates to an existing `manual` entry append a source but never flip its origin (hand-authored stays hand-authored — canon rule, field contracts above).

**Not agent tools in v0.1:** codex entry **deletion** (UI-only, same 0-to-1 rule as `delete_node` — the agent proposes deletions in its report), the writer's batch import (`codex.importBatch`, §7.1: a command the app issues, `agentRisk: 'never'`, never a tool), policy mutation of `always` entries is allowed via `codex.write` but flagged in the plan card ("always-include affects every generation call").

### 7.1 The writer's batch import (`codex.importBatch`)

The agent's `codex.import` keeps its 20-entry cap, which bounds one plan card. An import the writer runs in the app (a CSV of characters, a Kanka campaign, a Scrivener Characters folder) can hold hundreds of entries, and they belong in one Undo with the Research pages that hold their full text. That is a command of its own, `codex.importBatch` (command-bus §9), on the `shot.importImages` precedent: the bus has no multi-command user group (timeline.md §0), so one user batch is one batch command.

- **One command, one undo group.** Up to 5,000 entries and 5,000 pages. Every entry is create-only and stamped `origin: 'import'`. One Undo removes every entry and every page the import made.
- **The two-layer pattern.** Each entry attaches to the one document whose text names it and cites the first passage that does (≤ 300 characters, UTF-16 offsets into the body, as §2). That document is an existing one (`attachTo`) or a page the same command creates (`page`), under research unless the caller names another folder. A long article goes onto the page; the entry's description is its summary, cut at a paragraph boundary to 2,000 characters, with the cut stated in the preview.
- **Validated whole, listed per entry.** Every entry is checked before anything is written, and every failure is listed with the entry's name and the reason: §2's limits (name ≤ 120, aliases ≤ 10 × 64, description ≤ 2,000, keywords ≤ 32 × 64, exclusions ≤ 20 × 64), the type and policy enums, the document or page, the citation's text at its offsets, and collisions.
- **Never a merge.** A name or alias equal, case-insensitively, to an existing entry's name or alias, or to another entry's in the same import, is refused and names the holder. The writer answers each collision in the preview: **Skip** (nothing is made), **Rename** (the name gets the source in brackets, "Hamlet (Kanka)", and an alias that still collides is dropped), or **Import as page only** (the page is made, no entry). No answer and no path merges two entries.
- **Include policy.** The writer's choice in the preview stands. Without one, an entry the source marks private, secret or GM-only defaults to `manual`, and so does one the import scan (issue #54) flags in its name, description or page; everything else is `detected`. The scan changes no text.
- **Who builds it.** The harness's `planCodexImportBatch` turns a reader's rows into the command: it fits the fields, applies the collision answers, locates each citation by §4's rules (a renamed row by the name its source used), runs the scan, and checks the result with the bus's own validate, so the preview lists every refused row before **Import** is offered: a refusal of an entry or a page is listed against the row that brought it, and a refusal of the whole command (the folder the pages go into) is the plan's own `batch` line, never pinned on a row. Nothing is written until the command is dispatched; a cancelled preview changes nothing.
- **Not an agent tool.** The descriptor is `agentRisk: 'never'` and the command is on the harness's never-exposed list, so neither the agent nor the MCP server can issue it.

The preview dialog that drives it (imports epic) is not in this build; the command and the plan are.

## 8. UI surfaces (v0.1 scope)

- **Codex panel** (left-rail peer of binder): list grouped by type; search box; entry editor (name, aliases chip-input, type dropdown, include-policy 4-state selector, description markdown textarea, keywords, attachments list); mention counts per entry (from caches, refreshed on doc writes).
- **Inspector:** "Codex" section on document nodes — chips for entries attached to this doc (+ attach picker), and mention chips (entries detected in this doc, click → codex panel entry).
- **First-run:** empty codex shows the guided seed card: "Let the agent draft entries from your manuscript" → one-click `codex.write` plan (the bootstrap path, minimal form; full bootstrap wizard = v0.2 backlog).
- Out of scope v0.1: editor underline highlighting, heatmap, relations editor, detail fields.

## 9. Evals hooks

- Detection unit fixtures: boundary cases (Latin vs CJK), case-sensitivity, exclusions, plural rejection.
- Scenario coverage added to the harness suite (agent-harness §9): mention pulls entry into `scene.draft` context; `never` policy excludes despite mention; `always` present without mention; budget prune determinism (fixed entries + tiny budget = stable drop list); `codex.write` batch validation failure → plan card rejects before execution.

## 10. Assumptions & open questions

| # | Assumption | Status |
|---|---|---|
| K1 | 6-type fixed enum suffices for v0.1 (custom types v0.2) | Explicit; type matters for sort order + UI grouping only. |
| K2 | No relations graph in v0.1 | Needs prompt-preview debugging tool first (we have it — revisit v0.2 with usage evidence). |
| K3 | Naive cached scan is fast enough at 100 entries × 120k words | **Evidence-backed** — `indexOf` beats AC below ~70 keywords; escalation trigger: p95 pass >100 ms or >500 terms. |
| K4 | Provenance fields (`origin`, `sources`) are additive in format v1 | **Resolved** — same argument as `codex[]` absorption (no wild artifacts pre-implementation); front-matter gains `origin` + `sources` (quote ≤ 300 chars, offsets as stored); loaders tolerant of their absence. Hand-authored outranks agent-inferred on conflict (coherence.md §4.3). |
| K5 | `@`-style inline mention syntax in prose text stays out of v0.1 | Codex detection is name-based; inline annotations stay plain text outside the AST (editor-engine.md §13 D2); mention *styling* (v0.2) is a decoration pass off the mention cache. |
| K6 | Exclude terms match contextually **at the match site**, never scene-wide | **Evidence-backed (StoryLine LinkScanner):** a shipped fix — an exclude term occurring anywhere in a scene used to suppress ALL matches in that scene; the fixed engine collects match positions and checks each occurrence's surroundings. Caotang's §4 rule 4 ("occurrences inside any phrase occurrence are dropped") is already per-occurrence; this row pins the contract: exclusion is evaluated **at each match site**, and a codex entry's `exclude[]` can never silence a hit elsewhere in the same document. Fixture: exclude-term-present-but-unrelated → hit survives. |
| K7 | Auto-aliasing guards: title words and connector words are never auto-first-names | **Evidence-backed:** StoryLine maintains explicit `TITLE_WORDS` (lady/lord/sir/dr/captain/king/… 60+ entries) and `CONNECTOR_WORDS` (of/the/de/von/…) sets so "Lady of Dreams" never auto-aliases as "Lady" (their issue #228). Caotang rejects auto-aliasing outright — this row records the false-positive corpus the boundary rule must beat and keeps the word-lists as documented reference data if a naive `+s`-style suggestion feature ever extends to title-splitting. |
| K8 | Per-scene "ignored detections" is the validated UX for suppression, v0.2 candidate | **Evidence-backed:** StoryLine's `Scene.ignored_detections[]` (issue #89 — "false-positive detected links cluttering the inspector") persists per-scene which detected names the user explicitly ignored, fixed in 1.10.8. Caotang v0.1 has no editor-side detection UI; when mention underlining lands (v0.2), suppression = an additive per-doc list consulted at cache build, never mutating entries. Queued with the editor-decoration work. |
| K9 | Series/shared-codex scope = `books:`-style opt-in list with ids that survive promote/demote | **Evidence-backed:** StoryLine's series mode (v1.9.5+) marks per-entity scope via an optional `books:` frontmatter list — **empty/missing = appears in every book** (fully backwards compatible) — with explicit Promote-to-series / Demote-to-project moves and optional per-book codex folders; series identity = stable UUIDs (`seriesUuid`/`bookId`) in `series.json`. Confirms codex-panels.md §3's recorded constraint: entry ids stay globally unique per install, file names carry no project-local assumptions, and a future series layer is an opt-in scoping list rather than a restructure. Multi-book itself stays a later product question. |
| K10 | The mention cache is the right substrate for a navigable **mentions browser** (v0.2) | **Evidence-backed:** Novelcrafter's Mentions tab is exactly a UI grouping over the same deterministic detection engine — per-entry occurrence lists across five content-type groups (manuscript prose / scene summaries / codex entries / snippets / chat threads), grouped with snippet excerpts + highlighted matches, plus a header **distribution bar** (per-doc counts ordered by binder sequence) whose stated fiction use is spotting where a character "drops out of the story unexpectedly" — precisely the continuity-scan reading the coherence module specifies. Caotang's `MentionIndex` already computes per-doc counts; a Mentions-tab UI (grouped occurrence browser + header sparkline) is a **projection over the existing cache — zero new detection passes** (same pattern as codex-panels.md §1's appearance view). Codex→codex references ("which entries mention this entry") come free by running the same detector over entry descriptions. **The only genuinely new surface is chat threads as a browsable corpus** — v0.2, requires chat transcripts to become indexed docs (a project-format note, not a new engine). Detection mechanics confirmed identical: same name/alias matching, case-insensitive default with per-entry case-sensitive mode, **auto-pluralisation English-only**, index **derived and recomputed on alias change** (never manually maintained — matches our revision-stamped cache invalidation, codex.md §4). Series scope re-confirmed from the second vendor: entries carry a book/series scope tag with move ops and All/Series/Book panel triage tabs (K9's `books:` shape, now evidenced twice; multi-book stays a later product question). No v0.1 change. |
