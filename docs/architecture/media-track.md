# Caotang — Screen & Media Track (functionality inventory)

> Status: built. This file is the scope list for the screen and media track; each item has its own spec.

## 0. Why this exists

Caotang began as a prose tool ("Scrivener's successful cousin"), with *screen/playwriting modes* listed as a non-goal. The scope was widened: the target is a narrative-authoring studio covering **games, videos and movies**, not only novels.

The product thesis survives the widening intact, because it is media-agnostic: *structure-first authoring + an agent that drives the app*. Binder, corkboard, inspector, codex, context-assembly and exporter all generalize from "novel" to "any structured narrative". What actually changes per medium is only:

1. the **element model** (what a node/document is: prose text, screenplay page, dialogue node, shot);
2. the **compile target** (DOCX/EPUB vs Fountain/FDX vs Ink/loc-CSV vs prompt-pack JSON);
3. the **harness tools** (which workflows the agent can run).

So this track is built as **new document kinds + new exporters + new agent tools**, never as a fork of the app.

## 1. Capability inventory

Each item: what it concretely means → how it attaches to existing modules → interop targets → open question.

### Screenplay — screenwriting & script formatting 📐 (spec: [architecture/screenplay.md](screenplay.md))
- **What:** write and format screenplays to industry standard — scene headings (INT./EXT. — LOCATION — TIME), action, character cues, dialogue, parentheticals, transitions, dual dialogue, `(MORE)`/`(CONT'D)`, page numbers, correct 12pt Courier pagination (1 page ≈ 1 minute of screen time).
- **Also:** stage plays, radio/audio drama, TV teleplays with act breaks; shooting-script conventions (scene numbers, locked pages, colored revision pages → backlog).
- **Verdict:** screenplay = **document kind + exporter recipes**, never a separate module — Fountain files *are* the binder (sections = folders, scene headings = scene nodes, `=` = synopsis field). Fountain = storage/interchange (lenient parse, forcing chars, `[[notes]]`/boneyard preserved); FDX = typed-XML interchange, import-first; paginated PDF = export-time render with the afterwriting-class MIT precedent to study/vendor. Editor = raw Fountain text + decoration styling (no element-typed schema, no paginated WYSIWYG page view); pagination at export. Coherence feed is free (cues = mention source; cue-collision/cue-consistency checks). Zero new harness tools.
- **Spec:** [architecture/screenplay.md](screenplay.md) 📐 (element model, structure mapping, three renderers w/ pagination constants + page-break fixtures, registry unchanged). Open: the Fountain parser/PDF-engine benchmark gate and the FDX production field set.

### Cutscenes & branching dialogue — interactive / game narrative 📐 (spec: [architecture/dialogue-narrative.md](dialogue-narrative.md))
- **What:** branching dialogue and cutscene authoring — nodes with speaker, lines, choices, conditions/flags, variables, jumps, plus VO/audio and camera cues; localization-ready line IDs.
- **Also:** narrative-design scaffolding — quest/mission structure, barks, item and lore text, world books (the latter already covered by `codex`), and branch visualization (which paths exist, which are orphaned, which are unreachable).
- **Verdict:** **Ink-first, text-native** — the dialogue container's body file *is* valid Ink (knots = beats, diverts = links); no per-beat tree nodes, no Caotang-side scripting language (articy's expresso/simulation = the rejected ceiling). Graph view = corkboard variant over a parse-derived projection (view-only; editing happens in Ink text). Validation = inkjs compile (loose ends/dead ends) mapped to deterministic findings. Line-ID discipline specced early (stable ids in `# lineId:` tags → `lineId, speaker, text, context, charLimit` table = the universal engine/loc/VO surface). Twine/Twee import strips logic with an honest report; articy JSON read-only. Two harness tools (`dialogue.draft`, `dialogue.table`).
- **Spec:** [architecture/dialogue-narrative.md](dialogue-narrative.md) 📐. Open: Twee import and play mode (both v0.3). The dialogue table's XLSX variant is built, on the spreadsheet stack it shares with the storyboard shot list (storyboard.md §8 A4).

