# Dialogue narrative — branching game-narrative authoring on Ink (post-v0.1)

> Status: built, except where a section says otherwise.
> Scope: Biggest data-model lift in the track (graph + conditions + localization) — sequenced last (media-track §3). Attaches to `project-store` (node kind + Ink file), `corkboard` (graph-view variant), `exporter` (Ink + dialogue table), `coherence` (deterministic graph checks), `codex` (speaker resolution).
> Cross-refs: node kinds = [project-format.md](project-format.md) §2 media note · findings model = [coherence.md](coherence.md) §3/§5.1 · exporter seam = [exporter.md](exporter.md) §2/§3 · harness registry = [agent-harness.md](agent-harness.md) §3 · loc shape = [dialogue-narrative.md](dialogue-narrative.md) §6.

## 1. Verdict (adopted)

- **Ink is the authored/interchange format** — ownable plain text (files-ownable invariant holds), strongest ecosystem proof, maintained JS runtime+compiler (inkjs), engine coverage (Unity/Godot/Unreal). **Caotang authors Ink; engines consume compiled story JSON. Caotang never builds a scripting language** — Ink/Yarn already *are* the scripting layers; articy's expresso + simulation is a product-scale feature set deliberately under-built (rejected).
- **Yarn (Twee 3) = v0.3 import candidate; articy JSON = read-only import reference; Twine import strips logic with an honest report** (StorySplice pattern: report the stripped-macro count — "branch structure is portable, conditional logic is not").
- **Line-ID discipline is the one contract to spec early** — it is what makes localization and VO both work downstream (§6).
- **Reject:** any Caotang-side runtime/simulation of branch logic in the first landing (inkjs *validation* is in; *execution/play mode* is a v0.3 candidate recorded below).

## 2. Data model

### 2.1 Node kinds

```ts
tree[].type: 'dialogue'           // a dialogue container (one cutscene/conversation) — the "dialogue tree" container
tree[].kind: 'branching'          // marker on that container (graph-view trigger)
tree[].type: 'beat'               // a beat/line node inside a dialogue container (leaf of the graph) — the dialogue package's vocabulary names it, but no binder command creates one (see below); the binder holds the container only
```

- **Dialogue container = a document-like node whose body file is raw Ink** (`docs/<id>.ink`). the Ink body has **no front matter**: the file is raw Ink and valid Ink on its own, and it is written under the node's kind, not as `.md` (project-format §3). An older `.md` container still loads, and the next save writes the `.ink` file. `binder.create` makes a dialogue container with `type: 'dialogue'`; its kind defaults to `branching`, so the `kind` key is optional for it (command-bus §9). The Ink editor saves through `doc.write` on the autosave; adding line ids is a confirmation followed by the same write, so it needs no command of its own. **Decision (the data model is Ink-native):** the branch structure lives in the Ink text itself (knots = beats, diverts = links) — **the binder holds the container, not per-beat nodes.** Rationale: Ink's own text is the proven authoring surface (Inky), per-beat binder nodes would fight the weave structure (gather/threads/inline diverts don't map to a tree), and the graph view reads the *parsed* Ink, not a parallel node graph (single source of truth, ownable files). Rejected: beat-per-node tree model (articy-shaped; double bookkeeping with the Ink file; breaks round-trip).
- Container metadata (per-kind metadata, additive): `speaker?: string` (codex entry id — default speaker), `locBaseline?: string` (locale code of the authored language, default project `language`), `engineTarget?: 'ink-json' | 'yarn-csv' | 'generic-csv'` (the default compile target hint; recipes carry the truth).

### 2.2 Ink authoring contract

- **Body = valid Ink.** Caotang adds no syntax. Structural validation (loose ends, dead ends, unknown diverts) runs **inkjs compile in-browser** (zero deps, MIT) on save/autosave and on export; compile **errors/warnings surface as deterministic findings** (§5) — the same findings-inbox UX as coherence, zero new check classes.
- **Line IDs (minted by Caotang, never hand-typed):** every line that will be spoken/exported may carry a `# lineId: l_XXXXXXXXXX` tag; Caotang's save path can add tags automatically when the dialogue table export is used (opt-in per container: `autoLineIds: true`), minting `l_` + 10 Crockford base32 (same generator family as node/codex ids) **stably per line** — ids persist across edits of the line's text, die with the line (no reuse). This is Caotang's `#line:`-class contract (Yarn's shape, vendor-neutral).
- **Speakers:** `Speaker: text` lines resolve against codex characters (cue-style, like screenplay.md §4 — a mention source); unresolved speakers are the `script.cue-collision`-class info finding (§5).
- **Variables/conditions:** authored in Ink text as-is; Caotang's UI may *display* declared variables (parse pass lists `VAR`/`LIST` declarations) but **v1-of-track authors logic only in text** (no visual condition builder — articy ceiling rejection). Yarn 3's `when:`-header storylet pattern recorded as the **v0.3 storylet idea** (conditions-as-template-fields covers the 80% case first).

### 2.3 Parse layer (ink-shaped, Caotang-owned)

