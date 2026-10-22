# Video prompt pack — shot-prompt authoring & per-vendor export (post-v0.1)

> Status: built, except where a section says otherwise.
> Scope: Boundary (evidence-confirmed): **Caotang authors and exports the prompt pack + shot list; it never generates video, holds no vendor keys, stores no media, uploads no manuscript.** Generation happens in the user's tool with the user's credentials.
> Cross-refs: shot substrate = [storyboard.md](storyboard.md) §2 (the `shot` node + `vendorRefs`) · codex = [codex.md](codex.md) §2 (`attachments` = consistency layer) · context-assembly = [context-assembly.md](context-assembly.md) §2/§3 (shot-scoped stack) · recipes = [exporter.md](exporter.md) §2/§3 · harness registry = [agent-harness.md](agent-harness.md) §3.

## 1. Verdict (adopted)

**The prompt pack contract is concrete: one normalized shot schema + per-vendor templates mapping it down.** No stable prose schema exists to copy — the parameter layer *is* the schema. The codex is the consistency layer (per-entity visual references); the shot is the authoring unit; the vendor-template layer is the exporter mechanism. **In-app generation is rejected permanently** (per-vendor consent systems — Sora's likeness flow — make it not merely wrong but unshippable for a local-first app).

## 2. Normalized shot-prompt schema (the superset)

```ts
interface VideoShotRef {                    // per-shot prompt record; lives in ShotMeta.vendorRefs[] (storyboard.md §2.2)
  vendor: string;                           // template id, e.g. 'runway-gen4' | 'veo-3.1' | 'kling-2.6' | 'sora-2' | 'wan-2.6' | 'seedance-2.5'
  model?: string;                           // vendor model name override
  mode: 't2v' | 'i2v';
  prompt: {                                 // structured prose — camera-first ordering per vendor conventions
    camera?: string;                        // "slow dolly-in on …"  (camera movement phrase)
    subject?: string;                       // who/what — codex-resolvable terms preferred
    action?: string;                        // physical actions, not abstractions (Runway's guide rule)
    context?: string;                       // setting/scene context
    style?: string;                         // aesthetic/lighting/film-stock references
  };
  audio?: { dialogue?: string; sfx?: string; ambient?: string; music?: string };   // quoted dialogue; front-loaded order = template's job
  negativePrompt?: string;                  // ≤500 chars pack-wide validation
  durationSec?: 4 | 5 | 6 | 8 | 10 | 12 | 15 | 16 | 20;   // union of surveyed enums; template maps/clips to the vendor's
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9';
  resolution?: '720p' | '1080p';
  seed?: number;                            // 1…4294967294 where the vendor takes one
  promptExtend?: boolean;                   // default **false** — Caotang's authored prompt is canonical (Wan's LLM rewrite would mutate it; per-vendor confirmation open, §8 A2)
  references: VideoReference[];             // resolved from codex by default (§3), overridable per shot
  notes?: string;                           // writer's per-shot intent note; exported as comment/metadata, never a vendor param
}
interface VideoReference {
  type: 'image' | 'character' | 'firstFrame' | 'lastFrame';
  entryId?: string;                         // codex entry id (source of the reference image)
  assetId?: string;                         // or a project asset directly (storyboard.md §2.2)
}
```

- **Char caps are pack-time validation:** templates carry each vendor's caps (Runway 512–1000, Kling 2500, Wan 1500/800, Veo ~175-word practical ceiling, Sora "short"); the pack validator flags over-cap fields **before export** (fix in-app, never truncate silently — silent truncation is a rejected posture everywhere in Caotang).
- **Duration/aspect enums are per-vendor:** the schema holds the union; each template's mapping table declares its own accepted set and what happens to out-of-enum values (error at validation, never clamp-silently).

## 3. The codex as consistency layer

- **Codex entries gain optional visual-reference attachments:** `CodexEntry.visualRefs?: string[]` (asset ids in `assets/` — storyboard.md §2.2's asset directory; additive field, loaders-tolerant, same rules as `attachments`). Character/location/prop entries are the consistency layer (Runway Gen-4 = single reference image carries a character across scenes; Sora = persistent character id from a ref clip; Kling = first/last frames).
- **Pack resolution order (deterministic, previewable):** shot-level `references[]` override → else codex `visualRefs` of entries mentioned in the shot's `action`/covered script elements (mention cache, codex.md §4) → else none. The plan/export preview names **which codex entries supplied which references per shot** — the writer sees the consistency payload before export. The Markdown pack writes a **Consistency** block for each shot that names a codex entry, listing the entries that sent references and, for each entry that sent none, the reason it sent none.
- **Generation metadata (reproducibility, provisional — §8 A3):** after the user generates externally and keeps a take, the shot may record `bestTake?: { seed, model, vendorParams: Record<string,string|number>, note? }` (free-form param record — vendor-specific, never normalized by Caotang; the pack re-exports it in the vendor's own field block so a re-run reproduces the take; Runway's guidance: seed alone is insufficient). **Provenance posture:** `bestTake` is metadata the *user* brings back; Caotang never round-trips generation itself. *(The exact per-vendor reproducibility field sets are still to be verified; this shape is format-stable under any answer.)*
- **Boundary enforcement:** no codex visualRef, asset, or `bestTake` field is ever uploaded anywhere by Caotang; exports embed *paths/names* for image references, and the pack documents "attach these files in your vendor's UI" where vendors require upload (Sora Character clips; Kling ref frames). Where a vendor wants binary references, the pack ships a **manifest of files to attach**, never the upload.
- **A reference that names no picture is kept and reported missing.** A `visualRefs` id, or a shot's `references[]` entry, that names no file in the project's `assets/` is not dropped at load and not refused on write. The pack names it as missing, in the same way it names a missing shot reference, so the writer sees what to fix. (The loader keeps the list as it was saved; the codex panel and the approval card name a missing picture as one that is no longer in the project.) This is the rule the code follows, and the one codex.md §7 and the store's validator describe.

## 4. Prose-grammar guidance (draft-time hints, per vendor template)

The template layer carries each vendor's documented grammar as **draft guidance** surfaced in `prompt.draft` (and rendered as comments in exported Markdown packs):

- Runway Gen-4: `[camera movement]: [establishing scene]. [additional details].` — concrete physical actions, never abstract concepts; image+text together form the prompt (don't re-describe the image).
- Veo 3/3.1: one-sentence shot list `[Cinematography]+[Subject]+[Action]+[Context]+[Style]+[Audio]`; dialogue in quotes; audio instructions front-loaded; ~175-word practical ceiling.
- Kling: ≤2500 chars; `cfg_scale` adherence note; multi-shot `multi_prompt` ≤6 shots for sequence takes.
- Sora 2: short prose + `input_reference`; Characters API for identity.
- Universal failure-mode notes rendered per template: multi-speaker lip-sync unreliable (<40%, Veo) → prefer single-speaker per shot; seeds don't reproduce alone → record `bestTake` fully.

## 5. Vendor-template layer (exporter mechanism)

```ts
interface VideoVendorTemplate {
  id: string;                 // 'runway-gen4' etc. — recipe `templateId` selects it
  displayName: string;
  accepts: (s: VideoShotRef) => ValidationIssue[];   // enum/cap checks, pack-time (§2)
  map: (s: VideoShotRef, ctx: { assets: Map<string, AssetRecord>; codex: Map<string, CodexEntry> }) => VendorPayload;  // normalized → vendor JSON
  grammarHints: string;       // §4 prose-grammar comment block
  fileRefPolicy: 'name' | 'attach';   // how references ship (§3)
}
```

- **One superset schema, N mapping tables** (the consolidating observation: Runway's aggregator surface normalizes ratio/duration/negativePrompt/references across hosted models — the pack mirrors that shape). Templates are **data-shaped, code-honest**: declared in spec, compiled into the module (closed set at first landing: Runway, Veo, Kling, Sora, Wan, Seedance); adding one = a spec change + fixtures, never runtime plugins.
- **Export formats (three pack artifacts, one recipe):**
  1. **JSON pack** — machine-consumable: `{vendor, templateId, shots: [{shotNumber, …normalized fields, mapped fields, references[], bestTake?}]}` — the canonical artifact.
  2. **Markdown pack** — human-readable per-shot cards (spec row, mapped prompt, audio, negatives, reference file names, grammar comments) — the reviewable/printable artifact.
  3. **CSV shot list** — `shotNumber, vendor, mode, duration, aspect, prompt (single line), negativePrompt, refs` — the bulk/external-tool artifact.
- Same exporter seam: `format: 'promptpack'` + `templateId: <vendor>` joins §2's enum; the Compile dialog is a second surface for it beside the Prompt pack tab, and it writes all three artifacts as one zip where the tab writes one per click; compile log gains per-shot validation rows (over-cap, out-of-enum, missing references — the §4 acceptance list).

## 6. Harness tools (the track's rows 20 and 21; the registry holds 33 rows, agent-harness §10)

The numbers in the first column are the track's own, as the module's spec gives them. They are not positions in the registry, whose count is agent-harness §10's.

| # | Tool | Risk | Params | Semantics / Effects | Undo | Errors (model-facing) |
|---|------|------|--------|---------------------|------|----------------------|
| 20 | `prompt.draft` | write-confirm | `shots: string[]` (shot ids, ≤30), `vendor: string` (template id), `instruction?: string` (creative direction) | For each shot: assembles context (§7), drafts the structured prompt fields (camera/subject/action/context/style + audio + negatives) from the shot's script coverage + codex entries, writes them into `ShotMeta.vendorRefs[vendor]`. Plan card: per-shot proposed prompt blocks (preview = the artifact). Batch-validated (vendor template id must exist; shots must be in storyboard folders). the draft is staged: the model call runs when the tool is called, and nothing is written until the plan card is approved. Each shot's record is written through `shot.setMeta` (command-bus §9), whose `expect` refuses a shot that has changed since the draft read it. | one undo group for the batch | Unknown vendor → lists installed templates; shot without image refs and mode=i2v → ask-back ("i2v needs a first-frame asset or codex visualRef"); >30 shots → split. |
| 21 | `prompt.variant` | read | `shot: string`, `vendor: string`, `variation: 'camera' \| 'lighting' \| 'style' \| 'audio'` | Returns N=3 alternative field values for the chosen axis (model call, cheap), rendered as a ghost list — the user picks; nothing writes until a `prompt.draft`-shaped confirm lands the pick (variant output = proposal payload, applied via an edited confirm card). | n/a (read) | Shot without an existing prompt → "run `prompt.draft` first"; unknown variation enum → lists values. |

`shots.derive` / `shots.annotate` are storyboard.md §4's tools (the substrate). **No vendor/network tool exists, ever** — the BYOK boundary (§1) is enforced by the registry's shape itself (nothing to call generation with) *and* the hard-deny class (command-bus §4 network rule: the provider endpoint is the only egress; vendor APIs are not configured, not called, not proxied — extensibility §12 D-no-CORS-proxy posture extended).

## 7. Context assembly (shot-scoped, rides the 8-layer stack)

`prompt.draft` uses the standard stack with shot-scoped values (no new layer types, context-assembly.md §2): L3 = the shot's parent folder chain synopses; **L4 = prior shots' `vendorRefs[vendor].prompt` one-liners (storyboard order, ≤1k)** — the visual story-so-far, mirroring "prior scenes = story so far"; L5 = the shot's covered script text (its `dialogue[]` anchors resolved) + `action` + imageAlt; L2 = codex entries of the shot's resolvable references (§3), budget 1k. Budgets stay default 12k; the estimator covers the plan card unchanged.

## 8. Evals (headless, mock provider)

- `prompt.draft` fixtures: mock scripts → deterministic structured-prompt assertions (field shapes, cap validation list, reference resolution order §3, codex-mention keyed consistency payload); plan-card preview = per-shot prompt blocks.
- Template fixtures: per vendor — valid shot → exact mapped output shape; over-cap prompt → validation row; out-of-enum duration → validation row (never clamped); `promptExtend: false` default asserted in mapped output for Wan.
- `prompt.variant`: variant payload shape; confirm-card apply path.
- Boundary assertions: zero network calls beyond the provider endpoint in any scenario (mock script with a would-be vendor call → hard-deny error shape).

## 9. Assumptions & open questions

| # | Item | Status |
|---|---|---|
| A1 | Export-only boundary is final | Evidence-backed (§1); reopened only if a vendor ships a consent-safe, key-free embed API — not expected. |
| A2 | `promptExtend: false` default for Wan-class vendors | Provisional from vendor evidence (Alibaba Cloud documents the flag); per-vendor confirmation still open. |
| A3 | `bestTake` reproducibility shape | Provisional (§3); the exact metadata set is still to be verified against vendor guidance. |
| A4 | Six templates at first landing (Runway/Veo/Kling/Sora/Wan/Seedance) | Explicit; the parameter layer is documented and stable enough; adding a template = spec change. |
| A5 | Codex `visualRefs` field | Additive (same rule as `attachments`); UI = asset picker on the codex entry (v0.2-of-track polish). |