### Storyboard & shot planning 📐 (spec: [architecture/storyboard.md](storyboard.md))
- **What:** turn script scenes into shot lists and storyboard panels — shot no., frame sketch or reference image, camera (angle, movement, lens), action, dialogue covered, duration, transition; sequence → scene → shot hierarchy; animatic timing.
- **Also:** production exports (shot list CSV/XLSX and the contact-sheet PDF), and per-shot coverage checks (every script line covered by a shot; every shot has a duration).
- **Verdict:** **corkboard variant + additive `shot` node kind + consensus field set** (`shotNumber` derived from order, `image` = asset ref in a new `assets/` directory, fixed enums `shotSize/cameraAngle/cameraMovement/transition`, free-text `lens`, `action`, `dialogue[]` = TextAnchor coverage refs, `durationSec`, `transition`). Storyboard container = sibling folder with `kind: 'storyboard'` (three-tier invariant preserved). Script↔shot = one-way `covers` anchors + a deterministic coverage check (no live two-way sync — nobody maintains one). Animatic MP4 + NLE EDL parked; paper-photo round-trip recorded, not built. Two harness tools (`shots.derive`, `shots.annotate`); shot fields = the camera half of an AI-video prompt pack (one data model, two export recipes).
- **Spec:** [architecture/storyboard.md](storyboard.md) 📐. Open: asset-directory note joins project-format §1 layout. The shot list's XLSX variant is built (storyboard.md §8 A4).

### AI-video prompt pack — prompt-screenwriting 📐 (spec: [architecture/video-prompt-pack.md](video-prompt-pack.md))
- **What:** author the *prompt layer* of AI video generation out of the story itself — a per-shot prompt pack: visual prompt, camera/motion direction, style/aesthetic references, character-consistency references (image/seed/identity), duration, aspect ratio, negative prompt, dialogue/VO and SFX cues.
- **Boundary (deliberate, evidence-confirmed):** Caotang **authors and exports the prompt pack + shot list**; it does not become a render farm. Generation happens in the user's own external tool with the user's own keys/accounts — the BYOK promise applied to video. No Caotang server, no media storage, no manuscript upload. In-app generation rejected permanently (per-vendor consent systems — Sora's likeness flow — make it unshippable for a local-first app).
- **Verdict:** **the API parameter layer is the schema** — one normalized shot schema (`prompt{camera,subject,action,context,style}, audio{dialogue,sfx,ambient,music}, negativePrompt, duration enum, aspectRatio, resolution, seed, promptExtend:false, references[]`) + per-vendor mapping templates (Runway/Veo/Kling/Sora/Wan/Seedance documented with exact enums + char caps). Codex entries = the consistency layer (visual-reference attachments); reference resolution = shot override → codex mentions → none, previewed per shot. Prose grammar = stable per-vendor conventions carried as draft guidance. Reproducibility: `bestTake` metadata recorded from the user's generation (seed alone insufficient — Runway's own guidance). Two harness tools (`prompt.draft`, `prompt.variant`); no vendor/network tool ever.
- **Spec:** [architecture/video-prompt-pack.md](video-prompt-pack.md) 📐. Open: reference provenance + reproducibility verification; `promptExtend` per-vendor confirmation. No per-module pricing or commercial-gated free tier is ever adopted here.

### Plot coherence & continuity 📐 (spec: [architecture/coherence.md](coherence.md))
- **What:** the app *checks* the story instead of only storing it — timeline consistency (dates, durations, day/night, season), character-state continuity (age, injuries, knowledge, relationships, who-knows-what-when), location/object continuity, causality (setup → payoff, unresolved threads, dangling foreshadowing), POV/voice consistency, and cross-medium consistency (script ↔ storyboard ↔ cutscene branches).
- **Two classes of check, deliberately separated:**
  - **Deterministic** — computed from structure + codex with no model call: scene order, timeline arithmetic, character presence per scene, mention/alias graph, orphaned branches. Cheap, testable, eval-stable.
  - **LLM-judged** — plausibility, motivation, pacing, tone. Runs through the harness with plan preview; output is a **report of findings with cited evidence** (document + quote), never a silent edit.
- **Attaches to:** builds directly on `codex` (entity/state records), `context-assembly` (what the model is shown) and the harness report/plan-card UX; a new `coherence` module would own check definitions, run history and a findings inbox.
- **Why it matters most:** it is the only item in this track that also makes plain prose writing better, so it is not gated on any media format work.
- **Resolved:** the two-class split is the architecture; full spec at [coherence.md](coherence.md) 📐 (findings model, 8 deterministic checks over SceneMeta + mention caches, ConStory 4-stage LLM pipeline as `coherence.review`, findings lifecycle with dismiss-with-reason, 3 harness tools, `coherence.json` artifact). Cross-medium consistency (script ↔ storyboard ↔ cutscene) stays deferred until the screenplay, dialogue and storyboard artifacts exist (coherence.md §11-A4). Fact store = codex entries confirmed + `worldRules[]` additive (coherence.md §4.3); SceneMeta day-offsets stand, a constraint-solver timeline model rejected for the first landing, `timelineMode` field a twice-evidenced data class (coherence.md §11-D10). Open: scene dependency types and a `knowledge.leak` check. **Scope note:** of the *What* list above, causality is covered today only by the LLM review's timeline-plot category, whose prompt names plot causality (coherence.md §5.3). The setup → payoff model is specced (coherence.md §5.5) and built in part: a writer-declared thread on the setup scene and a deterministic `plot.unresolved-thread` check. Its foreshadowing pass is a timeline-plot subtype of the model review (coherence.md §11-D13) and is not built. The quest and bark scaffolding of the cutscenes and branching dialogue item is unspecced and backlog; it needs a spec section and fixtures before it can be built, so the current build does not claim it.

