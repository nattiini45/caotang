# Context assembly — what the model sees, in order, within budget (v1)

> Status: built.
> Cross-refs: tool semantics = [agent-harness.md](agent-harness.md) · codex policies = [codex.md](codex.md) · transport/budgets config = [provider-gateway.md](provider-gateway.md).

## 1. Purpose & scope

This module owns the **read half of every model call**: given a task (tool call) + app state, produce the exact `messages[]` for `ProviderGateway.complete()`. The write half (parsing tool calls, plans, verify steps) stays in the harness. Assembly is a **pure function of (task, project state, config)** — same inputs, same prompt bytes — because §9 evals assert on stable assembled context.

Competitive evidence settled the strategy question: **synopsis-tree + mention-keyed codex assembly, zero embeddings in v0.1.** This spec turns that verdict into budgets, ordering, and failure behavior.

## 2. Layer stack (fixed order)

```
L0  system prompt (harness role + tool registry subset + JSON protocol)
L1  project summary            (project.overview shape, ≤1.5k tokens)
L2  codex layer                (per policy; ≤1k tokens default)
L3  structural synopses        (scope line: ancestor chain + prior siblings, ≤1.2k tokens)
L4  prior-scene synopses       (story-so-far, ≤2k tokens default)
L5  focus document text        (tail / selection per tool mode, ≤2k tokens default)
L6  conversation memory        (last 2 agent turns, compressed, ≤1.5k tokens)
L7  task                       (instruction + tool params, no cap — it is the payload)
```

Assembly renders layers in this order into the message list; truncation happens **bottom-up within each layer's budget, and whole layers drop before earlier layers shrink** (drop order: L6 → L2 detected-tail → L4 tail → L3 tail; L0/L1/L7 never truncated). Rationale: recency and task dominate (Sudowrite's ~1k-words-of-immediate-prose convergence), structure beats volume.

### Layer details

**L0 — system prompt.** Fixed harness text (versioned artifact, evals own its revision per agent-harness §9): operator framing, active tool list with one-line signatures, the plan/confirm protocol, the JSON protocol when `responseFormat` is set. No project content. One variant is by document kind: a scene draft's role text (the harness's `sceneRole`) asks a screenplay scene for Fountain, and a `continue` or `rewrite_selection` of a screenplay scene asks for its passage's Fountain alone, with no scene heading, since the scene already has one (screenplay.md §3). The variant names the form of the text, not project content, so the layer stays fixed text for each kind.

**L1 — project summary.** Exactly the `project.overview` response (title, 2-level tree with titles/types/statuses, vocabulary, word counts, target progress), serialized compactly. ≤1.5k tokens; larger trees → depth-1 + doc count (the model can call `binder.read_tree` for more).

**L2 — codex layer.** Per [codex.md](codex.md) §6: detect → policies → filter → deterministic sort (always → type → name) → render `## name (type)` + description. Budget 1k tokens default; prune whole entries, never mid-body; prune order manual-attached → detected tail → always; prune list surfaced in prompt preview.

