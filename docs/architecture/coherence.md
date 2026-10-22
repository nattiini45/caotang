# Coherence — plot coherence & continuity checking (media track, post-v0.1)

> Status: built.
> Cross-refs: codex data model + mention cache = [codex.md](codex.md) §2/§4 · context budgets + estimator = [context-assembly.md](context-assembly.md) §3/§5 · plan cards + AskBack = [agent-harness.md](agent-harness.md) §2 · bus/undo/permissions = [command-bus.md](command-bus.md) · body projection (the coordinate system) = [project-format.md](project-format.md) §3 · paragraph-hash reporting key = [edit-anchors.md](edit-anchors.md) §4 · exporter selection rule = [exporter.md](exporter.md) §2.

## 1. What "coherence" means here (and what it rejects)

The app **checks** the story instead of only storing it. Every check produces a **finding** — a typed, evidence-cited report item — never a silent edit, never an inline mark (inline marks belong to the editor's suggestion layer), never an automatic mutation of the outline (Aeon's auto-resolution is rejected: their own fiction template defaults it OFF, and writing reports beats moving dates silently).

**Two check classes, deliberately separated:**

1. **Deterministic** — computed from structure + codex with **zero model calls**. Cheap, testable, eval-stable, zero API cost. Covers what is *declarable*: timeline arithmetic, declared expectations, alias/identity ambiguity, presence.
2. **LLM-judged** — plausibility, motivation, knowledge-state, object continuity. Runs through the harness as a **write-confirm tool** with plan card, cost estimate, and the ConStory 4-stage evidence-grounded pipeline. Output = findings in the inbox.

Rejected alternatives: inline marks for findings in v0.1-of-track (report-first; the editor's suggestion layer owns marks); Aeon-style auto-resolution of dates (silent outline mutation); background checking while typing (universal market rejection — Bunsho's "no meter on your writing"; all checks are on-demand); a Caotang-side fact store separate from codex (see §4.3).

## 2. Module contract

- **Responsibility:** own check *definitions*, run *history*, the *findings inbox* (UI + data), and the LLM review pipeline. Execution rides existing machinery: deterministic checks read the store directly (reads are never commands — command-bus §9); LLM review is a harness tool using context-assembly + provider-gateway.
- **Owns:** `coherence.json` (findings, runs, scene metadata, review state), check registry, findings inbox UI.
- **Never:** mutates manuscript text, binder structure, or codex entries directly. A finding's fix path routes through the *existing* tools (`scene.draft` plan card, `codex.write`) — coherence proposes, the approved plan disposes.
- **Depends on:** `codex` (entries, aliases, mention caches — codex.md §4), `context-assembly` (review-pass context + estimator), `provider-gateway` (LLM stage transport), `command-bus` (the few coherence mutations), `exporter` selection rule (scope defaults, §5.1).

## 3. Data model (`coherence.json`, project-folder top-level file)

```ts
interface CoherenceFile {          // one per project; written atomically like caotang.json (temp → rename, project-format §4)
  formatVersion: 1;
  findings: Finding[];             // append/update; see §4 lifecycle
  runs: CoherenceRun[];            // append-only history, capped (§6)
  sceneMeta: Record<docId, SceneMeta>;   // per-document check inputs (§5)
  worldRules: WorldRule[];         // non-entity canon facts (§4.3) — manual rules are writer canon
  knowledge?: KnowledgeFact[];     // facts whose spread through the cast is tracked (§4.4); absent = []
  reviewState: Record<docId, { lastReviewedRevision: number; lastReviewedAt: string }>;
}

interface Finding {
  id: string;                      // "f_" + 10 chars Crockford base32 (same generator family as node/codex ids)
  runId: string;                   // run that produced/last-updated it
  class: 'deterministic' | 'llm';
  checkId: string;                 // §5 check id (deterministic) or 'llm:<category>' (llm)
  type: string;                    // stable subtype key (§5 table / ConStory subtype)
  severity: 'error' | 'warning' | 'info';
  status: 'open' | 'dismissed' | 'fixed';
  factGroup: string;               // normalized grouping key (§4.2)
  evidence: Evidence[];            // 1–2 passages; llm findings carry exactly 2
  reasoning?: string;              // evidence chain (llm class only; model-authored)
  modelMeta?: { model: string; promptTokens: number; completionTokens: number };
  createdAt: string; updatedAt: string;
  dismissedReason?: string;        // required when status='dismissed' (§6.3)
  supersededBy?: string;           // finding id that replaced this one
}

interface Evidence {               // body-projection coordinates (edit-anchors.md §2) — same system as doc.read/anchors
  docId: string;
  quote: string;                   // ≤ 300 chars, verbatim slice
  from: number; to: number;        // char offsets into the body projection
  paraHash?: string;               // cross-run reporting key only — never an apply-time anchor
}
```

- **Artifact placement:** `coherence.json` sits beside `caotang.json`. project-format §1's "no other files — loaders ignore unknown files" rule is what makes this **additive with no formatVersion bump**: an older Caotang ignores the file, a newer Caotang reads it. Manifest stays untouched (findings are derived + curation state, not structure).
- **Recovery posture:** before a changed save replaces `coherence.json`, the previous file rotates into `coherence.json.bak.1` down to `.bak.3` — project-format §4's depth for `caotang.json`. If the live file is unparseable, the corrupt file is preserved as `coherence.json.corrupt-<timestamp>` (project-format §5 pattern) and the newest snapshot that reads is restored; findings are always **recomputable** (deterministic re-run; LLM re-review is user-triggered). Only when no snapshot reads are the writer's parts lost — **dismissals, scene declarations (§5.2), manual world rules (§4.3) and knowledge facts (§4.4)** — and the load notice says exactly which. Scene declarations, dismissals, world rules and knowledge facts are hand-authored, so a snapshot is cheap insurance. The bundle carries only the live file.
- **Reconciled on open:** the file is brought into line with the project it is opened with, before anything reads it. A scene declaration on a node that is gone is dropped, and so is a finding that quotes a node that is gone, since its quote is no longer in the project; a dropped finding has a load notice. A *body* is a document or a dialogue container (dialogue-narrative.md §2.1), so a finding on a dialogue container is kept, with its dismissal, and no notice is shown for it. A found world rule whose source is gone, or whose passage no longer matches the text, goes back to review; a manual rule stays canon. A knowledge pair whose codex entry or fact is gone is dropped, with a notice (§4.4).
- **No secrets rule** (project-format §2): findings quote manuscript prose only; no provider keys/URLs ever.

## 4. Findings: grouping, runs, fact boundary

### 4.1 Run record

```ts
interface CoherenceRun {
  id: string;                      // "r_" + 10 base32
  at: string;                      // ISO-8601
  kind: 'deterministic' | 'llm';
  checkIds: string[];              // which checks ran
  scope: { docIds: string[] };     // resolved scope (§6.2)
  findingsUpserted: string[];      // finding ids created or updated by this run
  tokens?: { promptTokens: number; completionTokens: number };   // llm runs only
  model?: string;
  status: 'complete' | 'partial' | 'discarded';
}
```

## 4.2 Fact grouping (the dedupe key)

