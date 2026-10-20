# Edit anchors — how range parameters survive drift between plan and apply (v1)

> Status: built.
> Engine-agnostic by construction: the mechanism lives at the **command-bus / plain-text projection** layer, so the editor engine can change without touching it.
> Cross-refs: tool semantics = [agent-harness.md](agent-harness.md) §3 · command execution + doc revisions = [command-bus.md](command-bus.md) §4/§6 · body storage = [project-format.md](project-format.md) §3.

## 1. Problem & lifetime

Any agent operation that targets a text range (`scene.draft` mode `rewrite_selection` today; `notes.replace` in v0.2) must address text that may change between **plan time** (range captured, card shown) and **apply time** (user approved). The window is short — a card review — but the drift class is real (user edits while reviewing, a prior step in the same plan moved the text). Sentinel markers inside prose are **rejected** (corrupt ownable plain-Markdown files; no studied product ships invisible tokens). Live position-mapping (ProseMirror `mapping`, Lexical node keys) is in-session-only and lives inside the editor engine. So v0.1 stores **self-verifying anchors**: offsets + exact text + surrounding context, verified at apply time.

## 2. Data shape

```ts
interface TextAnchor {
  from: number;              // char offset into the body projection (§3), 0-indexed, inclusive
  to: number;                // exclusive; to > from
  exact: string;             // body.slice(from, to) at capture time; 1–2000 chars
  prefix: string;            // up to 32 chars preceding `from` ('' at doc start) — Hypothes.is convention
  suffix: string;            // up to 32 chars following `to` ('' at doc end)
  capturedRevision: number;  // doc.revision at capture time (command-bus.md §7)
}
```

- One anchor per range param, stored **in the plan card** and previewable (the card renders `exact` with prefix/suffix as context — the user can edit the anchor inline like any plan param, agent-harness §2).
- Coordinate system: UTF-16 code-unit offsets into the **body projection** = the stored document body exactly as in `docs/<id>.md` minus YAML front matter, with `***` separators as stored. This is the same coordinate system `doc.read range` uses (agent-harness §3) — one projection, three consumers (read, anchors, mention detection).
- Size bounds: `exact` ≤ 2000 chars (plan-card previewable); longer targets split into multiple anchored steps.

## 3. Resolution ladder (at apply time)

```ts
type AnchorResolution =
  | { status: 'ok'; range: { from: number; to: number };
      method: 'exact' | 'near-offset' | 'context-fuzzy' | 'unique-global'; revisionDrift: number }
  | { status: 'unresolvable'; reason: string;
      candidates: { from: number; to: number; similarity: number }[] };   // ≤ 3

resolveAnchor(anchor: TextAnchor, body: string): AnchorResolution
```

Steps in order; first match wins:

1. **exact** — offsets in range and `body.slice(from, to) === exact` → apply at `{from, to}`. The common case: zero drift.
2. **near-offset** — search for `exact` (case-insensitive) within a ±2000-char window around `from`; exactly one hit → context check (below) → apply at the new range.
3. **context-fuzzy** — Hypothes.is context-first rematch: fuzzy-locate `prefix` near the expected position (Bitap-class search, max edit distance ⌈len/10⌉, floor 2), then `suffix`, then compare the text between them to `exact` (normalized similarity ≥ 0.85 via diff-match-patch); unique pass → apply.
4. **unique-global** — case-insensitive search for `exact` across the whole body; exactly one hit → verify ≥ 80% of prefix/suffix characters at the corresponding positions (case-insensitive; empty prefix/suffix skipped) → apply.
5. **Exhaustion → `unresolvable`** — **never a silent fallback, never a guess**: the turn enters the structured ask-back (agent-harness §2 step 4) carrying: the drift reason ("selection text changed since plan"), `candidates` (up to 3, offsets + similarity), and `revisionDrift` (apply-time revision − captured revision). Options offered: re-select in the editor / re-read via `doc.read` / drop the step.

Context check (used by methods 2–4): ≥ 80% of prefix and suffix characters match at the corresponding positions, case-insensitive.

**Case-insensitive** means `toLowerCase` one code point at a time, applied to both sides of a comparison so that the needle and the text it is searched in are folded the same way — not a full casefold: `ß` does not match `ss`, and a final sigma (`ς`) does not match a sigma (`σ`).

