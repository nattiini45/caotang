# Timeline — an interactive story timeline with approved edits

> Status: **specified, not built.** There is no timeline view, no `timeline.apply` command, no timeline tool and no timeline export in the current build; scene timing is edited only as number fields in the Inspector (coherence.md §8). The coherence-model change this spec needs (negative day offsets and declared prologue, main and epilogue parts, §2) is specified here and in [coherence.md](coherence.md) §5.2.2, and is not built either (#175). The decisions in §12 bind the work when it is cut.
> Scope: a view of the story on three axes (story time, reading order, both braided); edits made on it only ever become **proposals** the writer approves, applied as one undoable command; prologues before day 0 and epilogues after long time jumps as first-class parts of the story; the agent, export and MCP surfaces; pictures, screenplay, storyboard, dialogue and comics on the same view.
> Cross-refs: `SceneMeta`, the timeline checks and the exemption table = [coherence.md](coherence.md) §5.1–§5.2.2 · bus, undo and the registry = [command-bus.md](command-bus.md) §5/§9 · plan cards, primitives and modes = [agent-harness.md](agent-harness.md) §2–§4/§10 · corkboard and centre views = [ui-modules.md](ui-modules.md) §3 · media formats = [exporter.md](exporter.md) · MCP server = [extensibility.md](extensibility.md) · pictures = [pictures.md](pictures.md) §9 · comics = [comics.md](comics.md) §6.

## 0. What exists today (the timeline reuses it)

| Area | Where | What it gives the timeline |
|---|---|---|
| Scene declarations | `packages/coherence/src/model.ts` `SceneMeta` (`coherence.json` `sceneMeta`, keyed by node id: documents, and folders for spans) | `dayOffset` (whole days from day 0, **today ≥ 0**), `durationDays`, `after[]` (finish-to-start), `pov`, `expectedPresent[]`, `timelineMode` (11 modes), `threads[]`, `learns[]`/`knows[]`, `dialogueContainer` |
| Time maths | `packages/coherence/src/timeline.ts` | `windowOf` (half-open `[d, d + max(dur, 1))`), `windowsOverlap`, `windowInside`, `GAP_THRESHOLD_DAYS = 7`, the exemption table as data (`treatmentOf`) |
| Timeline checks | `packages/coherence/src/checks/timeline.ts` | order-drift (whole and per strand), relation, window, overlap, gap; `knowledge.leak` uses story order |
| Pure scan | `packages/coherence/src/run.ts` `runDeterministic` | Runs on a hypothetical state: the basis of the what-if preview (§4.4) |
| Patch rule | `packages/bus/src/coherence.ts` `applySceneMetaPatch` | One validation rule for the Inspector, the store and the agent; `dayOffset` and `durationDays` must be whole numbers ≥ 0 today |
| Bus command | `coherence.setSceneMeta`, write-auto, inverse undo | Inspector edits apply immediately; not exposed to the model (coherence.md §7) |
| Reorder | `binder.move`; `planCardDrop`, `planKeyboardMove` | Narrative-order changes, Alt+Arrow |
| Batch validation | `packages/harness/src/tools/restructure.ts` `projectedSnapshot`; `packages/store/src/state.ts` `siblingOrderAt` and its renormalisation | Shows what a later op must see. **Not reusable as it stands:** `projectedSnapshot` carries no coherence file and changes parents without sibling order, and a move can renormalise a sibling set. The timeline adds a pure bus projection that reproduces the store's canonical move, index and order semantics (§4.3). |
| Undo | `packages/bus/src/undo.ts` | One agent turn = one group; one user command = one group; **no multi-command user group**, so a user batch is one batch command (`shot.importImages`) |
| Approve and preview | plan cards, `submitPlan`, `plan-preview.ts`, `PlanCard.tsx` | The proposed edit → review → apply → checkpoint model |
| Centre views | `Workspace.tsx` `CENTER_VIEWS = ['editor', 'corkboard']`, a radiogroup; `lazy-view.tsx` | Where Timeline joins, as a lazy chunk |
| Exports | `MEDIA_FORMATS`, `render-xlsx.ts`, `render-contact-sheet.ts` (pdf-lib), `png-encode.ts` | Timeline CSV, XLSX, PDF |
| Guards | `tools/check-bundle-size.mjs`, the CSP, `test/registry.test.ts`, the user-guide and not-in-this-build tests | A new command, tool or format starts in its spec and lands with spec, decisions.md, USER-GUIDE and CHANGELOG |

## 1. Evidence: prior art and the pain points this design avoids

| # | Pain point (evidence) | How the design avoids it |
|---|---|---|
| P1 | Two-app sync drift and all-blocking conflicts (Aeon forum 2546, KB 218) | No sync: the timeline is a view of `SceneMeta` and the binder. `expect` guards and stale rows block only affected rows. The binder is the narrative truth. |
| P2 | Working on a scene does not select it on the timeline (Aeon forum 1186) | Selection sync (§4.6), never stealing focus. |
| P3 | Data-entry burden (Aeon forum 3143; L&L forum 147087) | Adaptive default axis (§3.3); drag from the shelf; agent proposals; no field is ever required. |
| P4 | Forced dates (Campfire: the Iliad "in January 1970") | Undated is first-class with its own shelf (§3.7); no default day is ever written. |
| P5 | Calendar lock-in (Aeon 3.4; forum 3143) | The `CalendarLens` is display-only and swappable (§3.8). |
| P6 | Accidental drags (ClickUp, 230 votes; TruePPM #492) | Nothing writes before Apply; a bar needs pointer-down plus 4 px; Esc cancels; background drag only pans. |
| P7 | All-or-nothing review (Figma; Google Docs "Accept all") | Per-row checkboxes, *Apply selected*, an "N off-screen" chip, count-named Apply. |
| P8 | Silent cascades (Aeon re-dates; PostRoll relative events lag) | No cascades; dependants are suggested, unchecked (§4.5). |
| P9 | Scale (Aeon 3–5 s at 850 events; vis-timeline #379, #1281; TimelineJS ~5k) | 2,000-scene budget, start-sorted sweep, ≤ 1.5k live DOM nodes (§7). |
| P10 | Export: one giant PDF page, lines cut in half, no SVG (Aeon forum 1264; Plottr cannot print) | Paginated PDF that never cuts a chip, headless SVG (§8). |
| P11 | Two structures to maintain (L&L 8208) | One binder, one `SceneMeta`; the braid draws the mapping. |
| P12 | The timeline view is rarely used; grids are preferred (Plottr, Dabble) | Narrative axis × thread or character lanes *is* the plot grid, at zero data cost. |
| P13 | One scene, one subplot (Aeon forum 1186) | A scene appears in every thread or character lane it belongs to. |
| P14 | Keyboard and screen-reader gaps; NVDA swallows arrow keys in grids (react-calendar-timeline #263; reka-ui #2502; ADI guidance; W3C APG) | Grid plus Agenda view, names with days and duration, non-drag moves, an NVDA pass-through test (§6). |
| P15 | Intelligibility at volume (Knight Lab) | Semantic zoom into chapter and act blocks. |
| P16 | Character paths are hard to see; the subway view is the "most useful tab" (Aeon forum 3143) | Subway overlay (§3.9). |
| P17 | Calendar and timeline silos (World Anvil) | One lens contract for view, exports and MCP. |
| P18 | Prologues are written after scene one and have nowhere to go before day 0; epilogues sit years after the story and read as a gap error (owner, 2026-10-23; Aeon offers "earliest date" as Day 0) | Negative day offsets and declared prologue and epilogue parts in the store (§2.2–§2.4), placed explicitly on every surface (§3.4). |

Sources are listed in §13.

## 2. Story time in the store

### 2.1 Integer day offsets are the right store

Writers' "fuzzy dates" are three different needs. **Relative time** ("three days after the first murder") is exactly what `dayOffset` is: Aeon's Daily relative style, with day 0 as the epoch. **Order without dates** is an undated scene with `after[]` links, shown on a sequenced shelf (§3.7). **Uncertainty** ("between day 40 and 55") is not stored in the first landing (D6): every check would need a rule for which end counts. The Novel Kit's craft argument, "prefer relative to absolute where you can", is the day-offset stance.

### 2.2 Negative day offsets

Day 0 is the story's reference day, usually the opening. **`dayOffset` may be any whole number from −10,000,000 to 10,000,000** (about 27,000 years either way), so a prologue two weeks or ten years before the opening is stored as what it is: `dayOffset: -14` or `-3650`. `durationDays` stays a whole number ≥ 0. Every check already works on differences (gap, overlap, relation, order, window, knowledge), so negative days change no check arithmetic; `windowOf`, `windowsOverlap` and `windowInside` are sign-agnostic.

This is a coherence-model change, specified in [coherence.md](coherence.md) §5.2.2 and built by T1b (§11):

- `applySceneMetaPatch` accepts a whole number in range and refuses anything else with "a whole number of days between −10,000,000 and 10,000,000". `durationDays` keeps its ≥ 0 rule.
- The `coherence.json` codec loads a negative offset instead of dropping it. A file written before the change loads unchanged. A build from before the change drops a negative offset on load with its existing notice; the CHANGELOG says so when T1b ships.
- The Inspector's day field accepts a minus sign and shows "Day −14".
- The MCP server's `coherence.json` merge already never touches scene declarations; `@caotang/scan` reads the same codec.

**Shift all days** stays as an optional tool (§4.3): it renumbers the whole story (for example to put day 0 back on the opening after a prologue was dated at 0), but it is never needed to make room before the first scene.

### 2.3 Prologue, main story and epilogue as declared parts

Negative days alone would leave a prologue as "a scene at day −3650" and an epilogue as "a scene 12 years after the last one". Both are first-class parts of the book, so the writer declares them:

```ts
type DeclaredStoryPart = 'main' | 'prologue' | 'epilogue';
interface SceneMeta {
  // … coherence.md §5.2 fields …
  storyPart?: DeclaredStoryPart;   // absent = inherit the nearest declaration, then the main story
}
```

- **Absence means inheritance, not a fourth value.** A document with no `storyPart` inherits the nearest declaration above it — its parent folder's, then the folder's own parent, and so on — and the main story when no declaration exists. A folder's declaration covers the scenes under it. The declaration is read from the tree; a part is never inferred from days, binder position, title or content.
- **`'main'` is a declaration, not the absence of one.** A scene inside a prologue folder that sets `storyPart: 'main'` is a main-story scene: the folder's declaration does not reach it. *Move to main story* writes `'main'`; it never clears the field and **never moves the binder node**. *Clear* writes `null`, which removes the declaration and restores inheritance from the nearest folder (or the main story).
- `coherence.setSceneMeta`'s patch gains `storyPart?: DeclaredStoryPart | null` (`null` clears). An unknown value is refused with the three valid values listed; on load an unknown value is ignored with a one-time notice and the scene inherits, as an unknown `timelineMode` falls back.
- The **effective part** is computed when read — `effectiveStoryPart(tree, sceneMeta)`, a pure function shared by the checks, the layout, the tray and the exports — and is **never written into children**. Changing a folder's declaration re-parts its children with no write of theirs and no undo row per child.
- `storyPart` is independent of `timelineMode`: an epilogue can be `linear` or `time-skip`, a prologue can be `backstory` or a `flash-forward` (an in-medias-res prologue).
- A scene at day −14 with no declaration anywhere is a **main-story scene dated before day 0**, and is drawn in the main zone at its own day.

### 2.4 What the checks do with parts

Specified in coherence.md §5.2.2:

- **`timeline.gap`:** a pair whose scenes' **effective parts** differ after inheritance (prologue → main, main → epilogue, prologue → epilogue, and a scene whose explicit `main` overrides a prologue folder) is skipped. Crossing into an epilogue or out of a prologue is the declared intent, the same way `time-skip` is. Gaps *within* a part are checked as before, so two epilogue scenes a month apart still draw the note. `time-skip` keeps exempting its pairs.
- **`timeline.order-drift`, `relation`, `window`, `overlap`, `knowledge.leak`:** unchanged and fully checked, with negative days compared like any others. A prologue that is read first and happens first draws nothing; a prologue placed after chapter 3 in the binder with an earlier day draws order-drift, as any scene would, unless its mode exempts it.
- No new check and no new finding shape: `storyPart` has exactly one check consumer (the gap boundary rule); the timeline layout, tray, exports and agent read it for placement.

### 2.5 Relative placement as a gesture, not a stored anchor

"Place N days after…" (context menu, Alt+R) computes an absolute `dayOffset` at proposal time and can also propose `after_add` for the anchor. If the anchor later moves, nothing is re-dated: `timeline.relation` reports a broken order and the tray's dependant suggestions (§4.5) offer the matching move. This avoids PostRoll's two sources of truth.

### 2.6 Known limit: sub-day time

`durationDays` is an integer and there is no time of day. Same-day scenes order by binder position or `after[]`; screenplay DAY/NIGHT chips show the text's own cue. Hours would add a second unit to every check, a later schema decision. Travel time and time zones are out of scope.

## 3. The view model

### 3.1 A pure package: `packages/timeline` (`@caotang/timeline`)

No DOM, so the desktop view, the exporter (PDF, SVG, CSV, XLSX) and the MCP server share one layout. Dependency direction: `timeline → coherence → store → bus`.

```ts
buildTimeline(state: ProjectState, file: CoherenceFile, opts: TimelineOptions): TimelineModel
interface TimelineOptions { axis: 'story' | 'narrative' | 'braid'; groupBy: LaneKey; zoom: Zoom; lens: CalendarLens;
  scope?: nodeId; includeDetectedMentions?: boolean; findings?: 'open' | 'none'; compressGaps?: boolean }
type LaneKey = 'none' | 'pov' | 'character' | 'mode' | 'folder' | 'location' | 'thread';
type StoryPart = 'prologue' | 'main' | 'epilogue';
interface TimelineItem { nodeId; kind: 'scene' | 'folder-band' | 'picture' | 'shot-strip' | 'page-strip';
  medium: 'prose' | 'screenplay' | 'dialogue' | 'storyboard' | 'comic'; part: StoryPart; lane: string; row: number;
  start?: number; end?: number;            // story days (windowOf), may be negative; undefined = unscheduled
  readingIndex: number; measure: number;   // narrative slot and width (words / pages / panels)
  mode: TimelineMode; glyph: ModeGlyph; findings: FindingRef[]; partNote?: 'dated-inside-main'; label: string; a11yLabel: string }
interface PartZone { part: StoryPart; startDay?: number; endDay?: number; firstReading?: number; lastReading?: number; count: number }
interface TimelineModel { items; lanes; zones: PartZone[] /* always in order prologue, main, epilogue; empty parts omitted */;
  axis: AxisModel /* segments, ticks, breaks, folds */; connectors: Connector[] /* after, thread, braid, presence, finding-pair */;
  unscheduled: { sequenced: Chain[]; loose: TimelineItem[] }; bands: FolderBand[] }
```

Mode rendering is a data table beside `EXEMPTIONS` (`packages/timeline/src/mode-render.ts`), so a new mode is one row in each table.

### 3.2 Axes

- **Direction follows the project language, independently of the interface.** Both axes — story time and reading order — advance **right-to-left when `project.language` is a right-to-left language** (the `directionOf` list of i18n §3.2) and left-to-right otherwise. The live view, `timeline-svg`, `timeline-pdf` and the browser PNG all use that geometry: ticks, chips, connectors, folder bands and part folds run the same way, and a fold is announced and labelled on the reading side. **The canonical model does not flip:** `TimelineModel.items`, `zones`, the shelf chains and the CSV/XLSX rows stay in logical order — part, then day, then reading index — so a tool reading the data never needs to know a direction. **UI controls follow the interface direction:** the axis toggle, the Agenda's columns and the keyboard chords are laid out for the interface, so the arrow that points toward the interface's start moves toward the earlier day or reading slot (in an RTL interface, → is earlier and ← is later). A comic page keeps the **comic book's own** `readingDirection` (comics.md §2) and follows neither language.
- **Story time:** x = `dayOffset` within the scene's part zone (§3.4), width = `windowOf`. Same-day scenes stack in rows (start-sorted sweep with an interval-end min-heap per lane).
- **Narrative (reading order):** x = binder reading order; slot width uniform or proportional to the medium's measure. Unscheduled scenes appear normally.
- **Braid:** a narrative strip on top, the story axis below, a connector from each scene's reading slot to its day; flashbacks and flash-forwards show as crossing lines; connectors cross the part folds.
- A segmented radiogroup switches axis, keeping selection and scroll anchor by node id.
- **Gap compression:** within a part, runs of empty days ≥ `GAP_THRESHOLD_DAYS` collapse into an axis break labelled "+N days"; a `time-skip` scene's break reads "Time skip (declared)"; others link to the `timeline.gap` finding if one exists.

### 3.3 Adaptive default axis

`defaultAxis = scheduledShare(scope) >= 0.5 ? 'story' : 'narrative'`, computed on first open per project; afterwards the last choice is kept as view state. The toggle shows the share ("Story time · 38 of 120 scheduled"). An empty story axis carries one call to action: "Drag scenes from the shelf onto a day, or ask the agent to propose days from the text."

### 3.4 Part zones and folds (prologue and epilogue placement)

Placement of the three parts is explicit in the layout, not a side effect of the numbers:

- **Story axis:** the axis is split into up to three **zones**, always in the order Prologue · Main story · Epilogue in the canonical model, each with its own day range. A zone exists only when a scene's **effective part** (§2.3) is that part; in the view the zones run in the reading direction of §3.2. Zones are separated by a **fold**: an axis break that is always drawn, whatever the distance, labelled through the lens with the part and the span, such as "Prologue · about 10 years before Day 0" and "Epilogue · 12 years later". A fold is never linked to a `timeline.gap` finding, because the check skips cross-part pairs (§2.4).
- **A day can sit outside its zone's expected side.** A prologue scene dated after the main story's first day stays in the prologue zone at its own day and carries a "dated inside the main story" note (`partNote`, in text and as a glyph, never colour alone); the same holds for an epilogue dated before the main story's end. The layout never moves a scene to another part.
- **Narrative axis:** prologue and epilogue scenes stay at their binder positions; a band labelled "Prologue" or "Epilogue" spans each run of them. A declared part whose scenes are not at the binder's start or end still gets its band where they are.
- **Braid:** the story strip carries the zones and folds; reading-order connectors cross them.
- **Shelf:** undated prologue and epilogue scenes sit on the unscheduled shelf in a "Prologue" or "Epilogue" group ahead of the main groups, so the part is visible before the scene has a day.
- **Zoom and scope:** semantic zoom keeps the zones (a zone aggregates to one block with a count at Act zoom); scoping to a folder shows only the zones its scenes fall in.
- **Lanes:** zones are vertical bands across every lane; group-by does not change them.

### 3.5 Lanes (group-by)

| Lane key | Source | Vertical drag between lanes |
|---|---|---|
| none (packed) | — | — |
| POV | `SceneMeta.pov`; a "No POV" lane | Proposes `pov` |
| Character | `expectedPresent`; optional detected mentions, drawn hollow and dotted as inferred; a scene appears in every lane it belongs to | Read-only |
| Mode / strand | Main (linear, time-skip, flashback, flash-forward, circular, simultaneous), Parallel strand, Frame, Dream & mythic, Backstory | Proposes `timelineMode` |
| Folder | binder parent; folder spans as bands | Read-only on the story axis; on the narrative axis a horizontal drag is `binder.move` |
| Location | codex `place` entries attached or detected; "Unplaced" lane | Read-only |
| Thread | `threads[]`, one lane per handle; a scene appears in every thread lane it belongs to | Read-only |

### 3.6 How each timeline mode renders

| Mode | Placement | Visual (always a glyph and a pattern, never colour alone) |
|---|---|---|
| linear | at its day | solid bar |
| flashback / flash-forward | at its story day; its braid connector crosses | ↶ / ↷, connector emphasised |
| backstory | at its day, in the Backstory lane under group-by mode | hatched bar, "Backstory" tag |
| dream / mythic | own lane; a dotted tether to the day it is dreamt when dated, otherwise the shelf | translucent bar, ☾ / ✶; never counted in Main overlap visuals |
| parallel | own strand lane, ordered among itself | double-edge bar |
| frame | top Frame lane; first and last scenes bracket the inner story | bracket caps `[ ]` |
| simultaneous | stacked in one column with a "Simultaneous" bracket; no overlap highlight | ‖ |
| circular | at its day; braid links it back to the first scene | ↻ |
| time-skip | at its day, preceded by a labelled break | ⇥ |
| (no `dayOffset`) | the unscheduled shelf | dashed outline |

`storyPart` is drawn by the zone, not by a mode glyph, and combines with any mode. Overlays from a *Show* menu: `after` arrows (violations drawn as errors), thread arcs, knowledge markers (● learns, ○ knows; a `knowledge.leak` as an error) when a character lane is focused.

### 3.7 The unscheduled shelf: sequenced and loose

`unscheduled.sequenced` holds chains built from the `after[]` subgraph restricted to undated scenes, sorted topologically with binder order as the tie-break; a cycle is drawn as a broken chain with an error glyph. Undated scenes whose `after` targets are dated are in the sequenced group with an "after Day 12" hint. `unscheduled.loose` holds the rest in reading order. Prologue and epilogue groups come first (§3.4). Dropping a scene on a day earlier than its `after` allows still creates the proposal; the what-if delta shows the `relation` error it would cause.

### 3.8 The `CalendarLens` contract

```ts
interface CalendarLens {
  id: string; name: string; lensApi: 1;
  label(day: number, form: 'short' | 'long'): string;              // "Day −14" | "12 Rains, Year 3"
  span(fromDay: number, toDay: number): string;                     // "about 10 years" — fold labels (§3.4)
  ticks(range: [number, number], pxPerDay: number): Tick[];         // week / month / year / era boundaries
  parse?(text: string): number | null;                              // "12 Rains 3" → day, for "Set day…"
}
interface Tick { day: number; level: 0 | 1 | 2 | 3; label: string } // 0 = finest
```

- **First landing:** only `dayLens`: "Day N" with the minus sign for negative days, week ticks every 7 days, year ticks every 365 days at coarse zoom, and `span` in days, months (30 d) or years (365 d) with "about" when rounded.
- **v0.3 (T13):** user lenses defined as data (month lengths, leap rules, intercalary days, eras), stackable as extra tick rows. A lens is a pure function, so switching or redefining one never migrates data; year 0 and leap rules are the lens's business, not the store's.
- The exporter and MCP use the same lens, so a CSV can carry a label column.

### 3.9 Zoom, subway and lifespans

- **Story zoom:** Day (≈ 48 px/day, full titles, thumbnails) → Week → Month (30 d) → Fit all (density bars, no labels). **Narrative zoom:** Scene → Chapter → Act, folders aggregating into blocks with counts and an open-findings badge. Ctrl+= / Ctrl+−; `ZoomControl.tsx` reused. Zoom, axis, lanes and scope are view state; no command.
- **Subway overlay:** `connectors` gains `kind: 'presence'`, one polyline per character lane through that character's scheduled scenes in story order (narrative order on the narrative axis), crossing folds. Off by default above 30 characters in scope, with a per-character chip.
- **Codex lifespans:** a derived appearance span per character lane (first to last scheduled scene). Born and dies days would need codex fields; backlog.

## 4. Interactions and the approval model

### 4.1 Principle

**Every edit gesture on the timeline produces a proposal, never a write.** Proposals collect in a **Proposed changes tray** docked in the view. Nothing reaches the bus until the writer presses **Apply**, which dispatches **one** command: one undo group, one activity row, one checkpoint. The Inspector's immediate `setSceneMeta` edits stay as they are (typed field edits, not spatial gestures); this rule is stated so the two surfaces do not drift.

### 4.2 Gestures → proposal ops

| Gesture (pointer) | Keyboard (focused scene) | Proposal op |
|---|---|---|
| Drag a bar horizontally (story axis) | Alt+←/→ ±1 day, Alt+Shift+←/→ ±7 | `meta {dayOffset}` |
| Drag the right edge | Alt+[ / Alt+] | `meta {durationDays}` |
| Drag across POV or mode lanes | Alt+↑/↓ | `meta {pov}` or `meta {timelineMode}` |
| Drag into another part zone, or onto a fold's part label | context menu *Make prologue* / *Make epilogue* / *Move to main story* | `meta {storyPart}` (plus `dayOffset` when dropped on a day). *Move to main story* writes `'main'` — it never clears the field and never moves the binder node; *Clear* is what restores inheritance. |
| Drag on the narrative axis | Alt+←/→ | `move {nodeId, newParentId, index}` via `planCardDrop` / `planKeyboardMove` |
| Drag from the shelf | Enter → *Set day…* (the lens's `parse`) | `meta {dayOffset}` |
| Drag folder band edges | — (Inspector) | `meta` on the folder |
| Draw an arrow scene → scene | *Must follow…* | `meta {after_add}` / `after_remove` |
| *Place N days after…* | Alt+R | `meta {dayOffset}` and optionally `after_add` |
| *Shift all days…* | from the view menu | `shift` |
| Finding quick action (§5.3) | the badge menu | `meta {timelineMode}` or `move` |
| Multi-select + drag | Shift-select, then nudge | one op per scene, or one `shift` above 20 scenes |

Successive nudges to one scene coalesce (the base value kept, the latest target winning); an op that returns to its base value drops out. A bar needs pointer-down on the bar plus a 4 px threshold; a drag on empty background or with the middle button pans; Esc cancels a drag in flight. **The Alt+←/→ and Alt+Shift+←/→ chords follow §3.2's interface direction:** the arrow pointing toward the interface's start moves toward the earlier day (in an RTL interface, → is earlier).

### 4.3 The batch command: `timeline.apply`

```ts
'timeline.apply': { ops: TimelineOp[] /* 1..200 */; label?: string }
type MetaExpect = {
  dayOffset?: number | null;      // the value the plan read; null when it was absent
  durationDays?: number | null;
  timelineMode?: TimelineMode | null;
  pov?: string | null;
  storyPart?: DeclaredStoryPart | null;
  after?: string[] | null;        // the complete before-array; null when it was absent
};
type TimelineOp =
  | { op: 'meta'; nodeId: string;
      patch: Pick<ScenePatch, 'dayOffset' | 'durationDays' | 'timelineMode' | 'pov' | 'storyPart' | 'after_add' | 'after_remove'>;
      expect: MetaExpect }                    // every field the patch changes, present here
  | { op: 'move'; nodeId: string; newParentId: string; index: number; expect: { parentId: string; index: number } }
  | { op: 'shift'; delta: number /* ≠ 0 */; nodeIds: string[] /* 1..5000, dated only */; expect: { fingerprint: string } }
  | { op: 'picture-when'; linkId: string; when: { dayOffset?: number; label?: string } | null; expect: { when: { dayOffset?: number; label?: string } | null } }   // §9.1
```

- **agentRisk `write-confirm`, undo `inverse`:** meta ops are undone by the store's own inverse capture of the values they replaced (`null` where absent); moves replay back in reverse order; a shift is undone by the same shift with `−delta`.
- **`expect` guards every changed field.** A `meta` op whose patch changes a field must carry that field in `expect`: the scalar fields as their prior value or `null`, and `after` as the **complete before-array** (or `null` when it was absent) whenever the patch names `after_add` or `after_remove`. An `expect` entry the op needs but does not carry is refused at validate, not read as "no opinion", so a stale row cannot approve one field while another has moved. **`expect` is a stale check only:** it is not the undo artifact, and a re-based proposal is recomputed from current state rather than replayed from `expect`.
- **Validated whole, in order, against one projection.** Each `meta` op runs through `applySceneMetaPatch` (so negative days and `storyPart` follow §2.2–§2.3); each `move` runs through a **pure bus projection** that applies the ops in order to a structural snapshot carrying the tree, every sibling set's orders and the scene declarations, and uses the **same canonical order algorithm the store installs** — index resolution, gap-encoded order and sibling renormalisation (`siblingOrderAt`) — so a later op sees the parents, indices and renormalised sibling orders its predecessors leave. The harness's `projectedSnapshot` is **not** lifted into the bus: it carries no coherence file and changes a parent without establishing sibling order. Preview, what-if and application read the same projection result. Each `shift` checks that every resulting day stays within ±10,000,000. An `expect` mismatch is a `conflict` naming the scene ("‘The Ferry’ changed since this was proposed: day 12 is now 13").
- `shift.fingerprint` hashes the `(nodeId, dayOffset)` pairs at proposal time; a mismatch is refused naming how many scenes changed. The cap is 200 *ops*, so shifting a 5,000-scene series is one op.
- The store applies meta ops in `commands-coherence.ts` and moves through the existing move apply, in one `ApplyContext`. The activity row names the counts and parts: "Timeline: 5 changes (3 days, 1 duration, 1 move)", "Timeline: shifted 412 scenes by +14 days", "Timeline: ‘Coda’ is now the epilogue".
- Why one command and not N `setSceneMeta` calls: `undo.ts` gives every user command its own group, and one approval must be one undoable unit (D1).
- Spec rows: command-bus §9 (`test/registry.test.ts` parity), coherence.md §7.1, this spec.

### 4.4 The tray

- **On the timeline:** the original position faded, the proposed one as a dashed ghost with a connector, a numbered marker matching the tray row. A proposal that changes a scene's part draws the ghost in the target zone.
- **Rows** name the part whenever it is not the main story, or when it changes: "‘The Ferry’ day 12 → 14", "‘Before’ (prologue) day −3,650 → −3,640", "‘Coda’ main story → epilogue, day 4,400", "‘Letter’ moved after ‘Storm’ in Chapter 3". A row whose result dates a prologue scene inside the main story (or an epilogue before its end) carries the "dated inside the main story" note. Each row has a checkbox, an editable value and a remove button. Buttons: **Apply N** (the label names the counts: "Apply 5: 3 days, 1 duration, 1 move") · **Apply selected** · **Discard all**; an "N off-screen" chip scrolls to unseen rows.
- **What-if delta:** on each change (debounced ~150 ms, after the drop), `runDeterministic` on a clone of the coherence file with the patched `sceneMeta` and a projected tree, over the timeline checks, `knowledge.leak` and `plot.unresolved-thread`; diffed by `checkId + factGroup` against the open findings: "Resolves 2 · New 1: ‘Letter’ is declared to follow ‘Storm’ but happens on day 9". Nothing is upserted.
- **Stale rows:** if base values change under the tray (Inspector edit, agent turn, undo), affected rows show the plan card's stale state and cannot be applied until re-based or removed.
- The tray is in-memory view state; leaving the view or project with pending rows asks first.
- **Undo:** Ctrl+Z at app level and the activity checkpoint row take back the whole batch.

### 4.5 Dependant suggestions, no cascades

Moving a scene never moves another. When a `meta {dayOffset | durationDays}` proposal moves scene B, the tray computes each scene A with `B ∈ A.after` that would newly violate `A.day ≥ B.day + B.dur` and adds one **suggested** row per A ("Also move ‘Letter’ to day 15? It must follow ‘Storm’"), unchecked, with *Check all suggestions*. Suggested rows count in the what-if delta only when checked. One hop at a time; at most 10 visible plus "+N more"; switchable off in *Show*. A `shift` op moves its whole set together and creates no suggestions inside it.

### 4.6 Selection sync

When the editor's active document changes, the timeline marks its chip (outline, `aria-current="true"`) and scrolls it into view only if it is off-screen and the timeline is not focused. Selecting a chip never changes the editor; Enter does. View state only, with a toggle.

## 5. The agent and findings

### 5.1 Agent-proposed timeline edits

- Deferred harness rows (`surface: 'extension'`, `load: 'deferred'`, keywords "timeline, day, chronology, schedule, prologue, epilogue"):
  - `timeline.read` (read): the `TimelineModel` serialised as scenes in story order per part (part, day, duration, mode, pov, folder), the zones and their spans, the unscheduled list, folder spans and the open timeline findings; capped at ~8k tokens, truncated by scope.
  - `timeline.edit` (write-confirm): params map one-to-one onto `timeline.apply` ops (closed keys), built with `primitiveTool`, so it needs a decisions.md owner line. Its preview is `{ rows: {node, part, field, before, after}[], findingsDelta }`, a new preview kind in `plan-preview.ts` rendered in `PlanCard.tsx` with the tray's row component.
- Typical uses: "schedule the unscheduled scenes from their text cues", "make chapter 3 a flashback", "mark the last chapter as the epilogue, twelve years later", "fix the timeline findings".
- **Modes (D5):** `timeline.edit` is not in `ACCEPT_EDITS_TOOLS`, so *Accept edits* still asks; *Auto* approves it like any native card. `coherence.setSceneMeta` stays unexposed; timing reaches the agent only through `timeline.edit`. Delegated agents may stage it, never apply it. `timeline.read` is `read` and auto. agent-harness §10 and media-track §2 state the registry's current count and move together; the combined count is read from the integrated registry once these rows land, never predicted here.

### 5.2 Findings inline

Findings map to items via `evidence[].docId`: a severity dot and count on bars (the `FindingsPanel` tokens); pair findings (order-drift, overlap, gap, relation) as a pair connector with a glyph; a gap as a band between the two scenes. Activating a badge opens the Findings tab focused on that group (a `focusFindingGroup` prop on `FindingsPanel.tsx`); *Show on timeline* is the reverse link. Open findings only by default; dismissed ones hidden.

### 5.3 Quick actions become proposals

Gap → *Declare a time skip*, or *Make this the epilogue* when the later scene is the last scene in reading order (or *Make this the prologue* when the earlier one is first); overlap → *Declare simultaneous*; order-drift → *Mark as flashback* or *Move in binder to match the days*; relation → *Move ‘A’ to day ≥ N*. Each is a tray row, never a write. Dismiss stays in the Findings panel.

## 6. Accessibility (a requirement)

- Role `grid`, one row per lane, cells in time order with a roving tabindex; **DOM order stays logical — prologue, main, epilogue, earliest first — while the visual geometry follows §3.2**, so an RTL project's grid reads the same order from the other side. The grid label reads "Timeline, story time, grouped by point of view".
- Each item's name: "‘The Ferry’, day 12 to 14, 3 days, flashback, POV Anna, Chapter 3, overlaps ‘Dock’, 1 proposed change"; a prologue or epilogue item starts with its part ("Prologue: ‘Before’, day −3,650, …"), and a scene whose explicit `main` overrides an inherited part is named "main story" without mentioning the folder. A fold is a focusable separator announced as "Fold: epilogue, 12 years later".
- Keys: ←/→ previous/next item in the lane (crossing folds) **in the interface's direction — the arrow toward the interface's start goes to the earlier item** (§3.2), ↑/↓ change lane, Home/End first/last in logical order, Enter opens the scene, Space selects, the Alt-chords of §4.2 propose, Delete on a ghost removes the proposal, F6 jumps to the tray.
- A polite `aria-live` region announces each proposal and the apply result ("3 changes applied. Undo restores them.").
- **Agenda view:** a table of the same items (day, end day, duration, part, reading index, mode, POV, findings, proposed change), grouped under Prologue / Main story / Epilogue headings, sortable, with editable cells that create the same proposals. Offered first under forced colours or reduced motion, and from a skip link. Shelf chains are announced "chain 2, step 3 of 5, after ‘Storm’".
- NVDA arrow-key pass-through is tested in T3 (automated `keydown` test plus a manual checklist); if `role="grid"` fails it, the `role="application"` plus `aria-roledescription` trade-off is taken and recorded in decisions.md.
- Mode, severity and part always carry a glyph or text as well as colour; `prefers-reduced-motion` and forced-colors are honoured.

## 7. Rendering and performance

- **Hybrid SVG + HTML, no new dependency, no WASM, no canvas in the live view.** An `aria-hidden` SVG layer draws grid, ticks, breaks, folds, zone bands, folder bands and connectors; an HTML layer holds focusable scene chips positioned with `transform` through React's `style` prop (CSP-safe: CSSOM, not style attributes in markup). Never `innerHTML` SVG strings or `setAttribute('style')`. Thumbnails are `blob:` images.
- **Bundle:** `TimelineView` is a `lazyView` chunk (`apps/desktop/src/components/timeline/TimelineView.tsx`). `@caotang/timeline` stays small (target < 15 kB min); the exporter imports it and sits in the capped `index` entry, so the PR measures it with `tools/check-bundle-size.mjs` and raises the cap deliberately, with a reason, if it must.
- **2,000-scene budget (a series):** `buildTimeline` on 2,000 scenes and 12 lanes in < 30 ms in Vitest on CI; start-sorted packing kept between layouts; memoised on (tree revision, coherence-file identity, options). Viewport virtualisation keeps ≤ 1.5k live DOM nodes, asserted by Playwright at Fit and at Day zoom. Drag moves one ghost element per animation frame outside React; the what-if run happens after the drop. If it exceeds 50 ms at 2,000 scenes it moves to a worker (measure first).

## 8. Export

New media formats appended to `MEDIA_FORMATS`, all built from the pure `TimelineModel` and reachable through `export.compile` (so the agent, SDK and MCP get them without new tools):

- **`timeline-csv` / `timeline-xlsx`:** one row per scene: reading index, **part** (`prologue`, `main`, `epilogue`), title, folder path, day, duration, end day (days may be negative), lens label, mode, POV, expected present, after, threads, open findings. Rows are ordered by part, then day, then reading index; undated rows follow per part. **That order is canonical and independent of any direction** — a spreadsheet never mirrors. XLSX reuses `render-xlsx.ts`; CSV works headless.
- **`timeline-svg`:** a text format (headless-safe). Zones, folds with their lens labels, chips and connectors, in the project-language direction of §3.2; no embedded fonts, generic families so CJK falls back to system fonts. Above 2,000 visible items it exports at chapter zoom with a note.
- **`timeline-pdf`:** landscape A4 or Letter via pdf-lib (the contact-sheet path, with `@caotang/pdf-fonts` fallbacks). Paginated: every page repeats the lens tick row and the lane gutter; page boundaries fall at part folds first, then at axis breaks, then at the nearest day boundary that does not split a chip. A new part never starts in the middle of a page that already shows another part's days. Geometry follows §3.2's project-language direction; the **page order is reading order** and no page is mirrored as a page. Footer: "Epilogue · Days 4,380–4,420 · page 7 of 8 · Day lens".
- **PNG:** a browser-only *Save image* from the view (offscreen canvas, `toBlob`), not a compile format, in the same geometry as the view and the SVG.
- XLSX and PDF join `BINARY_FORMATS`; each format starts in exporter.md and this spec.

**Order and direction are two different contracts.** The canonical arrays, the CSV/XLSX rows and the Agenda's data stay logical (part, day, reading index); only the drawn geometry — view, SVG, PDF and PNG — follows the project language. The UI controls around them follow the interface language, not the project's. A file read by another tool therefore never depends on which language the book is written in or which interface the writer chose.

## 9. Integrations

### 9.1 Pictures

The timeline consumes [pictures.md](pictures.md) §9: `linksOf({kind: 'node', nodeId})` and the `role: 'card'` picture per node (thumbnails on bars at Day zoom, at most 3 plus "+N"); `codex.visualRefs` as character pins in character lanes; `AssetLink.when` as a day pin, a marker above the axis at that day (negative days allowed, placed in the zone of the nearest scene's part, or the main zone when none). Images use the picture's alt (or `alt=""` when decorative) and open in the `ShotLightbox.tsx` pattern. Moving a pin is the `picture-when` op of `timeline.apply` (§4.3), so it follows the same approval. The PDF includes thumbnails when the recipe asks; the CSV lists picture ids and alt text.

### 9.2 MCP server

`timeline.read` is listed (read, registry-mapped) and a resource `caotang://timeline` carries the JSON model and CSV, parts included; the README tool table is updated. `timeline.edit` over MCP comes later (T12). Three facts shape it: the SDK and the MCP server save `caotang.json` and `coherence.json` **separately**; the server's `coherence.json` merge preserves a disk scene declaration it did not change, and a coherence save failure can surface only as a notice; and a confirmed call can write the manifest and then fail on coherence. So the tool returns a **typed outcome**, never a bare success:

- `persisted` — the declaration and tree writes both landed; the answer carries a **readback** of every changed scene's `dayOffset`, `durationDays`, `timelineMode`, `pov` and effective `storyPart`, and of each moved node's parent and index, read from the saved state.
- `conflict` — nothing was written; the scene and the field that differed are named with the current value.
- `partial` — some files were written before a failure; the answer names which files and which scene fields are durable, marks the result **not success**, and says how to recover (re-read, then re-apply only the unapplied ops). A coherence-save failure after a manifest save is `partial`, never a notice printed under a success.

The per-scene merge rule re-reads both files, applies only the server's own `expect`-guarded ops, leaves a disk scene declaration the server did not touch as it is, and refuses on conflict.

### 9.3 Prose, screenplay, storyboard and dialogue

A medium-adapter registry in `packages/timeline/src/media.ts` keeps the view medium-agnostic:

```ts
interface MediumAdapter { matches(node): boolean; label(node, state): string; measure(node, state): number;
  extras?(node, state): TimelineItem[] /* shot strips, page strips, picture pins */; glyph?: string }
```

- **Prose:** title or synopsis; measure = words.
- **Screenplay** (`.fountain`): label = the first slugline via `@caotang/screenplay`; measure = estimated pages; optional INT/EXT and DAY/NIGHT chips.
- **Storyboard:** the `<Scene> — Shots` folder shows as a shot strip under the scene at Day zoom (`ShotMeta.image` thumbnails, `durationSec` totals); shots inherit their scene's day and part.
- **Dialogue (Ink):** the container linked by `dialogueContainer` gives the scene a branch glyph that opens `DialogueView`.

### 9.4 Comics

The comics unit is decided ([comics.md](comics.md) §6, D8): the book's **linked** comic-script document (`scriptDocId`, never a title match) carries `SceneMeta` (days and part included) and the `comic` folder can carry a folder span. A pages-first book with no script contributes only its folder span. Its pages appear as page strips under the linked script, or under the book when there is no script, with `measure` = pages and panel thumbnails from the picture registry.

## 10. Risks and the prologue/epilogue test plan

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| A `shift` changes stored numbers writers quoted ("day 12") | M / M | Shift is optional and rarely needed now that days can be negative; the activity row records the delta; `timeline.read` reports it. |
| A lens contract frozen too early | L / M | The contract only maps integers to labels, spans and ticks; versioned (`lensApi: 1`). |
| Integer days cannot express hours | M / M | A stated known limit; binder order, `after`, DAY/NIGHT chips. |
| Dependant suggestions feel like nagging | M / L | Capped, collapsed, one hop, switchable off. |
| Selection sync jitter | M / L | Scroll only when unfocused and off-screen; a toggle. |
| NVDA vs APG role conflict | M / M | Decided on evidence in T3 and recorded; the Agenda always works. |
| The 2,000-scene budget fails on low-end machines | L / H | DOM cap, start-sorted packing, density bars, CI performance fixtures, worker fallback. |
| SVG export size or broken CJK in viewers | M / L | Chapter-zoom fallback; generic families; the PDF is the print-faithful path. |
| Aeon migrants expect an import | M / M | No importer planned; a CSV round-trip import could be backlog. |
| An older build opens a project with negative days and drops them | L / M | The codec's existing drop notice; a CHANGELOG line with T1b; the web app is always the current build. |
| A writer marks a part but dates it inside the main story | M / L | Kept as declared, drawn in its zone with a "dated inside the main story" note; never moved. |

**Prologue and epilogue tests** (each named issue owns its part):

- *Coherence (T1b):* the patch accepts −1, −3650 and −10,000,000 and refuses −10,000,001, 1.5 and `"−3"`; `durationDays` still refuses negatives; the codec loads a negative offset and an old file unchanged; `storyPart` accepts `main`, `prologue` and `epilogue`, `null` clears, an unknown value is refused, and absence inherits — a scene with no declaration under a prologue folder is prologue, an explicit `main` under it is main, and clearing restores inheritance; a folder `storyPart` covers its scenes and a scene's own declaration wins; effective parts are computed, never written into children; `timeline.gap`: main → epilogue 4,000 days apart → no finding, prologue → main → no finding, two epilogue scenes 30 days apart → finding, the same pairs with no part → findings (negative control); order-drift, relation, overlap, window and `knowledge.leak` with negative days behave as with positive ones; shift invariance (findings equal before and after a shift that crosses day 0).
- *Layout (T2):* zones always ordered prologue, main, epilogue in the model and drawn in the project-language direction; empty parts omitted; folds always present between zones with lens span labels ("about 10 years"); a prologue dated inside the main story stays in its zone with `partNote`; undated part scenes on the shelf's part groups; narrative-axis part bands at binder positions; a fold never links a gap finding; the 2,000-scene fixture includes both parts; an LTR project and an RTL project draw mirrored geometry from the same canonical model, and the RTL fixture's SVG/PDF coordinates are compared with the LTR ones as a mirror.
- *View (T3):* keyboard walk crosses a fold and announces it, in the interface's arrow direction; Agenda groups by part in logical order under both directions; e2e snapshot of a prologue and an epilogue chip's accessible names.
- *Apply and tray (T5, T6):* a `storyPart` meta op applies and undoes; an explicit `main` op under a prologue folder applies and leaves the binder node where it is; a mixed batch with a part change, a negative day and a move is one undo group; a meta op that changes `after` without `expect.after` is refused, and a stale `expect.after` conflicts; a shift across day 0 is one op; a later move is validated against a projection in which an earlier op renormalised a sibling set, and undo restores the exact sibling orders; tray rows name the part; a drop into the epilogue zone proposes `storyPart` and `dayOffset` together; the inside-the-main-story note on a row.
- *Export (T8):* CSV and XLSX golden files with the part column and negative days, in logical order under either project direction; PDF golden test: a page break at each fold, no chip crosses a page edge, the footer names the part, and an RTL project's pages are mirrored geometry with reading-order pages; SVG draws zones and fold labels in the project-language direction.
- *Agent and MCP (T7, T9, T12):* `timeline.read` lists parts and zone spans; a `timeline.edit` eval that marks the last chapter as the epilogue and one that moves a prologue scene to main; the `caotang://timeline` resource carries parts; T12 fixtures inject a coherence-save failure and assert `partial` with the durable files named, a concurrent app edit and assert `conflict` with nothing written, and a clean write and assert `persisted` with a matching readback.

## 11. Phased plan

Milestone **Timeline**, epic #150. Issues: T1 #174, T1b #175, T2 #176, T3 #177, T4 #178, T5 #179, T6 #180, T7 #181, T8 #182, T9 #183, T10 #184, T11 #185, T12 #186, T13 #187. Delivered in waves (a `wave/N` branch each, as the repo does). Titles follow Conventional Commits; commit subjects inside PRs keep the repo's plain-sentence style. Every feature PR updates its spec section, `docs/decisions.md`, `docs/USER-GUIDE.md` and `CHANGELOG.md` together, plus `docs/ROADMAP.md` when the milestone starts or ends, and passes `pnpm verify`, `pnpm build` and `pnpm test:e2e`. Critical path: T1 → T1b → T2 → T3 → T4 → T6, with T5 in parallel after T1b.

| # | Title | Scope | Done when | Depends |
|---|---|---|---|---|
| **Wave 1: see the timeline** | | | | |
| T1 | `docs(timeline): specify the timeline view, timeline.apply and the timeline tools` | This spec (including project-language direction, three-valued `storyPart` with explicit `main`, the complete `expect` and the canonical projection), coherence.md §5.2.2, decisions.md lines | Spec merged; decisions recorded; `test/not-in-this-build.test.ts` green | — |
| T1b | `feat(coherence): allow negative day offsets and declare prologue and epilogue scenes` | §2.2–§2.4: the patch rule, the codec, `SceneMeta.storyPart`, the gap boundary rule, the Inspector day field and part select, `@caotang/scan`; coherence.md §5.2.2 flipped to built | The coherence tests of §10 pass; old files load unchanged; USER-GUIDE and CHANGELOG describe negative days and parts | T1 |
| T2 | `feat(timeline): add the pure timeline layout package` | `packages/timeline`: `buildTimeline`, axes, part zones and folds, lanes, mode-render table, gap compression, sequenced/loose shelf, folder bands, connectors including presence, `CalendarLens` and `dayLens`, prose and screenplay adapters, `a11yLabel` | The layout tests of §10 and fixtures for each of the 11 modes, undated chains and a cycle, same-day stacking, strands, folder windows; 2,000 scenes under budget; no DOM import | T1b |
| T3 | `feat(desktop): show the story as a read-only timeline` | Lazy `TimelineView.tsx`, `CENTER_VIEWS += 'timeline'`, adaptive default axis, axis toggle with scheduled share, group-by, zoom, zones and folds, shelf, selection sync, grid keyboard model, live region, Agenda | E2e: keyboard walk across a fold, axis switch, accessible-name snapshot, NVDA pass-through test, DOM-cap assertion; bundle gate green; USER-GUIDE section | T2 |
| T4 | `feat(desktop): show coherence findings on the timeline` | Badges, pair connectors, gap bands, open-in-Findings, *Show on timeline* | E2e: an order-drift fixture shows a connector and focuses the card; dismissed findings hidden | T3 |
| **Wave 2: edit with approval** | | | | |
| T5 | `feat(bus): add the timeline.apply batch command` | Descriptor (write-confirm, inverse); `meta` (with `storyPart` and the complete `expect.after`), `move`, `shift` ops; whole-batch validation through the shared canonical projection (no harness `projectedSnapshot` lift); `expect` and fingerprint guards; store apply; activity summary; command-bus §9 and coherence.md §7.1 rows | Registry parity green; a mixed batch is one undo group restored exactly; stale `expect` refused with the scene named, including a stale `expect.after`; op 2 validated against op 1's tree and against a renormalised sibling set; > 200 ops refused; a 5,000-node shift across day 0 is one op and one undo group; fingerprint drift refused | T1b |
| T6 | `feat(desktop): propose timeline edits and apply them after review` | Gestures → proposals (incl. part zones and explicit *Move to main story*), coalescing, ghosts, tray (Apply / Apply selected / Discard, off-screen chip, count-named Apply), stale rows, leave guard, what-if delta, dependant suggestions, *Place N days after…*, *Shift all days*, quick actions | E2e: drag and Alt-nudge, nothing written before Apply, one Undo restores all, a stale row blocks Apply, the delta shows a resolved finding, a drop into the epilogue zone proposes the part, *Move to main story* leaves the binder node in place | T4, T5 |
| **Wave 3: agent, export, MCP** | | | | |
| T7 | `feat(harness): let the agent read and propose timeline edits` | `timeline.read`, `timeline.edit` via `primitiveTool`, the preview kind, not in `ACCEPT_EDITS_TOOLS`; agent-harness §3/§10 and media-track §2 state the count from the integrated registry; decisions.md owner line | Mock-provider eval: a plan with `timeline.edit` shows the diff card, applies as one turn, restored by the checkpoint; *Accept edits* still asks; the epilogue eval and the explicit-main eval | T5, T6 |
| T8 | `feat(exporter): export the timeline as CSV, XLSX, SVG and PDF` | `timeline-csv`, `timeline-xlsx`, `timeline-svg`, paginated `timeline-pdf`, ExportDialog entries, exporter.md, browser *Save image* | Golden CSV with parts and negative days in logical order; PDF validated by `test/pdf-validate`, no chip crosses a page edge, a break at each fold; an RTL project's SVG/PDF geometry mirrors the LTR one; CJK titles render; formats reachable via `export.compile` | T2 |
| T9 | `feat(mcp-server): serve the timeline to MCP hosts` | `timeline.read` listed, `caotang://timeline`, README table | `tools/list` snapshot updated; a read-only server serves the resource with parts | T7 |
| **Wave 4: pictures and media** | | | | |
| T10 | `feat(timeline): show pictures on the timeline and propose moving them` | Picture read API, thumbnails and pins, the `picture-when` op, lightbox, PDF thumbnails | E2e: a pinned sketch appears on its day; dragging it creates a proposal that applies and undoes | T6, Pictures A2 |
| T11 | `feat(timeline): add storyboard, dialogue and comic adapters` | Shot strips, dialogue glyph, comic page strips, subway polish | Fixtures per medium | T3, Comics D2 |
| T12 | `feat(mcp-server): let MCP hosts propose timeline edits` | Per-scene `coherence.json` merge rule, write-confirm elicitation, typed `persisted` / `conflict` / `partial` outcomes with readback; the separate manifest/coherence saves handled together | Concurrent-writer tests: the app's edit wins on conflict, the server's own ops re-applied or refused, a written manifest with a failed coherence save reported `partial` and never `persisted`, and a clean write's readback equals the saved state | T7 |
| T13 | `feat(timeline): add custom calendar lenses` (v0.3) | Data-defined lenses (months, leap rules, intercalary days, eras) in project settings, stacked tick rows, `parse`; no `SceneMeta` change | A lens with a leap rule labels and parses round-trip; switching lenses changes no stored value | T2, T3 |

Backlog (not filed): uncertainty ranges (D6), sub-day time, named strands and locations (D7), the FS/SS/FF/SF dependency tail (coherence D10), codex lifespans with born/dies fields, a CSV import.

## 12. Decisions

Recorded on 2026-10-23: the owner approved the recommended option of each decision, with one change, D2, where the owner chose negative day offsets and first-class prologues and epilogues ("prologue and epilogue are really important"). One-line versions are in [decisions.md](../decisions.md).

| # | Decision | Rejected alternative and why |
|---|---|---|
| D1 | **One approval = one undo through the `timeline.apply` batch command** (the `shot.importImages` precedent), with `meta`, `move`, `shift` and `picture-when` ops. | A gesture group in `UndoStore`: more general, but changes command-bus §5 for every surface. |
| D2 | **Before day 0: negative `dayOffset` (−10,000,000…10,000,000) plus a declared `storyPart` (`main` / `prologue` / `epilogue`)**, placed explicitly in the layout, tray, exports and tests; absence inherits the nearest declaration then the main story, `null` clears, and an explicit `main` overrides an inherited part without moving the binder node; cross-part pairs exempt from `timeline.gap`; *Shift all days* stays an optional tool. **Owner's change**: the design recommended a display zero plus a shift with no schema change; the owner then asked for an explicit main-story override. | Display zero plus shift only: a display workaround that renumbers stored days and leaves prologues and epilogues as unnamed numbers. The display zero is dropped: day 0 stays the reference day and negative days are shown as written. |
| D3 | **Specify `CalendarLens` now; ship custom lenses in v0.3** (T13). | Keep a single `dayLabel` hook: cannot produce month, year or fold-span labels without rewriting the axis. |
| D4 | **Image export: `timeline-svg` in T8** alongside PDF, CSV and XLSX, plus browser PNG. | PNG first, SVG only if needed: missing vector and print export is a repeated complaint (P10). |
| D5 | **Agent modes:** `timeline.edit` is excluded from *Accept edits* and allowed under *Auto*. | A new "never mode-approved" class: a new rule in agent-harness §4 for one tool. |
| D6 | **Uncertain days are not stored** in the first landing; undated plus `after[]` covers order-only fuzziness. | An `approx` flag or earliest/latest ranges: every check would need a rule for which end counts. |
| D7 | **Named strands and locations are not in the first landing**; revisit once the timeline is in use. | `SceneMeta.strand` / `location` now: a coherence change before evidence of need. |
| D8 | **The comics unit is the comic-script document** (it carries `SceneMeta`; the `comic` folder can carry a span), with pages as strips ([comics.md](comics.md) D9). | Pages or panels as `SceneMeta` units: page space is not story time. |
| D9 | **Both timeline axes follow the project language's direction**, independently of the interface; the canonical model, CSV/XLSX rows and Agenda data stay logical, the UI controls follow the interface, and a comic page follows the book's own direction. | Mirroring only when the interface is right-to-left (Obsidian's coupling): a right-to-left book in an English interface would then read backwards. Flipping the stored arrays too: a generated file would depend on the writer's language and interface. |

## 13. Sources

**Aeon:** help.timeline.app/article/148-what-are-relative-dates · aeontimeline.com/3-4-guides/dates · help.timeline.app/article/181-how-to-handle-uncertainty-in-dates · help.timeline.app/article/218-resolving-syncing-conflicts · forum.aeontimeline.com/t/difficult-to-commit-to-purchasing/3143 · forum.aeontimeline.com/t/random-almost-out-of-sync-events-with-scrivener/2546 · forum.aeontimeline.com/t/what-aeon-timeline-could-be/1186 · forum.aeontimeline.com/t/syncing-issues-responsiveness/100 · forum.timeline.app/t/exporting-timeline-to-pdf/1264 · help.aeontimeline.com/article/46-differences-between-desktop-and-ipad-apps
**Scrivener:** forum.literatureandlatte.com/t/timelines-a-side-thought/8208 · literatureandlatte.com/blog/two-ways-of-creating-a-timeline-for-your-scrivener-project · forum.literatureandlatte.com/t/is-scapple-usable-as-a-timeline-software/147087
**Other tools:** reedsy.com/blog/guide/book-writing-software/campfire-write-review/ · docs.plottr.com/article/54-timeline-overview · dabblewriter.com/docs/planning-story-notes/plot-grid-overview · worldanvil.com/w/WorldAnvilCodex/a/calendars · help.postroll.app/timelines/events/dating-events/ · help.postroll.app/timelines/events/relative-dating/ · aronjanosch.github.io/chronicle-keeper/docs/views.html · thenovelkit.com/resources/timelines-printed-in-books · knightlab.zendesk.com/hc/en-us/articles/211630486-Maximum-number-of-Events-on-a-timeline
**Performance:** github.com/visjs/vis-timeline/issues/379 · github.com/visjs/vis-timeline/pull/1281 · visjs.github.io/vis/examples/timeline/other/performance.html · tom-horak.de/publications/2018/graph-performance/
**Editing safety:** feedback.clickup.com/feature-requests/p/gantt-view-task-locking · gitlab.com/trueppm/trueppm/-/work_items/492 · forum.figma.com/ask-the-community-7/resolving-branch-and-main-file-conflict-22097 · mergedocs.pro/accept-all-suggestions-google-docs
**Accessibility:** w3.org/WAI/ARIA/apg/patterns/grid/ · accessible-data-interfaces.com/core-aria-keyboard-navigation-for-data-uis/accessible-date-and-time-data/accessible-calendar-and-timeline-views/ · github.com/namespace-ee/react-calendar-timeline/issues/263 · github.com/unovue/reka-ui/pull/2502