Findings about the same fact read as **one problem with citations**, not N alarms (Bunsho's grouping mechanic, adopted verbatim). Key normalization:

```
factGroup = lower( resolve(entity) + '|' + attribute )     // entity = codex entry id when resolvable, else trimmed name
```

- Deterministic checks compute the key in code (e.g. `c_5H8QK2M9RT|timeline-after-decl`). LLM verdicts propose `{entity, attribute}` (Stage 2 schema) and assembly normalizes: entity resolved against codex (exact name/alias match → entry id; no match → lowercased name), attribute lowercased/trimmed.
- All findings sharing a key render as **one group card** in the inbox with per-finding citations beneath (Bunsho: "one problem with six citations rather than six separate alarms").

## 4.3 Fact store boundary

**The assumption held:** both dedicated continuity vendors partition facts **under entity types Caotang's codex already has** (Bunsho's World tab = 4 entity groups + hand entries; PlotLens = characters/locations/timeline events/world rules) — **no free-floating fact table exists in either product**. The v0.1-of-track fact store = **codex entries** (origin provenance per codex.md §2) is confirmed as the right boundary; the coherence canon rule (manual outranks agent-inferred; fixes target manuscript, never canon) is confirmed verbatim — Bunsho's "the entry is marked as yours from then on" is the same manual-flip semantics.

**The one validated additive: `worldRules[]`** — Bunsho's World tab proves writers need free-form facts *not tied to one entity* ("the bridge is out after ch. 4", "magic costs a memory"). New top-level `CoherenceFile.worldRules` array:

```ts
interface WorldRule {
  id: string;                      // "w_" + 10 chars Crockford base32 (same generator family)
  text: string;                    // the rule, one sentence, ≤ 300 chars
  origin: 'manual' | 'found';      // manual = writer canon (Bunsho's "hand entries"); found = extracted (in review until anchored)
  source?: Evidence;               // §3 Evidence shape (quote + body-projection offsets) — required when origin='found' is promoted to canon
  verified?: boolean;              // PlotLens rule: unanchored extractions stay verified:false, excluded from canon
  createdAt: string; updatedAt: string;
}
```

Semantics: rules join `factGroup` as an additional source (an LLM finding may cite `{ruleId}` as its entity-side key; deterministic assembly normalizes rule ids into the same grouping key); `origin:'found'` rules with no clean source span **stay in review, never dressed up as cited proof** (PlotLens's honesty rule); correcting a found rule (manual edit or anchor attach) flips it to `manual` — nothing is silently overwritten (Bunsho's semantics, adopted verbatim). UI: a Rules list beside the findings inbox in the coherence panel (v0.2-of-track polish); `coherence.review` Stage 1's category-guided prompt may propose found rules in its output schema (additive field, dropped by older stage-4 code under the tolerance rule).

Bunsho's knowledge ledger ("what they know" per character over time) is built on this boundary as §4.4.

### 4.4 Knowledge facts

Bunsho's ledger, a per-character `knowsAt[chapter → fact-id]`, feeds the one checkable class the rest of the module did not cover: a character who acts on a fact before they could have learned it. The fact store §4.3 asked for exists (codex entries for what a thing *is*, `worldRules[]` for non-entity canon), so the ledger is declared on top of it. The module's rule holds: the writer declares who learns and who knows, and nothing is inferred from the prose.

**Field shapes (additive; no `formatVersion` bump):**

```ts
interface KnowledgeFact {          // a secret or piece of information whose spread through the cast matters
  id: string;                      // "k_" + 10 chars Crockford base32 (the same generator family)
  text: string;                    // one sentence, ≤ 300 chars ("Mara is the heir")
  ruleId?: string;                 // optional link to the WorldRule it restates
  entryId?: string;                // optional link to the codex entry it is about
  createdAt: string; updatedAt: string;
}
interface SceneMeta {
  // … §5.2, §5.2.1 and §5.5 fields unchanged …
  learns?: { entryId: string; factId: string }[];   // characters who come to know a fact in this scene
  knows?:  { entryId: string; factId: string }[];   // characters who act on, or reveal, knowledge of a fact in this scene
}
// CoherenceFile.knowledge: KnowledgeFact[]   (§3)
```

- **The ledger is derived, not stored.** "ANNA knows F from scene S on" is a projection: walk the scenes in story order (below) and accumulate `learns`. One declaration is one source of truth, and the ledger view (§8) cannot disagree with the check. Storing `knowsAt` on the codex entry was rejected: it would move knowledge into the manifest's codex, which is an ownable file, and split the declaration from the scene where it happens.
- **A character is a codex entry of type `character`.** The patch refuses any other entry. A group or faction that knows something is a gap the writer fills by declaring its members.
- **A scene is a document.** `learns` and `knows` are declared on a document and refused on a folder. A dialogue container does not carry them in this build, and the line a speaker says is not read from the prose or the branches.
- **Field contract (project-format §2 discipline):** a file without `knowledge`, or a scene without `learns` and `knows`, loads unchanged, as none, with no notice. A fact whose id is not a `k_` id, whose text is blank or over the limit, or whose id repeats is dropped on load with a notice that names its text. A pair that is not `{entryId, factId}` of strings, or repeats, is dropped with a notice that names the scene. An empty `knowledge` list is not written, so a build that predates the field shows no unknown-field notice for a file that holds no fact.
- **Reconciled on open (§3):** a `learns` or `knows` pair whose codex entry or fact is gone is dropped with a notice that says what was dropped. A fact whose `ruleId` or `entryId` is gone is kept, minus the link, with a notice.
- **Recovery:** the declarations are the writer's parts of the file, so the recovery notice names them with the scene declarations and manual world rules (§3).

**Story order.** "Earlier" is what the writer declared, in this order:

1. Both scenes declare `dayOffset`: story time wins, by `(dayOffset, binder position)`. A flashback in chapter 9 that shows a character learning something on day 1 is before chapter 3's scene on day 100.
2. Otherwise, two in-sequence scenes (`linear`, `simultaneous`, `time-skip`) are ordered by binder position.
3. Otherwise, two `parallel` scenes, or two `frame` scenes, are ordered by binder position within their strand.
4. Otherwise the order is **unknown**. Binder order says nothing about when a flashback, a flash-forward, a backstory or a circular scene happens, or how a scene in one strand sits against a scene in another.