**A caller that resolves an anchor directly awaits `preloadAnchorLibraries()` first.** Step 3 needs the fuzzy locator, and a ladder that reaches it with the locator unbound refuses and names the reason rather than skipping to step 4, so an unprepared caller gets one rung short of the ladder. The apply path awaits the preload, so in the product step 3 is always available.

## 4. Application path (never raw string surgery)

- The resolved range is applied through the command bus `editor.replaceRange` primitive **inside `scene.draft`'s compound apply** (command-bus.md §4 grant inheritance); the whole turn is one undo group (agent-harness §5), and the doc body snapshot (project-format §8 write-ahead) is taken before the mutation.
- **Applied transactions are history-excluded** (`tr.setMeta('addToHistory', false)`, two-lane undo — [editor-engine.md](editor-engine.md) §7): agent edits never surface in the user's Ctrl+Z; "restore to before this turn" remains the reversal affordance.
- **Libraries:** step-3 similarity scoring = `fastest-levenshtein` (~1 KB, MIT, main bundle); step-4 fuzzy locate = `diff-match-patch` `match_main` (Apache-2.0, ~30 KB gz class, **lazy-loaded at the edit-anchors module edge** on first step-3 miss — steps 1–2 stay dependency-free). DM's `diff_main` doubles as the future drift-diff renderer. Rejected: fuzzysort (relevance ranker, wrong shape), natural (heavy general NLP toolkit), hand-rolled Bitap (a solved problem; the maintained module wins).
- Read-only consumers skip the ladder: `doc.read range` that no longer matches `exact` simply returns the text actually at the range with a note — reads never mutate, so there is nothing to mis-address.
- `continuity.scan` findings quote spans as `{docId, quote, paragraphHash}` — the **paragraph-hash is a cross-run reporting key, never an apply-time anchor**.

## 5. Interaction with the editor

- **Engine decided:** Tiptap 3.x on ProseMirror → [editor-engine.md](editor-engine.md) 📐. The ghost-preview region (agent-harness §8) means the model never touches live editor positions mid-stream; application happens post-approval on the body projection, then the editor re-renders from the store (Lane 2, history-excluded — editor-engine §7). The anchor ladder itself remains engine-agnostic: it runs on the body projection, not inside the editor.
- v0.2 (apply-then-review alternate mode): suggestion **marks** replace the ladder inside the editor — **`@handlewithcare/prosemirror-suggest-changes` exact 0.1.8 (MIT, insertion/deletion/modification marks + dispatchTransaction decorator)**; editor-engine.md §2 pin row + §12 D10 carry the decision and the vendor-if-HEAD-fix escape hatch. Rejected: `davefowler/prosemirror-suggestion-mode` (its text-anchored `applySuggestion {textToReplace, textReplacement, textBefore, textAfter}` locate-by-search applies *below* this ladder — adopting it would discard §3's offset+exact+prefix/suffix verification for a weaker mechanism) and Tiptap Pro Tracked Changes (paid/proprietary/Alpha).
- **The ladder survives the marks layer — division of labor:** the anchor ladder remains the resolution mechanism for *agent-authored* range targets resolved **at plan/apply time** (e.g. `rewrite_selection` cards, v0.2 `notes.replace`); suggestion marks take over only **after** an edit lands, as the user-facing accept/reject layer (per-span extra attrs = tool-call id, so review UI groups accept/reject per tool call). Marks never resolve drift themselves; they are post-application state. `revertSuggestion(id)` gives the per-span reject that the v0.1 ghost Apply loop lacks.

## 6. Evals (headless, no editor)

Fixtures: zero-drift apply (`exact`); drift with unique rematch (`near-offset`); context-fuzzy recovery; ambiguous multiple hits → ask-back payload shape (candidates + reasons + revisionDrift); doc rewritten between plan and apply; empty doc / out-of-range offsets / `exact` exceeding bounds.

## 7. Assumptions

| # | Assumption | Status |
|---|---|---|
| A1 | Plan→apply window is short enough that drift is rare and the ladder covers it; paragraph-hash unnecessary as an anchor | Evidence-backed; revisit only if v0.2 introduces *saved* plans that outlive a session. |
| A2 | Thresholds (0.85 similarity, 80% context, ±2000-char window, ⌈len/10⌉ fuzzy distance) are frozen defaults for evals, tunable config | Explicit; eval fixtures pin the defaults. |
| A3 | Body projection stays the single coordinate system for `doc.read`, anchors, and detection | Holds while documents are stored as plain-Markdown bodies (project-format §3); an inline annotation syntax would extend, not replace, the projection. |