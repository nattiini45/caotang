# Binder filters — saved queries over the binder tree (v1)

> Status: built.
> Cross-refs: manifest storage = [project-format.md](project-format.md) §2 (`filters[]`, additive) · view rules + binder view contract = [ui-modules.md](ui-modules.md) §2 · commands = [command-bus.md](command-bus.md) §9 (registry additions) · body projection (text search coordinate system) = [project-format.md](project-format.md) §3.

## 1. Responsibility & boundaries

- A filter is a **named, saved conjunction of criteria** evaluated against binder nodes. Matching is a pure read-side function: **filters mutate nothing** — the result is a view over the tree (same discipline as the corkboard: no commands of their own beyond saving/managing the queries themselves).
- What filters are NOT: not a query language (rejected, §6), not a Tier-1 agent tool (the model reaches the same answers via `binder.read_tree` + `doc.read`; the only agent tool is the deferred, allowlisted `filter.save`, agent-harness §3, which saves or changes a filter and has no delete), not a search UI for document *content* beyond the text criterion (full-text search with result excerpts = polish backlog).

## 2. Data model

```ts
interface SavedFilter {
  id: string;                      // "q_" + 10 chars Crockford base32 (same generator family as node/codex ids)
  name: string;                    // ≤ 60 chars; display label in the rail; uniqueness not enforced (ids are handles)
  root?: 'manuscript' | 'research'; // scope restriction; absent = both roots searched
  criteria: FilterCriteria;        // conjunction of present fields (§3)
  createdAt: string; updatedAt: string;   // ISO-8601
}

interface FilterCriteria {
  text?: string;                   // case-insensitive substring (Unicode case folding), ≤ 200 chars
  textIn?: ('title' | 'synopsis' | 'body')[];   // which surfaces `text` searches; default = all three
  statusId?: string;               // vocabulary status id, exact match (null value = criterion absent)
  labelId?: string;                // vocabulary label id, exact match
  keywordsAll?: string[];          // node must carry ALL of these (case-insensitive tag match)
  keywordsAny?: string[];          // node must carry AT LEAST ONE
  minWords?: number;               // word-count lower bound
  maxWords?: number;               // word-count upper bound
}
```

Field contracts:

| Field | Contract |
|---|---|
| `criteria` | Empty object `{}` matches everything (the reset state). Conjunction across fields; `keywordsAll` and `keywordsAny` may coexist (both must hold). |
| `text` | Searched in the surfaces listed by `textIn` (default all): `title` = node title, `synopsis` = node synopsis, `body` = the **body projection** (project-format §3 — same coordinate system as `doc.read` and mention detection). Substring, case-insensitive, no word boundaries (a filter for "elena" may match "Elena's"). |
| `statusId` / `labelId` | Must exist in the project vocabulary **at save time** (validated like `binder.setMeta`). On load, a criterion naming a since-deleted vocabulary id is kept but matches nothing — the saved filter row shows an "unknown status" warning chip (same posture as unknown status values on nodes, project-format §2). |
| `keywords*` | Case-insensitive exact tag match against `node.keywords` (max 32 × 64 chars per node — project-format §2). |
| `minWords` / `maxWords` | Documents compare their own `derived.wordCounts` entry (allowed stale, recomputed on open); **folders compare their subtree sum** (sum of descendant document counts) — this keeps "find long chapters" and "find stub scenes" both expressible. |
| Limits | ≤ 50 saved filters per project; each criteria array ≤ 32 entries; `text` ≤ 200 chars. Save-time clamps. |