```ts
interface DialogueGraph {         // derived view over the Ink body (never stored separately)
  nodes: GraphNode[];             // { id: knot[.stitch], kind: 'knot'|'stitch', lines: Line[], choices: Choice[], diverts: Divert[] }
  choices: { from: nodeId; label: string; target: nodeId | 'END' | 'divert'; condition?: string; onceOnly: boolean }[];
  variables: { name: string; default: string }[];   // declared VARs, parse-derived
  warnings: ParseWarning[];       // loose ends, dead ends, unknown diverts — inkjs compile output mapped to findings (§5)
}
```

- The graph is a **projection** (codex-panels.md §2's `appearances` pattern): computed from the Ink text, never stored; recomputed on doc write (cache invalidation, codex.md §4 discipline).
- **Validation = inkjs compile** (the reference compiler's own loose-end/dead-end checks) — Caotang adds zero bespoke graph validators in v1-of-track.

## 3. Editor integration

- Raw-Ink text editing + **syntax decoration styling** (the screenplay.md §3 pattern, same decision & rationale: text-first editing, decoration styling from the parse, no Ink-typed PM schema in the first landing; revisit trigger identical). Ink is already plain-text-native (Inky's model), so no "live margins" analog is needed.
- **Graph view = corkboard variant over the parse** (§1 verdict; the media track's "graph view alongside corkboard"): nodes as cards on a laid-out canvas (auto-layout: layered top-down by graph distance from the entry knot — pure function, deterministic), choice labels as edges; click = jump to the knot's line in the text (view state, `view.setGraphFocus` — view class, ephemeral). **View-only: graphs are not editable canvases in v1-of-track** (editing happens in Ink text; articy-style drag-wiring is the rejected ceiling). Layout is a pure projection with a stable seed (eval-stable).
- Inspector: container metadata (default speaker picker, engineTarget, autoLineIds toggle) + parse-derived stats (knots, choices, warnings count). Beat-level editing stays in text (§9 A1).

## 4. Export (two renderers at the exporter seam)

- **Ink passthrough:** the container's Ink body compiles (inkjs) → **compiled story `.ink.json`** emitted per container (engine consumption target; engines consume compiled JSON). `format: 'ink-json'` at the exporter seam; compile log includes inkjs compile warnings verbatim (the acceptance gate: **0 errors**; warnings listed).
- **Dialogue table (`DialogueTableRenderer`, CSV/XLSX at the spreadsheet gate):** the universal engine/loc surface — columns `lineId, speaker, text, context, charLimit` (consistent with VO; Yarn/Ink-tag/Netflix all conform). `context` = knot path + codex-resolved speaker display name; `charLimit` = a **recipe option** (exporter.md §2; set in the export dialog's Character limit field, or in `recipe.save`'s options): a subtitle-style constraint when set, a whole number from 1 to 10000 (e.g. 42 chars — Netflix spec class); empty = unconstrained. Scope = selected containers; binder order.
- **Import (v0.2-of-track):** whole-story `.ink` import → container per top-level knot-cluster (knot → section folders where depth warrants — the screenplay.md §2.2 structure-mapping discipline); Twee 3 import (v0.3 candidate): passages → knots, links → choices, **macros/logic stripped with the honest per-story report** ("N logic blocks stripped — Twine story formats are programming environments").
- **Engine target and locale in the exports (as built).** The recipe's format carries the truth; the container's settings shape what that format writes (§4.1).

### 4.1 Engine target and locale

- **`dialogue-csv`.** Each container's `engineTarget` picks the file its rows go to. `yarn-csv` → a Yarn Spinner strings file, `<base> (dialogue, Yarn).csv`. `generic-csv`, `ink-json` or no target → the dialogue table, `<base> (dialogue).csv`. A selection with both kinds writes both files; the gate (§6) runs over all rows first.
- **The dialogue table** appends a `locale` column after §6's five columns. Each row's locale = its container's `locBaseline`, else the project's `language`, else empty (the log notes an empty locale). The locale cell gets the formula guard like `speaker`, `text` and `context`, because both sources are hand-editable strings in the project file.
- **The Yarn strings file** uses Yarn's columns, `language, id, text, file, node, lineNumber, lock, comment`: `language` = the row's locale; `id` = `line:` + the line id; `text` = `Speaker: text` for a spoken line with a speaker name (codex display name, else the typed name, else the default speaker's name), the bare label for a choice; `file` = container title; `node` = knot path (empty above the first knot); `lineNumber` = the Ink line; `lock` = empty (Yarn computes it from Yarn source, which Caotang does not have); `comment` = the table's `context`. No `charLimit` column; a set limit is noted in the log. Same RFC 4180 writer, UTF-8, CRLF, and formula guard on `language`, `text`, `file` and `comment`; Yarn Spinner reads a guard apostrophe as part of the line (a known limit).
- **`ink-json`.** The compiled JSON is inkjs's output, unchanged by target or locale. A container with its own `locBaseline` is written `<title>.<locale>.ink.json`; without one, `<title>.ink.json` (the project language names no file). Every container compiles whatever its target; a container whose target is a table gets a log note, and so does an `ink-json` container in a `dialogue-csv` compile.
- **Not affected:** the `dialogue.table` tool (§7) returns §6's columns; the Compile dialog does not preselect a format from the target.

## 5. Coherence: deterministic graph checks (zero model calls)

Rides coherence.md §5.4's spec-change rule; all three are pure graph arithmetic over the parse + inkjs warnings mapped to findings:

| checkId | type | severity | Source | Algorithm |
|---|---|---|---|---|
| `branch.loose-end` | unended flow | warning | inkjs warnings | Ink's own "apparent loose end" → finding naming the knot (engine validation, findings packaging) |
| `branch.dead-end` | unreachable node | info | graph projection | Node with zero incoming diverts/choices (not the entry knot) → "unreachable" |
| `dialogue.speaker-unknown` | codex hygiene | info | parse speakers + codex | A `Speaker:` name matching no codex entry → info prompting codex creation (the `pov.coverage` pattern) |

VO/loc completeness ("every line has an id when the table is exported") is a **validator at export**, not a finding class (§6).

## 6. Line-ID & localization contract (the early-specced discipline)

- **Shape:** `lineId, speaker, text, context, charLimit` (CSV; UTF-8, RFC 4180 quoting). One row per speakable line (dialogue lines + choice labels — choice labels carry their own ids, suffixed `_c`).
- **Stability contract:** ids mint once per line, stored in the Ink tag; line text edits never change the id; deleting a line retires the id (never reused); renaming a container never touches ids. Localization = translate the CSV against stable ids → string tables (Yarn's documented loop, vendor-neutral).
- **VO:** the same table is the VO script (speaker + text + id = the auditionable/recordable unit; per-vendor audio extensions stay vendor-side — the WTWTLW dual-use precedent).
- **Spreadsheet stack (XLSX) decision** is shared with the storyboard shot-list (storyboard.md §8) — one decision, two consumers.

## 7. Harness tools (the track's rows 22 and 23; the registry holds 26 rows, agent-harness §10)

The numbers in the first column are the track's own, as this spec gives them, and they are not positions in the registry. The MCP server lists `dialogue.table` (read) on every server and does not list `dialogue.draft`, which needs a model provider the server does not hold (mcp-server README).

| # | Tool | Risk | Params | Semantics / Effects | Undo | Errors (model-facing) |
|---|------|------|--------|---------------------|------|----------------------|
| 22 | `dialogue.draft` | write-confirm | `doc: string` (dialogue container or screenplay doc), `instruction: string`, `fromBeats?: string[]` (knot ids to continue from), `target_lines?: number` | Drafts dialogue beats as **Ink text** (knots/choices/conditions in Ink syntax) and writes into the container's body (append at knot, or into the empty container). Context assembly: standard stack, L4 = prior beats' one-liners; L2 = codex of the resolved speakers. Plan card: proposed Ink block (preview = artifact). Compile-validates the proposed Ink **before approval** (§2.3 warnings shown in the card — approve-with-warnings is explicit). | one undo group | Doc not a dialogue container → names the kind; proposed Ink with compile *errors* → card blocks (warnings don't block); fromBeats unknown → lists parse-derived knots. |
| 23 | `dialogue.table` | read | `doc: string`, `format?: 'csv' \| 'json'` (default 'csv'), `includeConditions?: boolean` (default false) | Returns the dialogue table (§6) for the container in the response (capped 8k tokens; larger → suggests `export.compile` for the artifact). Read-only — no artifact written. | — | Container without parseable Ink → the compile error verbatim. |

`export.compile` gains `'ink-json'` (+ dialogue CSV rides the renderer enum); export-time line-id minting is confirm-gated like every export (exporter §5). **Play/test mode (inkjs runtime "play the branch") = v0.3 candidate** — recorded, not specced; it is a reader UI over inkjs, additive when wanted.

## 8. Evals (headless, mock provider)

- `dialogue.draft` fixtures: mock Ink → proposed-beats assertions (knot/choice shapes, condition strings verbatim, line-id minting determinism); inkjs error → card rejection; warnings → explicit approve-with-warnings path.
- Graph projection fixtures: entry knot, unreachable detection, loose-end mapping to findings (severity/id/factGroup verbatim).
- Table fixtures: stable ids across text edits (mint → edit text → id unchanged), choice-id suffix, CSV escaping, charLimit column.
- Import fixtures (v0.2-of-track): Twee story → passage/choice fidelity + stripped-macro count honesty.

## 9. Assumptions & open questions

| # | Item | Status |
|---|---|---|
| A1 | Ink-text-first authoring (no per-beat tree nodes, no visual logic builder) | Explicit (§1); revisit trigger: users demand structure-level editing the text layer can't express. |
| A2 | inkjs as the compile/validate dependency (MIT, zero deps, in-browser) | Evidence-backed; vendor-if-dormant posture applies. |
| A3 | Auto line-ids are opt-in per container | Explicit; always-on minting would churn files writers hand-edit. |
| A4 | Yarn/Twee import at v0.3; articy JSON read-only reference | Explicit (§1); import-first order: Ink (v0.2) → Twee (v0.3) → articy (opportunistic). |
| A5 | Play/test mode parked v0.3 | Explicit. |