**L3 — structural synopses.** The focus doc's binder context line: ancestor folder titles+synopses up to Manuscript root, plus the focus doc's **prior siblings' titles + synopses** (same parent, order < focus, capped to budget — nearest first). This is "where am I in the book," not "what happened" (that's L4). Folder synopses are the act/part cards (Novelcrafter's scene/chapter/act summary slots).

**L4 — prior-scene synopses (story-so-far).** Documents in manuscript order before the focus doc, **synopsis only, never body text**, capped to 2k tokens nearest-first (fresh chapters' synopses beat chapter 1's). This layer is *always on* for body-text generation — prior scene summaries ARE the story so far, and Sudowrite's lesson (their 20k-word Chapter Continuity window is the practical ceiling; synopses are how we stay inside it at any manuscript length).

**L5 — focus document text.** Mode-dependent slice of the focus doc body:
- `draft` (empty doc): no body; synopsis+notes of the doc itself stand in.
- `continue`: the **tail** — last `continuationChars` chars, default **3,000** (~750 tokens; Sudowrite's documented ~1,000 words + headroom).
- `rewrite_selection`: the selection + the preceding 1,500-char tail (immediate antecedent), each labeled.
- Always ends with a marker line: `<<< current text ends here >>>` so continuation starts at a known boundary.

**L6 — conversation memory.** Last 2 agent turns, compressed to intent + outcome lines (not verbatim transcripts) with their undo-group ids. Older turns are recoverable by the model via explicit tools, not context (token economics).

**L7 — task.** The tool instruction verbatim, plus compact tool params. Never truncated.

## 3. Budgets

- Total default prompt budget: **12k tokens** (config `contextBudget` in settings; provider-gateway may override per call via `maxOutputTokens` complement — the gateway's `context_length` error names the lever, never silent truncation).
- Layer budgets as above are the default split; unused budget flows **up** (L5 tail may grow into L4's unused space, then L4 into L3) — nearest context wins, per the Sudowrite calibration (D3). Flow-up is deterministic (fixed precedence), keeping evals stable.
- Character→token estimate: `ceil(chars/4)` (the mock-provider accounting convention, provider-gateway §8) — budgets are enforced on estimates pre-flight, real usage lands in the ledger after.
- Per-tool defaults: `scene.draft` = full stack; `continuity.scan` = L2 expanded (2.5k) + L4 expanded (6k) + scope-doc tails (1k each, ≤20 docs); `synopsis.fill` = L5 full doc (cap 25k) + L3, no L2; metadata/meta tools = L0+L1+L7 only. L6 (the prior turns) rides the draft calls — `scene.draft` and `dialogue.draft` — and not the planner: the planner's `meta` call is L0+L1+L7, so the planner's own call carries no L6 and the planner never sees the prior turns.

## 4. The assembly algorithm (implementer-grade)

```ts
interface AssembledPrompt {
  messages: ChatMessage[];          // final wire shape for ProviderGateway
  layers: { id: 'L0'|'L1'|'L2'|'L3'|'L4'|'L5'|'L6'|'L7',
            included: boolean; tokens: number; dropped: string[]; }[];  // dropped = per-item reasons (for preview)
  estimate: { promptTokens: number; byLayer: Record<string, number> };
}

assemble(task: AgentTask, app: AppSnapshot, cfg: ContextConfig): AssembledPrompt
```

Deterministic steps per layer in the fixed order; every inclusion/drop records a reason string (`included via policy=always`, `dropped budget (L4 tail, rank 7)`) — these reasons ARE the prompt-preview payload (§5). No randomness, no wall-clock (timestamps only in content the tool params themselves carry). **Forward-outline suppression lives here:** only L3/L4 items with `order < focus.order` are eligible; "include forward outline" is an explicit per-call option (`includeForwardOutline?: boolean`, default false) exposed on `scene.draft` — the spoiler-leak lesson, inverted into a feature. Codex `never`/empty filters apply before budgeting (codex.md §6).

## 5. Prompt preview (the trust mechanic)

Every confirm-class tool's plan card renders the **assembled context**, not just the instruction (Novelcrafter's own troubleshooting relies on prompt preview as THE debugging tool; assembly is never silent):

- Codex section: each included entry with its reason (`always` / `matched "Elena" ×3 in tail` / `attached to Chapter 2`) and each dropped entry with its drop reason.
- Story-so-far: the synopsis list included, count of omitted older synopses.
- Focus text: first 120 chars of the tail slice + "… (3,000 chars)".
- Budget bar: per-layer token estimates vs layer budget.

Preview is computed by the same `assemble()` — **zero drift between preview and execution** (preview artifacts = eval fixtures). Token/cost **estimate on the plan card before approval** (the answer to credit anxiety: BYOK users see `~1.9k prompt + ~1.2k completion tokens` before approving; completion estimate = tool-default `maxOutputTokens`, plus the thinking a set level can spend — the effective budget, or an adaptive level's nominal share — and labelled "including thinking"), computed locally from the ledger's model prices when the user fills an optional per-profile `pricePer1k` field (display-only, provider-gateway §6 and §9 — no quota logic).

## 6. Onboarding default (mock provider first)

First-run Caotang launches with the **mock provider active** and a first-run wizard card: 1) tour the agent with three demo intents that work with zero keys (mock scripts render canned plans/drafts); 2) "when you're ready, paste your key" → settings, with `listModels` probe validating the profile at save time (provider-gateway §5). Rationale: the competitive evidence — BYOK setup is Novelcrafter's wall, and "the AI does not auto-read your manuscript" is mental-model hurdle #1. The agent must be demonstrably useful before any key is pasted. The mock profile is a real `ProviderProfile` (`baseUrl: 'mock://caotang'`, no key) — the same gateway path, evals, and accounting as real providers.

## 7. Failure behavior

- Pre-flight estimate exceeds model context window (from `listModels` contextWindow, else the preset row's published window, when known; the Claude presets state theirs without a listing): assembly proceeds at layer-budget level but the plan card warns with numbers ("prompt ≈ 8.1k tokens; model window 4k — trim codex or raise budget"). Never auto-truncate below the layer guarantees.
- Gateway `context_length` error post-flight (window unknown): surfaced verbatim (provider-gateway §4) + activity-log link; harness retry ladder may re-run with `compact: true` (halves L2/L4 budgets) before asking the user.
- Missing inputs degrade with reasons: empty synopsis → L4 entry rendered as `(no synopsis — Chapter 4)` rather than silently skipped (visibility over polish; the "never silent" posture).

## 8. Decisions logged / assumptions

| # | Item | Status |
|---|---|---|
| D1 | Keyed context (synopsis-tree + mention codex), zero embeddings v0.1 | **Resolved by competitive evidence** (Novelcrafter, Sudowrite); embeddings stay a backlog candidate. |
| D2 | Fixed layer stack + bottom-up drop + upward budget flow | Delegated; rejected: per-tool free-form prompt tuning (eval-hostile; Novelcrafter's prompt-library sprawl is the cautionary example). |
| D3 | Defaults: tail 3k chars, story-so-far 2k tokens, codex 1k tokens | Calibrated to Sudowrite's documented ~1k words + ~20k-word continuity band; config-exposed, not hardcoded. |
| D4 | Forward-outline excluded by default | Delegated (spoiler-suppression lesson); per-call opt-in flag. |
| D5 | Cost estimate display on plan cards | Delegated; pricing-adjacent display-only (provider-gateway §9's no-quota decision holds). |
| D6 | Whole-entry drop over NovelAI's 4-step trim ladder (fit → newline → sentence → token trim) | **Delegated**: the ladder exists because 2k–8k contexts squeeze every token; at our 12k budget all-or-nothing stays eval-stable and preview-readable. Recorded as the v0.2 option if per-layer budgets shrink. |
| D7 | Fixed deterministic sort over insertion-order sort | **Delegated**: NovelAI's own docs admit tie nondeterminism in insertion-order sorting; our always→type→name order keeps assembled context eval-stable. |
| D8 | Reason taxonomy for drops mirrors the Context Viewer's Omitted set | **Delegated**: preview drop reasons extended to name *which* budget dropped an entry (Disabled / no key / no space (naming L2 budget) / empty description); QA checklist adopted from NovelAI's Context Viewer. |
| A1 | `ceil(chars/4)` estimate tracks real tokenizers within ±30% | Assumption; acceptable for budgets/preview; ledger records real usage. |
| A2 | Mock-provider onboarding wizard is v0.1 | Delegated (onboarding evidence); wizard polish level may slip to v0.2 without harming the spec. |
| A3 | v0.2 codex-upgrade path (post-v0.1 candidates in priority order) | **Reserved-then-fit two-phase budgeting** (NovelAI's reserved-tokens model) if flat prune-order ever starves `always` entries; **relations expansion with caps** = cascading activation (per-entry recursion flags à la SillyTavern; expansion depth-capped, counted against the codex budget, every expanded entry surfaced in the preview with its expansion path); **timeline-scoped codex overlay** = Novelcrafter Progressions (codex additions visible only from a scene onward — solves "the lighthouse was destroyed in ch. 12" spoiler-leak). Random-chance / probability-gated activation **rejected** (breaks the pure-function contract; ST docs push keyword matching for predictability). |