**Dates are deliberately absent from v0.1 criteria** (Caotang tree nodes carry no per-node timestamps; Ulysses' date filters query sheet creation/modification dates). The v0.2 date-criteria package is priced and specified in **§2.1** (per-node `createdAt`/`updatedAt` manifest fields + two relative-window criteria keys); v0.1 unchanged.

### 2.1 Date criteria

Evidence: Ulysses treats sheet dates as first-class filter criteria ("If you select Creation Date or Modification Date, you can specify the time frame") and the taught flagship use is the relative window — *"Modification Date is Newer than Seven Days"* (The Sweet Setup's canonical "Active" smart filter). No vendor ships date-filter UI over planning entities — dates filter *sheets/documents*, not story metadata.

1. **Manifest (v0.2, additive in format v1):** `tree[]` nodes gain `createdAt` / `updatedAt` (ISO-8601, same convention as `project.createdAt`/codex entries). Maintained by the app, **not user-editable** in the first pass — **field-checked**: Ulysses is the only surveyed vendor shipping date correction at all, and only for **creation** dates ("Adjust Creation Date" in the Dashboard; TidBITS: "you can change the creation date, though not the modification date"), motivated by import/migration breaking creation dates; no other vendor (Dabble/LivingWriter/Scrivener/Aeon/StoryLine) exposes editable node dates; no vendor treats structural moves as content mutations. The assumption is therefore *checked against the field*, not assumed. `createdAt` set once at `binder.create`; `updatedAt` bumps on every content-touching mutation (`binder.rename`, `binder.setMeta` incl. synopsis/status/label/keywords, `notes.set`/`notes.append`, doc body writes) — **not** on reorder/reparent (structure ops don't modify the node's own content, and "what was I working on" must not light up every scene an agent moved). **`updatedAt` stays app-owned unconditionally** (no vendor contradicts; editable modification dates would corrupt the recency-filter semantics). One-line forward note (v0.3-gated, additive if import flows ever land): a node-info "Adjust Creation Date" affordance (Ulysses' exact pattern, minus the Dashboard complexity) is the cheap escape hatch for migration-hygiene; recorded, not specced.
2. **Criteria keys (v0.2):** `createdWithinDays?: number` (positive int; `node.createdAt` within the last N×24h of the injected `now`) and `modifiedWithinDays?: number` (positive int; `node.updatedAt` within the last N×24h of the injected `now`) — added to `FilterCriteria` as optional keys, same additive discipline as every other criterion.
   Rolling windows (not calendar-day buckets), `now` **injected** — same determinism contract as `goalProgress` (goals-progress §2.2). Absent timestamps (older manifests) → the node simply doesn't match date criteria. Folders evaluate their own node timestamps. Composes with the existing conjunction semantics; limits unchanged.
3. **Absolute date ranges** (`createdFrom/To`-style pickers) = documented v0.3 option only if usage demands — the validated shape is relative recency, and pickers add timezone UI without demand evidence.
4. **Evals (v0.2):** window boundary (exactly N×24h inclusive/exclusive), absent-timestamp nodes never match, the `updatedAt` bump matrix per command, injected-`now` determinism (same project state + criteria + now = same result set).

## 3. Matching semantics (pure function, headless-testable)

```ts
matchNode(
  node: BinderNode,                          // tree entry (excluding reserved roots — never matched, never hidden)
  probe: { bodyOf(docId: string): string;    // body projection accessor
           wordsOf(nodeId: string): number } // own count for documents, subtree sum for folders
): boolean
```

- Evaluate every present criterion; ALL must hold (conjunction). First failing criterion short-circuits.
- `bodyOf` is only invoked when `text` is present with `'body'` in `textIn` — filtering without text criteria never touches document bodies (word counts come from `derived`).
- Deterministic, no wall-clock, no randomness — same project state + criteria = same result set (eval-stable, same contract as context assembly and mention detection).
- **Result-set rule (view):** matching nodes are shown **plus their ancestor chain** (a matching scene renders inside its chapter); non-matching siblings hide. The reserved roots (`manuscript`, `research`) always render. A match-count badge ("N scenes match") shows on the active filter row.

## 4. Storage (manifest `filters[]`, additive)

- Saved filters change only through `binder.saveFilter` and `binder.deleteFilter` (§5). **A saved filter found in the app database is moved once into the project, through those commands, and marked as moved; the app-database copy is not deleted**.
- Top-level `filters[]` array in `caotang.json`, same fixed-key-order discipline as `tree`/`codex[]`. **Additive in format v1** — no `formatVersion` bump (same argument as `codex[]`/`recipes[]`/`coherence.json`: no wild artifacts exist before implementation). Loaders tolerate absence; absent = no saved filters.
- Load-time tolerance: unknown criteria keys are dropped with the one-time unknown-field notice (project-format §6 rule); dangling `root` values impossible (enum); malformed criterion objects → the whole filter is dropped with a load warning (a broken saved query must never block a project load).

## 5. Commands & UI

**Command-bus §9 registry rows for the saved filters (two of the furniture commands; `binder.saveFilter` is also the deferred agent tool `filter.save`, agent-harness §3; `binder.deleteFilter` is not an agent tool):**

| Command | Params | agentRisk | undo | Notes |
|---|---|---|---|---|
| `binder.saveFilter` | `{filter: {id?, name, root?, criteria}}` | write-auto | inverse | Create (id generated) or update-by-id (rename / re-criteria). Vocabulary ids validated at save; limits clamped. Kept in the manifest's `filters[]`. |
| `binder.deleteFilter` | `{filterId}` | write-auto | inverse | Removes a saved query — metadata, not content; inverse restores it. (Not the `delete_node` 0-to-1 case: nothing irreplaceable is touched.) |

The active filter is **not a bus command**. The draft a writer types, and the saved filter a writer applies, are the desktop's view state, held by the furniture store (`apps/desktop/src/app/furniture-store.ts`). They are never persisted and never undo-registered. There is no `view.setBinderFilter` command.

**UI (binder rail — extends ui-modules.md §2):**

- **Filter bar** in the binder header: live text input (debounced 150 ms — view-only, no autosave interplay) that writes an ad-hoc `{text}` criteria set into the furniture store's filter draft; plus a saved-filter dropdown and "Save current…" (prompts for name → `binder.saveFilter`).
- **Filters section** below the tree: saved filter rows (name + match-count badge when active). Click = apply (highlight active row); context menu: Rename, Edit criteria (re-opens the bar pre-filled), Delete (`binder.deleteFilter`). 
- **Active-filter indicator:** the filter bar shows the active criteria and a Clear affordance; an active filter is always one click from "show everything" (never a hidden state).
- **Empty result state:** "No scenes match — Clear filter" (actionable empty-state rule, ui-modules §0.3).
- Keyboard: `Ctrl+Alt+F` focuses the filter input. `Ctrl+Shift+F` stays focus mode, which shipped first and is in the user guide. The chord is supplementary, not part of the core §2.5 Playwright set.

**Playwright trace (the eval bar):** type text → tree narrows (assert visible node ids) → save named filter → row appears → reload → click row → same result set → delete row → manifest `filters[]` empty. Plus: filter by `statusId: draft` after `meta.set`-ing one scene — exactly that scene + ancestors visible.

## 6. Evals (headless)

- **Matching fixtures** per criterion and in conjunction: text-in-title vs text-in-body (body projection — front matter never matches); status/label unknown-id behavior; keywordsAll/Any; min/maxWords on documents vs folders (subtree sums); empty criteria = match-all.
- **Persistence fixtures:** save → manifest `filters[]` shape; load without the array → none; unknown criteria key → dropped with notice; malformed filter → dropped, load proceeds.
- **Trace fixtures:** the Playwright sequence above; the filter draft never appears in undo-all assertions, because it is view state and is never undo-registered.

## 7. Rejected alternatives

- **Dataview-style free-form query language** — power beyond the validated pattern, at the cost of grammar design, injection-shaped edge cases, and eval instability; the market's validated shape (Ulysses filters, Scrivener saved searches) is named criteria, not a language. Revisit only with concrete usage evidence — the parallel verdict on saved **codex** queries was **rejected with all vendors checked** (no vendor ships them; browse-and-filter + the Mentions tab is the codex answer surface), and the same posture extends to a filter grammar here.
- **A `filters.*` family of agent tools** — the Tier-1 band stays 14; the one agent tool is the deferred, allowlisted `filter.save` (agent-harness §3). No read tool (`project.overview` lists the filters) and no delete tool; the model composes `binder.read_tree` + `doc.read` to answer the same questions.
- **Dynamic/smart collections that auto-appear in the tree** — blurs the binder's tree of sections, folders and documents; filters are a rail-level view, not tree nodes (one metadata shape everywhere, and no new node kinds for views).

## 8. Assumptions

| # | Assumption | Status |
|---|---|---|
| F1 | Six criteria families (text/status/label/keywords/word-bounds) cover v0.1 | Evidence-backed (the surveyed Dataview use case = status/keyword queries). Date criteria priced for v0.2 — §2.1 (two manifest fields + two relative-window keys). The §2.1 timestamp semantics are field-checked (no vendor exposes editable node dates except Ulysses' creation-only correction; structure-ops-don't-bump-updatedAt stands uncontradicted) — v0.3 "Adjust Creation Date" escape hatch recorded as a note. |
| F2 | Stale `derived.wordCounts` is acceptable for word-bound filters | Explicit — same staleness contract as binder rows; recomputed on open (project-format §2). |
| F3 | ≤ 50 saved filters suffices | Explicit clamp; no project-scale evidence either way, trivially raisable. |
| F4 | Filtering is instant at v0.1 scale (≤ ~500 nodes) | Explicit (ui-modules §7 posture); text criteria touch bodies only when present. |