**Exemption table** (its own type, `KnowledgeTreatment`, in `knowledge.ts`: `timeline.ts`'s table is keyed to the timeline checks and cannot hold this one):

| `timelineMode` | A `learns` in the scene | A `knows` in the scene |
|---|---|---|
| `linear`, `simultaneous`, `time-skip` | counts | checked |
| `flashback`, `flash-forward`, `backstory`, `circular` | counts, ordered by days only (rule 1; otherwise unknown) | checked, ordered by days only |
| `parallel`, `frame` | counts, ordered by days or within its strand (rules 1 and 3; otherwise unknown) | checked, ordered the same way |
| `dream`, `mythic` | **does not count**: the scene teaches the reader, not the character | **exempt**: nothing said there is a claim about what the character knows |

**The ledger rule, for each `knows` pair `(E, F)` in a checked scene `S`:**

1. Collect the scenes that declare `learns` of the same pair and count (the table). `S` is one of them when it declares both: a scene may teach a character a fact and show them act on it.
2. Any of them at or before `S` in story order → fine.
3. Else, any of them in an unknown order to `S` → **exempt**: the order cannot be judged, and a finding would claim more than the writer declared.
4. Else, one or more after `S` → finding, naming the earliest: `ANNA knows that "Mara is the heir" in "Scene 3", but learns it only in "Scene 7"`.
5. Else, no scene counts → finding: `ANNA knows that "Mara is the heir" in "Scene 3", but never learns it`. "Never learned" is the same check and the same finding family, not a second id: one declaration, one reason, one dismissal.

A scene that is not scanned (empty, archived, outside the Manuscript) declares nothing the check reads. The check resolves `entryId` and `factId` against the codex and `knowledge`; a pair whose entry or fact is gone is counted in the run note and not compared.

**Fixtures (the build inherits them):** knows before learns in binder order (finding), learn then know (none), the same scene teaching and acting (none); a learning flashback with an earlier `dayOffset` than the knowing scene (none, the positive control) and the same flashback without `dayOffset` (exempt); a dream that teaches (does not count, so a finding) and a dream that knows (exempt); never learned (finding, the other message); a parallel strand against the main one (exempt without days); two scenes that know one pair (two findings, one fact group); the same finding after the text around it is edited and after a second scan (one finding, same id); a dismissal with a reason that stands across a scan; a pair whose character or fact is gone (noted, not compared); a file written before the field existed (loads unchanged, no notice); a malformed fact and a malformed pair (dropped with a notice); the removal of a fact (its pairs go with it, and one undo brings them back).

## 5. Check definitions

### 5.1 Deterministic checks (zero model calls)

All deterministic checks share inputs from three already-specced sources: the **codex mention caches** (codex.md §4, per-doc `MentionIndex`), the **binder tree** (order, parentage), and **`SceneMeta`** (§5.2 below). Scan scope defaults to docs under the Manuscript root with a body (empty docs skipped with a note — exporter §2 convention); Research requires explicit inclusion. **Archived/excluded docs are never scanned** (archived-scene scanning is a known scaling problem).

| id | type | severity | Inputs | Algorithm | False-positive controls |
|---|---|---|---|---|---|
| `codex.alias-collisions` | identity ambiguity | warning | codex entries | For every pair of entries: any term (name/alias) of A equals any term of B (case-insensitive) → finding naming both entries and the colliding surface string. Alias equal to *another entry's name* resolves to the name-owner (codex.md §2 rule) — still flagged as a collision risk. | None needed — pure declaration check; fix = exclusions/aliases/renames in the codex UI. |
| `codex.never-mentioned` | detection hygiene | info | codex entries, mention caches | Entry with zero hits across all scanned docs → "never mentioned — check spelling/aliases or set policy=manual/never". | `always`/`manual`/`never` entries are exempt (presence in context isn't mention-driven). |
| `timeline.order-drift` | narrative vs chronology | info | SceneMeta.dayOffset | Sort scenes by dayOffset; compare against binder order; each adjacent pair whose relative order differs → info finding citing both scene synopses. | Only scenes with declared offsets participate; scenes without metadata are counted and reported as "N scenes unscheduled" (never violations). |
| `timeline.relation` | declared dependency violated | error | SceneMeta.after, dayOffset, durationDays | For each declared `after: [B]`: require `A.dayOffset ≥ B.dayOffset + B.durationDays` (Aeon Finish-to-Start shape, no exact timing). Violation = finding with both scenes as evidence. | Fires **only on declared relations** — the Aeon lesson: the checker validates what the writer asserted, nothing else. |
| `timeline.window` | scene outside declared container span | warning | folder-level SceneMeta.dayOffset/durationDays | Folder (act/part) with declared span: child scenes' windows must fall inside `[folder.dayOffset, folder.dayOffset + folder.durationDays)`. | Only declared windows checked; no inheritance guessing. |
| `timeline.overlap` | sibling scene windows intersect | info | dayOffset, durationDays | Sibling scenes (same parent) with overlapping windows → info ("may be intentional — parallel POVs; dismiss to record that"). | Default info, one-click dismiss; **not** an error because multi-POV simultaneity is normal. |
| `timeline.gap` | a jump in story time | info | SceneMeta.dayOffset, timelineMode | Sort scheduled scenes by dayOffset (binder order breaks ties); each adjacent pair whose later dayOffset is **7 or more days** past the earlier one's (start to start) → info finding citing both scenes and the day count, with "declare a time skip on one of the scenes, or accept the gap". `parallel` and `frame` scenes are compared within their own strand. | A pair is skipped when **either** scene is `time-skip`, `dream` or `mythic` (§5.2.1); scenes without an offset are counted as unscheduled, never compared. Info, one-click dismiss. |
| `plot.unresolved-thread` | declared payoff missing | warning · info | SceneMeta.threads, the binder tree | For each thread a scanned scene declares (§5.5): `payoff` names no document in the project → **warning**; it names a document the scan did not read (empty, archived, outside the Manuscript, or Research not named) → **info**; it names a scanned scene → no finding. The message says what the scene *declares*, never that the thread is open. | Fires only on a declared thread; it never judges whether the payoff works. A scene with no thread is counted in the run note, never compared. |
| `knowledge.leak` | a character knows before they learn | error | SceneMeta.knows, SceneMeta.learns, `knowledge[]`, dayOffset, timelineMode | For each `knows` pair in a scanned scene (§4.4): no scene at or before it in story order declares `learns` of the same pair → **error**, type `knows-before-learns` when a later scene teaches it ("learns it only in …"), `never-learns` when none does. | Fires only on a declared pair. Story order is the declared one: days when both scenes have them, binder order only where it is reliable; a learning scene whose order against the knowing scene is unknown exempts the pair, and a `dream` or `mythic` scene neither teaches nor is checked (§4.4 exemption table). One finding per scene and pair; the fact group is the character and the fact, so a re-run updates it and a dismissal (`intentional`, `false-positive`, `unreliable-narrator`) stands. |
| `pov.coverage` | declared POV not named | info | SceneMeta.pov, mention cache | Scene with declared POV whose entry has 0 hits in the scene text → info "POV never named in scene" (normal in deep/first-person POV). | Info severity; dismissal records "deep POV" convention. Unresolvable POV names (not a codex entry) → separate info finding prompting codex creation. |
| `presence.expected` | declared presence violated | error | SceneMeta.expectedPresent, mention cache | Each expected entry must have ≥1 hit in the scene text; 0 hits → error naming entry + scene. | Only fires on writer-declared expectations — the deterministic analog of a saved-search collection (Scrivener's manual baseline), not a guess. |

Deterministic findings quote the *scene* side only (evidence = the violating scene's synopsis or text slice); there is no second passage — the second side is the **declaration** (SceneMeta/codex), rendered as the finding's "expected" line.

### 5.2 `SceneMeta` — check inputs (writer-declared, never inferred)

```ts
interface SceneMeta {
  pov?: string;                    // codex entry id; free-text POV → unanchored info finding
  dayOffset?: number;              // integer days from project epoch 0 (fantasy-calendar-safe: offsets, not dates)
  durationDays?: number;           // default 0 (a scene occupies a moment unless declared)
  after?: string[];                // declared dependencies: this scene happens after these docIds (order guarantee, no exact timing — Aeon dependency shape, simplified)
  expectedPresent?: string[];      // codex entry ids that must be mentioned in this scene
  threads?: { id: string; payoff: string; note?: string }[];   // §5.5: threads this scene sets up
  learns?: { entryId: string; factId: string }[];              // §4.4: characters who learn a fact here
  knows?: { entryId: string; factId: string }[];               // §4.4: characters who act on a fact here
}
```

Edited in the Inspector (§8.2); mutations route through the `coherence.setSceneMeta` command (§7). **Real dates are deliberately absent** (day-offset integers only). **The day-offset baseline stands — Aeon's full constraint model is rejected for v0.1-of-track.** Aeon's forum evidence shows power users reduce its dependency system to Finish-to-Start chaining anyway, which `after: [docIds]` already provides (the `timeline.relation` "Aeon Finish-to-Start shape, no exact timing" comment is confirmed as the right simplification); richer shapes (typed relationship roles, arbitrary item types, per-template customization) add authoring burden before any evidence of need. The remaining dependency-type tail (Aeon's full FS/SS/FF/SF set — SS for simultaneous-POV pairs, which `timeline.overlap` currently only dismisses) is backlog for the v0.2 upgrade. Findings stay shape-stable under any future upgrade (evidence is doc+offset based). Fantasy calendars stay cosmetic: display-only epoch-label mapping ("day 12 → Year 3, Rains") is a v0.3 idea, zero check impact, no schema change.

#### 5.2.1 `timelineMode` + the exemption table

**Field shape (additive `SceneMeta` field):**

```ts
interface SceneMeta {
  // … §5.2 fields unchanged …
  timelineMode?: 'linear' | 'flashback' | 'flash-forward' | 'parallel' | 'frame'
               | 'dream' | 'mythic' | 'backstory' | 'simultaneous' | 'circular' | 'time-skip';   // absent = 'linear' (default)
}
```

**Field contract (project-format §2 discipline):** unknown value on load → treated as `linear` + one-time "unknown timeline mode" notice (enum closed; extension = spec change per §5.4). The field is writer-declared in the Inspector (mode dropdown beside the dayOffset fields); `coherence.setSceneMeta`'s `patch` gains `timelineMode?: string` (validated against the enum; unknown → error lists valid values). The field's **only** consumer is the exemption table below — no check input, no finding shape, and no `factGroup` key changes (findings model shape-stable, §11-A1).

**Exemption table (per deterministic check; `–` = checked as normal):**

| `timelineMode` | `timeline.order-drift` | `timeline.relation` | `timeline.window` | `timeline.overlap` | `timeline.gap` | `pov.coverage` / `presence.expected` |
|---|---|---|---|---|---|---|
| `linear` (default/absent) | checked | checked | checked | checked | checked | checked |
| `flashback` / `flash-forward` | **exempt** | checked | checked | checked | checked | checked |
| `dream` / `mythic` | **exempt** | checked | **exempt** | checked | **exempt** | checked |
| `backstory` | **exempt** | checked | **exempt** | checked | checked | checked |
| `parallel` / `frame` | **exempt** (per-strand date-order: scenes sharing the mode compare among themselves by dayOffset) | checked | checked | checked | checked (per strand) | checked |
| `simultaneous` | checked | checked | checked | **exempt** (the declared-intent form of a `timeline.overlap` dismissal) | checked | checked |
| `circular` | **exempt** | checked | checked | checked | checked | checked |
| `time-skip` | checked | checked | checked | checked | **exempt** (the declared-intent form of a `timeline.gap` dismissal) | checked |

- **Rationale per row:** flashback/flash-forward/dream/mythic/backstory scenes intentionally violate binder-vs-chronology order (StoryLine exempts them from date-order checks; Aeon's Backstory class is the same declaration) but their *declared relations and presence* still hold — a flashback still happens after what it references. Parallel/frame narratives keep **per-strand** date-order checking (StoryLine's per-strand mode): scenes sharing the mode are ordered among themselves, exempt only from the whole-manuscript comparison. `simultaneous` converts the most common `timeline.overlap` dismissal into a declaration (Aeon's Backstory + StoryLine's mode sets both support treating technique-declarations as data). **`circular` joins the same row as `flashback`: StoryLine's `EXEMPT_FROM_DATE_ORDER` set includes it — the second vendor precedent the landing required — while relations/gaps/continuity stay checked.** StoryLine doubly-exempts `simultaneous` from date-order (it also skips adjacent-pair comparison); Caotang's row stays deliberately more conservative (equal dayOffsets tie-sort and don't drift — the difference costs at most one info finding; recorded, not adopted).
- **`time-skip` joined the enum together with `timeline.gap` (§11 D12):** StoryLine's evidence shows `timeskip` is *not* a date-order exemption at all — its validator keeps timeskip scenes in the main-timeline order group, and the mode's only consumer is `checkTimelineGaps` (7+ story-day jump between consecutive dated scenes → info; `timeskip`/`dream`/`mythic` on either side suppresses). Caotang adopts those mechanics: threshold **7 story days** (`GAP_THRESHOLD_DAYS`, one constant), info severity, the gap measured **start to start** (the earlier scene's duration is not subtracted), and the pair skipped when **either** scene is exempt. `time-skip` has exactly one exempt cell, so a `time-skip` scene out of binder order still draws `timeline.order-drift`; `backstory` and `flashback` are not gap-exempt (StoryLine's `EXEMPT_FROM_GAP` is timeskip/dream/mythic). Scenes are compared in day order, so a gap is never negative: a pair whose binder order disagrees with the days is `timeline.order-drift`'s, and the gap check does not report it a second time (one mistake, one finding, one dismissal); a reversed pair that order-drift does not cover, because one side is exempt from it, still draws the gap note. The finding is a prompt to declare, not a rule: the dismiss dialog for a `timeline.gap` finding adds "Declare a time skip on one of these scenes instead." whichever reason is picked, and the five reasons stay as specced (§11 D11). A threshold that fits a story of weeks is wrong for one of years; a project-level or span-relative threshold was considered and left out, and moving to one is a change to that one constant. A stored checks list written before this check existed does not switch it on; the writer turns it on under Settings.
- **Migration from dismissals is never automatic:** existing dismissed findings stay dismissed; the Inspector mode dropdown is the forward path. The dismiss dialog's technique reasons (§6.3) cross-link to the mode picker ("declare this as a scene mode instead") — one line of UI copy, no migration job.
- **Open modes:** `circular` is **adopted** (same-row semantics as `flashback`; second vendor precedent = StoryLine's `EXEMPT_FROM_DATE_ORDER`, verified in source). `time-skip` is **adopted** with the `timeline.gap` check that consumes it (see the bullet above). The enum remains extensible by spec change (§5.4).
- **Eval fixtures:** each exempt mode × its exempt check → no finding (positive control); the same scene declared `linear` → finding fires (negative control); per-strand ordering for `parallel` scenes (ordered pair in-strand → no finding; out-of-strand-order → finding); `circular` scene out of binder-vs-chronology order → no order-drift finding, but a declared `after:` violation on the same scene → `timeline.relation` finding still fires (StoryLine fixture copy: its circular scenes sit only in `EXEMPT_FROM_DATE_ORDER`). For `timeline.gap`: 7 days → finding and 6 days → none; each of `time-skip`, `dream` and `mythic` on either side → none (positive control), the same pair declared `linear` → finding (negative control); `backstory` and `flashback` → finding; a `time-skip` scene out of binder order → still `timeline.order-drift`; `parallel` scenes are compared among themselves, not against the main sequence; unscheduled scenes are noted, never compared; a binder-reversed pair, under or over 7 days → order-drift only (no second gap finding); a reversed pair with an order-drift-exempt side → the gap note only.

### 5.3 LLM-judged checks — the ConStory 4-stage pipeline (as a harness tool)

Implemented as `coherence.review` (§7 tool 2). Four stages, mapped to **N+1 model calls** (Stage 3 is folded into Stage 2's output schema; Stage 4 is deterministic code, no model call):

| Stage | What runs | Model calls | Output contract |
|---|---|---|---|
| **1. Category-guided extraction** | Per scope document: one call with the 8-layer context (L2 codex **expanded to 2.5k**, chosen for this scene as codex.md §6 chooses it: `never` is never sent, `manual` only when attached to the scene or a folder above it, and `detected` only when its name or alias is in the scene text; L4 story-so-far **6k** + full focus-doc text capped 25k — the `continuity.scan` budget shape, context-assembly §3) and a fixed category-guided prompt over the ConStory 5 categories: Timeline/Plot · Characterization · World-building · Factual · Narrative Style. | 1 per doc | `{spans: [{docId, from, to, quote, category, note}]}` ≤ 20 spans/doc via `responseFormat` jsonSchemaHint (provider-gateway §5 probe-gated). |
| **2. Pairwise verification** | Candidate spans of the same category, batched ≤ 10 pairs per call; each pair gets both spans + ±200-char body context per side. Pairwise-verify-after-mining is the false-positive mechanism (ConStory's stated design goal). | ⌈pairs/10⌉ per run | `{verdicts: [{pairId, verdict: 'contradictory'\|'consistent'\|'unclear', reasoning, evidence: Evidence[2], factGroup: {entity, attribute}}]}` |
| **3. Evidence chains** | — folded into Stage 2: every contradictory verdict carries `reasoning` + both quoted passages with offsets. | 0 | — |
| **4. JSON assembly** | **Deterministic code**, not a model call: contradictory verdicts → `Finding[]` (class `llm`, severity from category table below), factGroup-normalized (§4.2), run record appended. | 0 | `Finding[]` + `CoherenceRun` |

Severity defaults by category: Factual/Detail + Timeline/Plot → `error`; Characterization/World-building → `warning`; Narrative Style → `info`. All severities are user-adjustable post-hoc via dismissal only (no per-run severity re-weighting in v0.1-of-track).

**Hard rules carried from the harness:** findings are **never** inline edits (report-only); scope text is read via the body projection; the plan card shows **cost estimate before running** (docs × extract calls + pairs/10 × verify calls, `ceil(chars/4)` estimator — context-assembly §3/§5); **never runs while typing** — like every agent turn it is a paused, reviewed act; the editor is not touched at any stage.

### 5.4 Check registry (closed for the first landing)

Deterministic: **17 checks** (`packages/coherence/src/checks/index.ts` holds the closed registry, `DETERMINISTIC_CHECK_IDS` in `model.ts` the ids). The eight of §5.1, with their severities: `codex.alias-collisions` (warning), `codex.never-mentioned` (info), `timeline.order-drift` (info), `timeline.relation` (error), `timeline.window` (warning), `timeline.overlap` (info), `pov.coverage` (info), `presence.expected` (error). Then `timeline.gap` (info, §5.1 and §5.2.1), appended so the order of the eight does not move, then the six the screen and media track adds, which the registry runs as their own rows, `plot.unresolved-thread` (warning or info, §5.5), and `knowledge.leak` (error, §4.4) last:

- **Screenplay cues** (`script.cue-collision`, info; `script.cue-consistency`, warning) and **storyboard shot coverage** (`script.shot-coverage`, info). They sit inside the coherence module because both packages are leaves below it (screenplay.md §4; storyboard.md §5).
- **Dialogue branch facts**: `branch.loose-end` (warning), `branch.dead-end` (info) and `dialogue.speaker-unknown` (info). The dialogue package depends on this module, so the app computes these over each container and passes the findings in; each id takes only its own findings. Branch checks run on full scans, and a narrower scan says in its run record that they were not run.

LLM: the 5 ConStory categories (fixed enum; subtypes rendered from model output's `category` + `type` field). Adding a check = a spec change + eval fixtures, never a runtime plugin (Principle 5 posture carried into the track).

### 5.5 Causality: setup → payoff

Causality was the one continuity axis with no declaration to check, so the model review's timeline-plot category was the only thing that read it (media-track.md). A writer states it here, on the scene that plants the thread, and the app checks that the stated payoff is there. The module's one rule holds: nothing is inferred from the prose.

**Field shape (additive `SceneMeta` field):**

```ts
interface SceneMeta {
  // … §5.2 and §5.2.1 fields unchanged …
  threads?: { id: string; payoff: string; note?: string }[];   // absent = [] = the scene declares no thread
}
```

- `id` is the writer's **handle** for the thread ("the lamp"): free text, trimmed, at most 80 characters, not blank. Two handles on one scene that differ only in case are one handle, because the fact group lowercases it.
- `payoff` is the id of the document that pays the thread off. It is a document of the project, and not the setup scene itself.
- `note` is one line (at most 200 characters) on what the payoff is for. No check reads it; it is for the writer and for the model half below.
- **Why the setup side only.** A two-sided link needs two documents kept in step, and half the pairs would be one-sided in practice, which is the state this check reports. One declaration per thread, with the check as the judge, is one edit.
- **Why not `after`.** `after` records order (A before B). A thread records what A plants for B. They can coexist: a payoff normally comes after its setup, and `timeline.relation` may already say so.

**Field contract (project-format §2 discipline):** a file written before the field existed loads unchanged, and an empty list reads as none. An entry that is not a thread (a blank handle, no payoff, a note that is not text) is dropped on load with a notice that names the scene, and so is a second entry with a handle the first already holds. An unknown field on an entry is reported in the load notices, as on the scene itself. The list is kept sorted by handle, so the undo of a removal puts the list back as it was.

**Patch.** `coherence.setSceneMeta`'s `patch` gains `threads_add?: {id, payoff, note?}[]` and `threads_remove?: string[]` (handles, matched without regard to case). Removals apply first, so one patch with both edits a thread, as one command and one undo. Validation names the field: a blank handle (`threads_add[0].id`), a handle over the limit, a `payoff` that is not a document in the project or is the scene itself, a note over the limit, and a handle already on the scene (unless the same patch removes it). A thread is declared on a document: the command refuses it on a folder. The undo is the exact inverse: what the patch added is removed, and what it removed, or edited, comes back as it was.

**The check, `plot.unresolved-thread`** (id appended to the registry, so the order of the others does not move):

| Declared thread | Finding |
|---|---|
| `payoff` is a scanned scene | none |
| `payoff` is a document of the project that the scan did not read: empty, archived, outside the Manuscript, or a Research document the scope does not name | **info**, type `payoff-not-read`: nothing can be said about a scene that was not read |
| `payoff` names no document of the project (a deleted scene, a folder, a shot, a stale id) | **warning**, type `payoff-unresolved` |

- **Scope rule.** The check resolves a payoff against what the scan *could* read (the scanned scenes and the binder), and not against the scenes in this run's scope. A `changed` or `doc` run is then no different from a full one: a payoff scene that was not edited is still a payoff scene. The run's scope still decides which findings it reports, as for every check, by the setup scene: a thread whose setup scene the run did not read is not reported by it. A thread declared on a scene that was not scanned is not compared.
- **Messages say what was declared**, not what is wrong with the story: `"Chapter 2" declares the thread "the lamp" with its payoff in gone9, which is not a document in the project`, and `… with its payoff in "Chapter 14", which this scan did not read`. A thread the writer forgot to update is then a stale declaration and not a claim about the manuscript. The `expected` line names the declaration side.
- **Evidence** is the opening of the setup scene, as for the other declaration checks.
- **Fact group** `lower(setupDocId + '|thread:' + handle)`: one finding per thread, stable across edits to the text around it. A finding whose payoff moves between the two cases above stays one finding, and its dismissal stands.
- **Run note**, whenever the scan reads scenes: `N of M scene(s) declare a thread; K not compared`, so a check that has little to read does not look like one that found nothing. When the document list is not supplied, the check says so in its note and raises nothing.
- **Finding budget.** There is one finding per declared, unresolved thread and no cap on deterministic findings (the cap in §7 is the model review's). The writer declares each thread, so the count is the writer's.
- **Dismissal.** The five reasons stay as specced. `intentional` ("the payoff is in another book") and `false-positive` are the ones that fit; no technique reason is added.

**Model half (decision D13).** The review's category enum stays at five. A foreshadowing pass is a *subtype* of the timeline-plot category: its Stage 1 prompt gains one instruction, to judge for each declared thread whose payoff was read whether the payoff pays it off, and to name the handle in the finding so that a dismissal is against the thread and not a paragraph. No finding or category string changes, so a finding saved by an earlier build loads as it did. **Status: not built.** The field, the patch, the Inspector control and the check are built; the prompt instruction is the next landing.

**Fixtures (the build inherits them):** a thread whose payoff is a scanned scene (none); a payoff that names nothing, a folder, and a stale id (warning, naming setup document, payoff id and handle); a payoff that is empty or archived (info); two threads on one scene (one finding each, two fact groups); the same thread after the setup scene's text is edited (same fact group, a dismissal stands); a scene with no thread (no finding; the note counts declared and not compared); a thread on a scene that was not scanned (not compared); a blank handle (refused by the patch, dropped on load, skipped by the check); a `changed` run that did not edit the payoff scene (no warning) and a `doc` run over the payoff scene alone (no finding); a file written before the field existed (loads unchanged); the undo of an add, a removal and an edit (the threads as they were).

## 6. Findings lifecycle

### 6.1 Upsert semantics (dedupe across runs)

Per run, per produced finding, match against existing findings by `checkId` (or `llm:<category>`) + `factGroup`:

1. **Open match exists** → update it in place: replace `evidence`/`reasoning`, bump `updatedAt`, set `runId` (history preserved in the run record). No duplicate cards.
2. **Dismissed match exists** → **stays dismissed**; the new run's evidence is appended to the dismissed finding's citations (visible under "re-detected in run r_…"), and the run report notes "1 previously dismissed finding still present". Never re-alarms on a judged finding (Bunsho's dismissal is a first-class verdict, not a mute button).
3. **Fixed match exists** → stays fixed; if still detected, the run report lists it under "recurred after marked fixed" (the writer's signal the fix missed the real cause). Never re-opens automatically.
4. **No match** → new finding, status `open`.

### 6.2 Run scoping (Bunsho's three modes, mapped)

- **This document** (`scope.mode: 'doc'`, docIds = [focus]) — the cheap "check this chapter".
- **Changed since last pass** (`scope.mode: 'changed'`) — docs where `doc.revision ≠ reviewState[docId].lastReviewedRevision`; a project with no prior run state means everything. After a run completes, `reviewState` updates to current revisions for scope docs (side effect of run completion).
- **Full manuscript** (`scope.mode: 'full'`) — with a size guard: > 20 docs → the plan card says so and requires explicit approval (same rule as `continuity.scan`, agent-harness §3).

### 6.3 Dismissal (UI-only) and fixes (agent-proposed)

- **Dismiss** is a **UI-only action** (extends the 0-to-1 rule: deletion-class judgments are human). The dismiss flow requires a reason from a fixed picker: `flashback` · `in-world-lie` · `unreliable-narrator` · `intentional` · `false-positive` (+ free-text note). **Tooltip help text:** `in-world-lie` = *in-story deception between characters*; `unreliable-narrator` = *narration-level deception* — one line each in the dismiss dialog, the picker's only refinement. The five-reason set is **kept as specced** (§11 D11) (no additions, no structural change) — no vendor publishes a dismissal taxonomy (PlotLens's vocabulary is fact-vetting, not dismissal; Bunsho's five-plot-hole classes are check types, not dismissal reasons) and no dismissal analytics exist publicly, so the evidence base is craft literature + the mode lists, both of which the set covers. The picker's functional split is deliberate: `flashback`/`in-world-lie`/`unreliable-narrator` *declare a technique* (and map onto §5.2.1's `timelineMode` values), while `intentional`/`false-positive` mean "don't bug me again" — repeated technique-dismissals are the migration trigger to per-scene declarations (§11-A5). Dismissed findings remain visible under a "dismissed" filter with their reason (auditable, reversible — re-open is one click).
- **Mark fixed** is available to both UI and agent (`coherence.setFindingStatus`, §7) — the agent marks `fixed` only after an approved plan actually changed the relevant text (postcondition: the finding's evidence ranges no longer match the body projection, or `codex.write` landed the entry-side fix).
- **"Fix with agent"** on a finding card creates a pre-filled `scene.draft { mode: 'rewrite_selection' }` plan card with the anchor captured fresh from the finding's primary evidence range (fresh capture — the stored offsets may be stale; the anchor ladder is the safety net). The card goes through the normal confirm flow; coherence never applies text itself.
  - **The primary evidence range is decided in binder order.** It is the quote whose binder node comes first in the binder, and within that node the quote earlier in the text. Every node is ranked, a dialogue container as well as a scene, so when the first quote is in a dialogue container the finding offers no Fix (the agent drafts dialogue as beats, not as a rewrite of a passage). A finding that quotes two passages therefore rewrites the same one on every run and on every machine, whatever order its quotes were recorded in, and the pair ids the review assigns do not change (the order is read in the desktop, `primaryQuoteOf`, and the review's own span order is untouched).
  - **Only a passage in a scene the agent drafts is offered a fix.** A prose or screenplay document qualifies; a dialogue container does not (the agent appends its beats and does not rewrite a passage), and nor does any other node. A plan for a finding that fails the test is refused in words, by the same predicate the button is gated on.
  - **The note under the card promises no card.** The turn's answer (a card, or the provider's refusal) shows in the agent panel, and the note under the finding says where it shows, since the note is written before that answer is known.

## 7. Harness tools (rows 15–17 of the 32-row registry, agent-harness §10)

The v0.1 registry is frozen (agent-harness §3); these three land with the module, and all three are in the registry as extension rows. Same metadata discipline (`{name, risk, undoable, response_token_cap, description}`), callId dedupe, model-facing errors:

| # | Tool | Risk | Params | Semantics / Effects | Undo | Errors (model-facing) |
|---|------|------|--------|---------------------|------|----------------------|
| 15 | `coherence.scan` | read | `scope?: {mode: 'doc'\|'changed'\|'full', docIds?: string[]}` (default full-active), `checks?: DeterministicCheckId[]` (default all) | Runs the deterministic check set over scope; upserts findings; returns grouped summary (per-group: type, severity, count, scene refs). Findings/run record appended to `coherence.json` — an **appender side-effect like `sessions.jsonl`** (command-bus §9 precedent: derived-state appends are not commands). Manuscript is never touched. Over MCP the append happens with writes allowed (`--allow-writes`); a read-only server loads `coherence.json` so its scan upserts against the saved findings, and writes nothing (extensibility.md §9). | run removable via UI "discard run" (§7.1) | Unknown check id → lists valid ids; scope > 20 docs → suggests splitting (still runs if the user confirms in a one-step card). |
| 16 | `coherence.review` | write-confirm | `scope: {mode: 'doc'\|'changed'\|'full', docIds?: string[]}`, `categories?: LlmCategory[]` (default all 5), `maxFindings?: number` (default 50, cap 200) | The §5.3 pipeline. Plan card: one cost estimate for the plan, as §5.3 gives it (the prompt bound plus each call's reply cap, at the model's price), which docs will be read, and the prompt preview (context-assembly §5). The Findings tab shows the same figure for the same plan. The card does not split the estimate by stage: §5.3 asks for one estimate, and the stage counts stay on the card. On approval: stages run, findings upserted, run record written, turn report summarizes groups. Findings land in the inbox; **no text is ever modified**. | "discard run" (§7.1) removes the run + its untouched findings | No provider configured → error names settings; provider mid-run failure → run marked `partial`, completed-stage findings kept, retry = new run (dedupe makes re-runs idempotent per §6.1); empty result is a **result** ("no contradictions found in scope"). |
| 17 | `coherence.setFindingStatus` | write-auto (restricted) | `findingId: string`, `status: 'fixed'`, `note?: string` | Marks a finding fixed. **Restricted:** only `status: 'fixed'` is agent-settable; `dismissed` is UI-only (§6.3) — an agent asking to dismiss gets the model-facing refusal "dismissal is a writer judgment; propose it in your report". Postcondition: for text-evidence findings, the quoted range must no longer match the body projection (else the call fails with "evidence still present — apply the fix first"). | inverse (restore prior status) | Unknown id → "use an id from a recent run report or the findings inbox"; evidence still present → names the postcondition failure. |

**Not agent tools:** `coherence.setSceneMeta` is a bus command (UI-driven: Inspector POV/timeline fields), not exposed to the model in the first landing — the agent proposes SceneMeta changes in reports; exposure is reconsidered with usage evidence (same posture as `notes.replace` v0.2). Dismissal is UI-only (above).

**The review from the Findings tab.** The §5.3 review runs from the desktop Findings tab as the writer's own action, as well as through row 16 for the agent. The tab shows the review's plan before anything is sent: the calls it will make, a token estimate for each, the first prompt, and a cost when the provider profile is priced. It runs only when the writer presses the button. It then writes findings and a run record exactly as the tool does, and it modifies no text. A review that is not started leaves the run history as it was. The agent's `coherence.review` keeps its plan card (row 16). The review is a provider call, so the MCP server does not offer it (mcp-server README). The codex block the review sends for a document is the set the include policies select for that document, the set the context assembly selects (codex.md §5 and §6): an `always` entry is always sent, a `never` entry is never sent, a `manual` entry only when it is attached to the document or to a folder above it, a `detected` entry only when its name or alias is in the document's text, and an entry with an empty description is dropped.

### 7.1 Bus commands (registry extension, lands with the module)

| Command | Params | agentRisk | undo | Notes |
|---|---|---|---|---|
| `coherence.setSceneMeta` | `{docId, patch: {pov?, dayOffset?, durationDays?, after_add?, after_remove?, expectedPresent_add?, expectedPresent_remove?, timelineMode?, threads_add?, threads_remove?, learns_add?, learns_remove?, knows_add?, knows_remove?}}` | write-auto | inverse | Validates pov/expected ids against codex (unknown id → error lists codex entries); dayOffset ≥ 0 integer; `timelineMode` validated against the §5.2.1 enum (unknown → error lists valid values); `threads_add` entries validated as §5.5 says (blank handle, a payoff that is not a document, a handle already on the scene → error names the field), and refused on a folder; `learns_add`/`knows_add` pairs validated as §4.4 says (a character entry and a fact of `knowledge[]`; an unknown one → error lists the valid characters or facts), and refused on a folder. |
| `coherence.setFindingStatus` | `{findingId, status: 'open'\|'dismissed'\|'fixed', reason?, note?}` | write-confirm (agent: only `'fixed'`, per tool 17) | inverse | `dismissed` from the agent side is hard-refused at the gate. |
| `coherence.discardRun` | `{runId}` | write-confirm | compensable (puts back the run and its untouched findings; undo is by compensation, not an exact inverse) | Removes a run and findings it created **that the user never touched** (no status change, no dismissal); touched findings survive with their history. |
| `coherence.addKnowledgeFact` | `{text, ruleId?, entryId?}` | write-confirm | compensable (removes the fact) | Mints the `k_` id. `text` is one non-blank sentence of at most 300 characters; `ruleId` must be a world rule and `entryId` a codex entry (an unknown one → error lists the valid ones). |
| `coherence.editKnowledgeFact` | `{factId, text?, ruleId?, entryId?}` | write-confirm | compensable (puts the fact back as it was) | Changes the fields it names; `null` clears a link. A call that names no field is refused. |
| `coherence.removeKnowledgeFact` | `{factId}` | write-confirm | compensable (puts back the fact and every `learns`/`knows` pair it took, in one undo group) | Removes the fact and, in the same command, every pair that names it. Never a tool the agent holds. |

`coherence.upsertFindings` exists only as an internal primitive (never a bus command; composed inside scan/review applies — grant inheritance, command-bus §4).

## 8. UI surfaces

- **Findings panel** — third left-rail peer beside Binder and Codex: tab badge = open-finding count (Aeon's badge pattern); group cards (factGrouped) with type chip, severity dot, status; expanding a card shows both passages **side-by-side** (click a quote → `revealRange` in the editor); per-card actions: *Fix with agent* (§6.3), *Dismiss* (reason picker), *Mark fixed*, *Re-open*. A quoted passage's button is named by the passage, and its document is its description. The reason picker takes focus when it opens; Escape or Cancel closes it and returns focus to the card's *Dismiss* control; a dismissal moves focus to the next open card, or to the panel heading when none is open. A scope over the document guard (§6.2) asks in the panel, with *Scan it anyway* beside the scan, for a scan and for *Run again* alike; approving runs the scope that asked.
- **Run history** section: last N runs (kind, scope, date, findings upserted, tokens for llm runs), actions: re-run same scope, discard run.
- **Inspector extension:** SceneMeta editor on document nodes — POV picker (codex characters), dayOffset/duration number fields, `after`/`expectedPresent` chip pickers, a thread list (handle, the scene that pays it off, an optional note; add, edit, remove), and a **Knowledge** section with a *Learns* row and a *Knows* row (a character and a fact each, from pickers). Declared-but-unresolvable values flagged inline.
- **Knowledge list** beside the findings inbox: add, edit and remove a fact; each fact shows its derived ledger ("ANNA learns in *Scene 7*; BEN learns in *Scene 2*"), each scene name a button that opens the scene. A removal says how many declarations it takes with it.
- **Settings:** deterministic-check toggles (default all on), default review scope, per-run `maxFindings`.
- Out of scope first landing: cross-medium consistency (script ↔ storyboard ↔ cutscene — requires the screenplay, dialogue and storyboard artifacts to exist; noted in media-track's plot-coherence item), inline finding marks in prose, Director-Mode-style canon-constrained drafting (backlog — the plan-card context assembly may suffice, a `coherence.preflight` step is the v0.2 option).

## 9. Integration map (what talks to what)

```
codex (entries, aliases, MentionIndex caches) ──► deterministic checks (§5.1)
binder tree (order, parentage) + SceneMeta ─────► deterministic checks
coherence.json ◄──► coherence module (upserts, runs, reviewState)
coherence.scan ──► findings inbox (UI) + turn report (activity log row)
coherence.review ──► provider-gateway (N+1 calls) ──► Stage-4 deterministic assembly ──► findings
context-assembly ──► review/scan context layers (expanded budgets, estimator for plan cards)
finding card "Fix with agent" ──► scene.draft plan card (normal harness flow, anchor ladder)
codex provenance (codex.md §2 origin/sources) ──► canon-outranking rule (§4.3)
```

Failure modes at each seam: codex caches stale → checks read `docRevision`-stamped caches and rebuild on mismatch (codex.md §4 invalidation); provider failure mid-review → partial run (§7); coherence.json corrupted → recompute posture (§3).

## 10. Evals (headless, mock provider)

- **Deterministic fixtures:** each §5.1 check gets a positive + negative fixture (violation present / absent) + a "declaration absent → not checked" fixture, asserting exact finding shapes (ids, factGroup keys, severities) and the no-scan-archived rule. **§5.2.1 fixtures** (v0.2-of-track): the exemption table's positive/negative controls per mode + the per-strand `parallel` ordering fixtures (specced in §5.2.1).
- **Upsert fixtures:** re-run with unchanged facts → no new findings; dismissed-finding re-detection → stays dismissed with appended citation; fixed-then-recurred → report listing only.
- **Review scenarios (mock scripts):** canned Stage-1/Stage-2 responses → assertions on assembled findings (evidence offsets verbatim, factGroup normalization), plan-card cost estimate, `partial` run on scripted mid-failure, `maxFindings` cap.
- **Permission assertions:** `coherence.setFindingStatus` with `status: 'dismissed'` refused for the agent; `coherence.setSceneMeta` never agent-callable; `coherence.review` requires plan approval.
- All scenarios extend the harness eval suite (agent-harness §9); assembled-context assertions reuse the prompt-preview payload.

## 11. Decisions & assumptions

| # | Decision | Authority / rationale |
|---|---|---|
| D1 | Two-class check architecture (deterministic + LLM-judged 4-stage) | **Evidence-backed**: Aeon's entire value is the deterministic class; ConStory shows factual+temporal classes dominate real errors — the cheap class is also where errors concentrate. Rejected: LLM-only checking (cost + nondeterminism for what arithmetic solves). |
| D2 | Findings model: evidence = both passages quoted with body-projection offsets; grouping by fact; dismiss-with-reason first-class; findings inbox with badge | Delegated — synthesized from Bunsho finding cards + ConStory evidence chains + the Aeon panel pattern; the AskBack envelope discipline (one shape everywhere) extends to findings. |
| D3 | LLM checks = harness tool (`coherence.review`) with the ConStory 4-stage shape; never inline edits | Delegated; consistent with "findings with cited evidence, never a silent edit" and the harness plan-preview UX; Stage 4 is code, not a model call. Rejected: inline marks (the editor's suggestion layer owns marks), auto-resolution of timeline (Aeon's own fiction default is OFF). |
| D4 | `coherence.json` top-level artifact file; additivity via the unknown-file-tolerance rule; no formatVersion bump | Delegated — same argument as the codex[] absorption, with the post-v0.1 wrinkle handled by project-format §1's ignore-unknown-files rule (old loaders tolerate it). Findings recomputable; dismissals accepted loss (documented at load). |
| D5 | Dismissal UI-only; agent may mark `fixed` only | Delegated — extends the 0-to-1 rule to judgment calls (flashback/lie/unreliable are writer verdicts, not agent verdicts). |
| D6 | SceneMeta = writer-declared, day-offset integers; checks fire only on declarations | Delegated — the false-positive lesson (Aeon declarative model + NovelCrafter exclusion lists): an undeclared story is un-checked, never guessed at. Richer constraint shapes = D10. |
| D7 | Findings dedupe: upsert by checkId+factGroup; dismissed stays dismissed; fixed-recurrence reported | Delegated — re-runs must never re-alarm on judged findings; auditability preserved via citations-on-dismissed. |
| D8 | Registry 14 → 17 tools (post-v0.1); `coherence.scan` findings-append = sessions.jsonl-class side effect | Delegated; the band discipline applies to v0.1's frozen registry; the module lands with its own justified +3. The registry holds 26 rows, and this module's three are among its 12 extension rows (agent-harness §10). |
| A1 | Codex mention caches + SceneMeta are sufficient inputs for the deterministic class | Explicit; a richer timeline constraint model (D10) may add shapes; findings model is shape-stable under that upgrade. |
| A2 | ConStory 5-category taxonomy transfers to fiction long-form | Evidence-class (Microsoft/SUTD 2026, prose benchmarks); subtypes remain model-proposed strings, validated against the category enum. |
| D13 | Foreshadowing joins the model review as a timeline-plot subtype, not a sixth category (§5.5) | **Delegated default**, the option the proposal recommended: the deterministic half is what makes a thread trackable (an id, a dismissal, survival across edits); the model only judges whether a payoff works, and a category that fires on every declared thread would flood the finding budget. The enum stays five, so no saved finding changes. A sixth category stays open for a later, larger change (A2). |
| D14 | The knowledge ledger is declared on scenes and derived, not stored per character (§4.4) | **Delegated default**, the issue's recommendation: characters only, scenes only, "never learned" folded into `knowledge.leak`, and the text-matching variant (`knowledge.leak-text`, speaker-aware) left as its own change. Story order follows the declared days over binder position, and a scene in a mode with no reliable order exempts the pair rather than guessing. |
| A3 | LLM review cost stays acceptable at per-chapter/changed scoping | Estimate-gated at plan time (§5.3); full-manuscript runs are opt-in with the 20-doc guard. Real-cost feedback lands with usage; revisit if extract-call volume dominates. |
| A4 | Cross-medium consistency (script ↔ storyboard ↔ branches) deferred until the screenplay, dialogue and storyboard artifacts exist | Explicit; the findings model already carries it (`checkId` namespace is open). |
| A5 | Timeline-mode exemptions are a v0.2 upgrade path | **Resolved** — the exemption table is in §5.2.1 with its evidence complete: StoryLine's Validator source captures the full set membership — `EXEMPT_FROM_DATE_ORDER` = flashback/flash-forward/dream/mythic/**circular**/simultaneous; `EXEMPT_FROM_CONTINUITY` (all continuity) = dream/mythic; `EXEMPT_FROM_GAP` = timeskip/dream/mythic; `timeskip` stays IN the main-timeline order group (it is a gap legitimizer, not a date-order exemption). **`circular` adopted into the §5.2.1 enum (same row as flashback — third exemption set captured, second vendor precedent obtained); `time-skip` adopted with `timeline.gap`** (its only consumer is a gap-magnitude check, which §5.1 now has; the two landed together). StoryLine's doubly-exempt `simultaneous` row recorded, not adopted (Caotang stays conservative). Until the v0.2 landing, writers express the same intent via dismiss-with-reason (`flashback`, §6.3). |
| D9 | Fact store = codex entries; `worldRules[]` additive for non-entity facts | **Resolved:** both continuity vendors partition facts under entity types the codex already has — no free-floating fact table exists in either; codex entries confirmed as the v0.1-of-track fact boundary; `WorldRule {id, text, origin: manual\|found, source?, verified?}` joins `coherence.json` additively (§4.3). The knowledge ledger (`knowledge.leak`) is built on this boundary (§4.4, D14). |
| D10 | SceneMeta stays day-offsets; Aeon constraint model rejected for v0.1-of-track | **Resolved:** Aeon's effective dependency usage reduces to Finish-to-Start chaining (forum-evidenced), which `after:[]` provides; full dependency-type tail = backlog (v0.2); dual-ordered views (binder = narrative, dayOffset-sort = chronology) confirmed Aeon-native; `timelineMode: 'backstory'` gains a second precedent; fantasy calendars stay display-only epoch labels (v0.3). |
| D11 | Dismissal-reason picker kept as specced; one tooltip line added | **Resolved:** no vendor publishes a dismissal taxonomy or analytics; the five-reason set covers the craft-literature + mode-list classes; `in-world-lie`/`unreliable-narrator` tooltip distinction added (§6.3); technique-declarations vs don't-ask-again split maps onto the per-scene declaration path (A5). Verdict honestly evidence-thin ("keep as specced", not "validated by data"). |
| D12 | `timelineMode` enum finalized: `circular` and `time-skip` in | **Resolved:** StoryLine's Validator source gives the second precedent for `circular` (date-order-exempt only). `time-skip` has no consumer without a gap-magnitude check (StoryLine's `checkTimelineGaps` is the class's only shipped implementation), so it landed together with `timeline.gap` (§5.1): threshold 7 story days, info, start to start, either side exempt; the threshold is one constant, and a story-relative or project-set threshold is not built. |