### One source, many outputs — the cross-cutting compile 📐

The unifying idea behind the items above: **a single narrative source compiled to many targets** —

| Target medium | Format | From |
|---|---|---|
| Novel / prose | MD, TXT, DOCX, EPUB | existing `exporter` 📐 (EPUB = client-side, exporter.md §3a) |
| Screenplay | Fountain, FDX, PDF | [screenplay.md](screenplay.md) §5 (`FountainRenderer` identity + `FdxRenderer` import-first + `PdfRenderer` paginated) |
| Game narrative | Ink JSON (compiled), dialogue table CSV/XLSX | [dialogue-narrative.md](dialogue-narrative.md) §4 (`DialogueTableRenderer` + inkjs compile passthrough) |
| Production | Shot list CSV/XLSX + contact-sheet PDF | [storyboard.md](storyboard.md) §6 (`ShotListCsvRenderer` and its XLSX variant + `ContactSheetPdfRenderer`) |
| AI video | Per-vendor shot-prompt pack (JSON/MD/CSV) | [video-prompt-pack.md](video-prompt-pack.md) §5 (`PromptPackRenderer` + vendor templates) |
| Review | Coherence report (MD/JSON) | [coherence.md](coherence.md) (findings export = the standard report path) |

That is the existing exporter contract (select subset → order → render via template) generalized: **media targets are export recipes, not separate apps**. Consequence for the data model: binder nodes need a `kind` vocabulary with per-kind metadata, and the compile pipeline needs per-kind renderers. Both are additive to the `project-format.md` / `exporter.md` specs, with no `formatVersion` implication: *(the `kind` vocabulary and per-kind metadata are **additive manifest fields** under the project-format unknown-tolerance rule (§6 — unknown fields preserved in memory, dropped on next save by old loaders, one-time notice), and media compile targets are new entries in exporter's closed recipe shape — **no `formatVersion` bump needed** for the same reason codex[] and coherence.json carry none: no wild artifacts exist before implementation.)*

## 2. Guardrails — what this does NOT change

- **One app.** The track is new document kinds, export recipes and agent tools inside the same app, never a fork of it.
- **Local-first / BYOK / no server / no telemetry** hold. The AI-video prompt pack in particular: Caotang produces prompts, the user runs generation elsewhere with their own credentials.
- **Agent = tools + plan loop + undo** holds: coherence findings and prompt drafts are *proposals* applied through the command bus, visible and reversible.
- **Files are ownable** holds: every new artifact is plain text (Fountain, Ink, Markdown, JSON, CSV). No binary project formats, no proprietary story files.
- **Registry rows.** The harness registry holds **32 rows** (`packages/harness/src/metadata.ts`): the frozen 14 of v0.1, with `agent.plan` the fourteenth, and 18 extension rows. The track contributes six of those: storyboard's `shots.derive` and `shots.annotate` (storyboard.md §4), prompt-pack's `prompt.draft` and `prompt.variant` (video-prompt-pack.md §6), and dialogue's `dialogue.draft` and `dialogue.table` (dialogue-narrative.md §7). Screenplay adds none (screenplay.md §6). The other twelve are `doc.import` and `codex.import`, the coherence module's three (`coherence.scan`, `coherence.review`, `coherence.setFindingStatus`), `tool.search`, `skill.load` (extensibility §10), and the five allowlisted bus primitives (agent-harness §3). agent-harness §10 has the full account, and the MCP server lists a subset of the rows (mcp-server README).
- **Sequencing inside the track** is recorded in §3.

## 3. Shipping order

The track was built in this order:

1. **Plot coherence** — highest leverage, nearest to the core modules (`codex`, `context-assembly`, harness), and the only item that improves prose too. It needs no new document kind, authoring surface or export format, and its evidence-cited findings pipeline is the machinery the storyboard's `script.shot-coverage` and the prompt pack's reference provenance lean on.
2. **Screenplay** — the most standardized format space (Fountain/FDX are stable), and the cheapest way to validate "document kind + exporter template" generalization.
3. **Storyboard and shot planning → AI-video prompt pack** — the prompt pack depends on the storyboard's shot model; both are export-side and low core-risk.
4. **Cutscenes / branching dialogue** — biggest data-model lift (graph + conditions + localization), so last.
