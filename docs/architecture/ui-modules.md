# UI modules — binder / corkboard / inspector / settings (v0.1 contracts)

> Status: built.
> Scope note: these are **view contracts**. All state lives in the project-store / app settings; all mutations route through the command bus (ARCHITECTURE §1.4, command-bus.md §1). UI modules own no persisted state — only view state (`view.*` commands, never persisted, command-bus §9).
> Cross-refs: command registry = [command-bus.md](command-bus.md) §9 · tree/order/front-matter field contracts = [project-format.md](project-format.md) §2/§3 · codex UI surfaces = [codex.md](codex.md) §8 · ghost/editor = [editor-engine.md](editor-engine.md) · onboarding = [context-assembly.md](context-assembly.md) §6.

## 0. Shared view rules (apply to all four modules)

1. **Render from the store, never from command params** (command-bus §3): every UI surface subscribes to post-commit notifications and re-renders from project state. A failed command leaves the view untouched (validate-first = zero partial effects).
2. **View-state commands** (`view.setSelection`, `view.setActiveDoc`, `view.setScroll`, `view.setExpanded`, …) are ephemeral — never persisted, never undo-registered, excluded from undo-all assertions. A reload restores defaults (expanded manuscript root, active doc = last opened in-session).
3. **Empty-state guidance** is a first-class contract per module (Scrivener's blank-panel problem): every empty surface carries one actionable next step wired to a real command (e.g. empty binder → "Create Chapter" + "Let the agent structure it" → `binder.restructure` plan card).
4. **Keyboard-first parity:** every menu action maps onto the same bus commands the agent uses — no UI-only mutation paths exist (this is what makes the agent-trace evals in command-bus §10 cover real usage).
5. **Theme:** light/dark only (settings §5); all colors derive from CSS custom properties; status/label colors come from the project vocabulary (no hardcoded palette in components).
6. **Shell width:** the shell's minimum window width is 960 px, and a narrower window scrolls rather than overlapping. From 1100 px down the rails narrow and the toolbar wraps onto a second row, so a 1024 px window fits with no sideways scroll.

## 1. Component topology (v0.1 layout)

```
┌────────────────────────────────────────────────────────────┐
│ app shell (theme, panes)                                   │
│ ┌──────────┬──────────────────────────────┬──────────────┐ │
│ │ left rail│ editor pane (focus doc)      │ inspector    │ │
│ │ tabs:    │ [editor instance (§ editor)] │ panel        │ │
│ │ binder   │ [ghost region when streaming]│ (2.5)        │ │
│ │ codex    ├──────────────────────────────┴──────────────┤ │
│ │ findings*│ agent panel (harness §2 cards) / corkboard   │ │
│ └──────────┴─────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

*findings panel = coherence.md §8 (post-v0.1; the left rail is built with 3 tab slots from day one, findings tab lands with the module).

- Pane layout is **fixed v0.1** (no user-resizable panes, no movable rails — polish backlog); focus mode (editor-engine §10) hides left rail + inspector, editor keeps state; the hide is the Writing setting's, on by default (§5.2).
- **Window width.** The shell's minimum is **960 px** (the workspace's `min-width`); below it the page scrolls sideways, and that is not a supported layout. From 1100 px down the rails narrow and the toolbar wraps onto a second line, so 1024 px fits with no sideways scroll (e2e/shell.spec.ts). Focus mode keeps one column: the toolbar on the first row and the centre under it, so the Focus button always leaves the mode.
- **Focus mode and the Writing setting.** With Settings › Writing's "hide the binder and the inspector" off, focus mode keeps both, and the status line says so when focus mode turns on: "Focus mode is on. The binder and inspector stay open, as set in Settings › Writing." "Settings › Writing" is a button inside the sentence, drawn as a link, whose visible words are its name; it opens Settings at the Writing section.
- The **agent panel** is a bottom drawer in the editor pane (harness §8): plan cards, checkpoint rows, ghost controls live there; it never overlaps the editor's ghost region.
- The agent panel's header carries the **Mode** control (agent-harness §4): a radio group named by its visible label, **Mode**, with **Plan only**, **Ask**, **Accept edits** and **Auto** (Auto is absent while Settings › Agent has it off). Every turn row and checkpoint row prints its mode. A card the mode approved is collapsed behind an **Auto-approved** badge, and a Plan only turn that refused writes ends with a **Plan, not run** section and **Switch to Ask and run this plan**; neither has an Approve control.
- The agent panel's **Intent** box is a combobox (harness §8, "The command list"): a leading `/` opens the list of the nine built-in slash commands, `//` sends a literal leading slash, and a command's answer is a status note under the box. A command never skips a card.
- The agent panel also carries a **Background tasks** section and, while a big plan waits for its answer, a plan offer card with **Run now**, **Run in background** and **Cancel** (harness §8). The tasks are view state read from the app database, never project state.

## 2. Binder (module 2.2)

**Responsibility:** tree view of the three-tier structure; drag-drop reorder/reparent; status/label chips; inline rename. Owns view state only.

### 2.1 Data binding
- Reads the tree from project-store; renders only the two roots `manuscript` + `research` (plus their subtrees) — `root` itself is never rendered (it is the project, not a node in the view).
- Rows: indent by depth (manuscript children = depth 0 in the view), title, status chip (color dot + name), label chip, word count for documents (from `derived.wordCounts`, allowed stale), synopsis tooltip on hover (first 120 chars).
- Expansion state per node id (view state; default: expanded one level).
- Selection: single-select (multi-select = v0.2); selection is a **view** concern but doubles as agent targeting context (active doc for `scene.draft`).

### 2.2 Gestures → commands (exact mapping)
| Gesture | Command emitted | Notes |
|---|---|---|
| New folder / new document (context menu, `+` button, `Ctrl+N`) | `binder.create {parentId, type, title: 'Untitled'}` | Title enters inline-rename mode immediately after creation. |
| Drag to reorder (same parent) | `binder.move {nodeId, newParentId, index}` | Board order = sibling index (0-based position among *visible* siblings after the drop). |
| Drag onto a folder (reparent) | `binder.move {nodeId, newParentId: folderId, index: end}` | Drop validation runs **pre-dispatch** (§2.3); invalid targets show a no-drop cursor, never an error dialog. |
| Inline rename (double-click / F2 / rename context item) | `binder.rename {nodeId, title}` | Commits on Enter/blur, cancels on Escape; empty title = revert (validation would reject — command-bus validation error surface is avoided by the cancel, but if it fires it renders in the row's error slot). |
| Status/label chip click | vocabulary picker → `binder.setMeta {nodeId, patch: {status}}` / `{label}` | Picker lists the project vocabulary; `+ add` opens the vocabulary editor. |
| Synopsis edit (context menu → "Edit synopsis") | routes to the inspector synopsis field (§4.1) — `binder.setSynopsis {nodeId, synopsis}` — not an inline tree editor | textarea, **debounced 800 ms → `binder.setSynopsis`**, **≤2000 chars with a live counter** (§4.1) — **cell completed 16:0x: the row carried two of three columns, so GFM padded it and it rendered as a finished spec row with no behaviour stated, while §4.1 states all of it** |
| Agent access (context menu: **Agent: may read and change** / **may read only** / **may not read**) | none: a project rule (`agent.rules`, project-format §2), written by the session, not a bus command | One rule on the node's subtree for every tool: read only is a write-deny, may not read is a read-deny (which also locks it). The choice in force is the menu's checked radio item. A node inside a marked folder shows the folder's access as a disabled line naming it, to change on the folder. A marked row carries an icon and the words **Agent: read only** or **Agent: hidden**, never colour alone. Agent-harness §4, Rules. |
| Delete (context menu, Delete key) | `project.deleteNode {nodeId}` | **User confirm dialog** (the one destructive UI flow; command-bus §4). Dialog states what is deleted: node + descendants + their docs; undo hint shown ("restorable via the agent-panel checkpoint if recent"). |

### 2.3 Drop validation (pre-dispatch, mirrors `binder.move` validate)
- Target parent exists; drop would not create a cycle (cannot drop a node into its own subtree); document nodes cannot become parents (three-tier invariant enforced at the UI: dropping onto a document row = drop *after* it, not into it).
- Manuscript/research roots cannot be moved, renamed, or deleted (reserved ids, project-format §2).
- **The chapter rule.** A manuscript child is a chapter: a document dropped, or moved by the keyboard, directly under the manuscript is refused with "A document goes inside a chapter, not directly under the manuscript." New document gives the same sentence there, the media entries of a row's menu appear on chapters only, and `binder.create` refuses a new document or dialogue directly under the manuscript with the same words (command-bus §9). This one UI check is **wider** than the command's: `binder.move` still moves a document to or from the manuscript, so a chapterless document an older project holds can be moved into a chapter and that move undone. A put-back of a stopped tab's kept words restores each document into the chapter it recorded, or into a "Kept from a stopped tab" chapter made at the end of the manuscript when that chapter is gone. A Research document goes back to the Research folder it recorded, or to the Research root when it was there, while that parent exists: notes are never put into the manuscript's kept chapter unless their Research folder is gone.
- Failed pre-checks = visual no-drop only; the command's own `validate` remains the backstop (defense in depth, never duplicated logic — the UI check is a subset of the command validation).

### 2.4 Empty states
- Empty manuscript: guidance card "Create Chapter 1" (`binder.create`) + "Let the agent structure it" (`binder.restructure` plan flow).
- Empty research: guidance card pointing at notes-first workflow.

### 2.5 Keyboard map (v0.1 minimum)
`Ctrl+N` new doc in selection's parent · `F2` rename · `Delete` delete w/ confirm · arrow keys move selection · `Ctrl+Enter` open in editor (`view.setActiveDoc`) · `Escape` closes inline editors. (Full chord sheet = polish backlog; these are the Playwright-scripted set.) The agent's Intent box has its own keys for the command list, in §5.6.

## 3. Corkboard (module 2.4)

**Responsibility:** index-card grid for a container's children; drag-reorder; zoom. Owns view state only. **No commands of its own** — every gesture maps onto binder commands (verified against command-bus §9; the storyboard later extends cards with shot fields, still no new commands).
> **Media-track variants (same doctrine, zero new commands):** folders with `kind: 'storyboard'` render the corkboard in **shot mode** (card = image thumbnail + derived shot-number chip + spec row; gestures unchanged, metadata edits live in the board's Fields panel — [storyboard.md](storyboard.md) §3.1); dialogue containers with `kind: 'branching'` add a **graph-view variant** over the parse-derived projection (view-only, auto-layout, click-through to text — [dialogue-narrative.md](dialogue-narrative.md) §3). Both variants introduce view state only (`view.setGraphFocus`, image lightbox); the command surface stays the binder set.

### 3.1 Data binding
- Scope: the active container (folder selected in binder → corkboard shows its children). `view.setCorkboardScope` (view command).
- Card content: title, status chip, **synopsis** (the card's body text), word count for document cards, child-count for folder cards.
- Cards render in sibling `order` (gap-encoded; the view is a pure sequence — gaps are invisible).

### 3.2 Gestures → commands
| Gesture | Command | Notes |
|---|---|---|
| Card synopsis edit (click into card body) | `binder.setSynopsis {nodeId, synopsis}` | Inline textarea, debounced 800 ms (same autosave cadence as body text — editor-engine §9); ≤2000 chars with a live counter. |
| Drag-reorder | `binder.move {nodeId, newParentId (unchanged), index}` | Same index mapping as binder reorder; cross-container drags are out of view (board scope = one parent). |
| New child card | `binder.create` (context menu on empty grid area) | Lands at end. |
| Zoom S/M/L | view state only (card size CSS class) | S = title only, M = title + 2-line synopsis, L = title + synopsis + status/label/keywords row. |

### 3.3 Empty state
- Container with no children: "No cards — drag scenes in from the binder or create one" + create button.

## 4. Inspector (module 2.5)

**Responsibility:** per-document (or folder) side panel: synopsis, notes, keywords, status/label; codex section (codex.md §8). Owns view state only.

### 4.1 Fields & edit semantics
| Field | Binding | Edit path | Contract |
|---|---|---|---|
| Synopsis | node.synopsis | textarea, debounced 800 ms → `binder.setSynopsis` | ≤2000 chars; char counter; corkboard card + compile template read this field. |
| Notes | node.notes | textarea, debounced 800 ms → `notes.set` (write-confirm for agent, plain for user) | ≤50k chars (project-format §2); plain Markdown; the `notes.append` agent divider (`— agent, <date>`) renders as a visual separator, not literal text. |
| Keywords | node.keywords | chip input → `binder.setMeta {keywords_add/keywords_remove}` | ≤32 × 64 chars; freeform (Scrivener-style); autocomplete from existing keywords in-project. |
| Status / Label | node.status/label | pickers → `binder.setMeta` | Vocabulary-validated at the command; picker shows "unknown status" chip when the loaded value is outside the vocabulary (project-format §2 tolerant rule). |
| Export style | node.style (documents only) | select (Normal, Section) → `binder.setMeta {style}` | exporter.md §2, Per-scene styling. Normal clears the field; an unknown stored value shows as itself, disabled, and exports as Normal. The agent's `meta.set` does not carry it. |
| Codex section | codex.md §8 | attach picker → `codex.write {attachTo}` / chips show mention counts | Mention chips refresh on doc-write cache invalidation; click → codex panel. |
| SceneMeta editor | coherence.md §8.3 | POV picker (codex characters), dayOffset/duration number fields, `after`/`expectedPresent` chip pickers, a **Dialogue container** select (the live dialogue containers; coherence.md §5.6) | **Lands with the coherence module** (post-v0.1); the Inspector layout reserves the collapsible section from day one. |

### 4.2 Folder nodes
Same panel minus notes (folders carry synopsis + keywords + status/label only — matches manifest fields; a folder is the act/part card).

### 4.3 Empty state
No selection: "Select a document" hint + the three demo intents (context-assembly §6 wizard reuses them).

## 5. Settings (module 2.9)

**Responsibility:** app-level preferences. **Never project state** — the settings schema lives in app storage (IndexedDB app-level store, separate from the project working store; provider keys never enter `caotang.json` — project-format §2 no-secrets rule).

### 5.1 Settings schema (typed, app-level)

```ts
interface AppSettings {
  theme: 'light' | 'dark';
  provider: {
    profiles: ProviderProfile[];        // provider-gateway §2 shape, owned by the gateway's validation
    activeProfileId: string | null;     // null = mock provider active (first-run default, context-assembly §6)
  };
  editor: { autosaveDebounceMs: number; /* default 800 */ focusModeHideRails: boolean; };
  session: { dailyTargetWords?: number };
  context: { totalBudgetTokens: number; /* default 12k */ layerBudgets: Record<'L2'|'L4'|'L5', number>; };  // context-assembly §3 config exposure
  agent: { rules: PermissionRule[]; /* tool-level deny/ask only, in every project; agent-harness §4, Rules */ loadEveryTool: boolean; keepTraces: boolean; /* default true; a missing value reads true */ defaultMode: 'plan-only' | 'ask' | 'accept-edits' | 'auto'; /* default 'ask' */ lockAuto: boolean; budget: { maxTokens?: number; maxCostUsd?: number; maxWordsChanged?: number; maxDocuments?: number; maxSteps?: number; }; };  // agent-harness §3 and §4; loaded field by field; a stored 'auto' under lockAuto reads 'ask'; the mode is never a project-file key
  coherence: { enabledChecks: DeterministicCheckId[]; defaultReviewScope: 'doc'|'changed'|'full'; maxFindings: number; };  // lands with coherence module
  mcp: { enabled: boolean; servers: McpServerConfig[]; };  // lands with the v0.2 MCP client (extensibility.md §3.1) — deny-by-default (enabled: false until first connect); server configs are app-level state, never project files
  data: { projectStoreDir?: string; };  // placeholder for the desktop app; browser v0.1 = not editable, shown read-only
  storage: { persisted?: boolean; evictionBannerDismissed?: boolean; };  // §5.3 posture: browser persistence display state + banner dismissal; browser-API state mirrored here for UI, never authoritative (navigator.storage is)
}
```

- All budgets are **config-exposed, not hardcoded** (context-assembly §8); unknown/missing keys load to defaults.
- Mutation path: settings UI → app-level settings store (not the project bus — command-bus §9 "provider/settings mutation is app-level state"; the agent can never touch any of it, hard-deny class).

### 5.2 Sections & validation surfaces
| Section | Contents | Validation |
|---|---|---|
| Providers | profile list, add/edit/delete, active radio | `listModels` probe at save (context-assembly §6); URL normalization (strip trailing `/`, versioned-path rule — provider-gateway §2); key field masked, stored AES-GCM (provider-gateway §7); `pricePer1k` optional numeric pair. |
| Writing | session target, autosave debounce (100–5000 ms clamp), "In focus mode, hide the binder and the inspector" (`focusModeHideRails`, on by default; off, focus mode changes only the Focus button's pressed state), "When you apply an agent edit" (`editor.agentEditMode`: Replace the text, the default, or Mark the changes for review; editor-engine §15 — app-wide, applies to the next document opened, prose scenes only, and its help text says the agent's text is already saved when the marks appear, that rejecting a change is what edits the file, and that closing the tab with changes still marked keeps the agent's text) | numeric clamps in-form. |
| Context | total budget + L2/L4/L5 layer budgets | **A total below the sum of the layer caps is a warning, not an error, and the total wins** (the warn line names the sum); preview bar link. |
| Agent | **Load every tool on every request** (off by default); **Keep agent traces for this tab** (on by default; off stops the Trace tab recording and clears what it holds, agent-harness §5.2); the mode a panel starts in (radio group, Ask unless chosen); **Turn Auto mode off**; the limits a turn is held to while Accept edits or Auto decides its cards (tokens, words changed, documents touched, steps, cost; empty keeps the default) | a limit is a whole number in its range (cost: dollars above 0), checked on save and clamped the same way on load; turning Auto off moves a stored Auto to Ask. The agent panel's own mode pick is a session override that is never saved. A rule with a node scope in the app's settings is dropped on load (a binder id belongs to one project); a rule that names no tool, or a node that is gone, is listed with a note that it has no effect. |
| Macros | the project's macros (extensibility.md §10): each with its name, description (plain text), step count and what it does to the project, and **Run…**, **Edit** and **Delete** (undoable). **Run…** is a form of the macro's values with the steps it would take written out, and **Show the card** hands the plan to the agent panel. A macro that no longer fits the tools says why and cannot run. With no project open the section says to open one. `MacrosPanel.tsx`; the model is `app/macro-model.ts` | `checkMacro` (agent-harness and extensibility §10) before a save and at each run; the form reads whole numbers and required values in words. |
| Coherence | the quick checks the Findings tab's scan runs (one checkbox per deterministic check, coherence.md §5.4), the scope the Findings tab starts with, and the most findings one model review may add (the field's range is 1 to the cap) | the check list and the scope are the app's own choices, saved with the settings; the model review's plan (its calls, token estimates and first prompt) is shown in the Findings tab before the writer presses (coherence.md §7). |
| MCP & tools | master switch, server cards (health dot, per-tool toggles, trust flag, remove) — **built with the v0.2 MCP client** (extensibility.md §8 and §3.5 for the model-facing names) | URL validation at save; per-entry-tolerant import; health states surfaced per card |
| Appearance | theme | — |
| Data | storage location (read-only in browser), export/import entry points | — |

*(§5.3: the Data section additionally carries the browser-storage persistence row + eviction-risk banner per the posture below.)*

### 5.3 Browser-storage persistence

Evidence: Dabble's web app carries a constant *"Data may be evicted"* warning: browser eviction is a real, shipped-competitor failure mode for the IndexedDB working store (IndexedDB storage is best-effort by design). The posture, for the **browser build** (a native desktop-shell wrap would remove the entire class):

1. **`navigator.storage.persist()` at project open** — called automatically when a project is opened (after the working store has something worth protecting); the result is **not re-asked** if already granted (`navigator.storage.persisted()` checked first). Firefox prompts the user via its own permission UI; Chromium grants per its heuristics. Never a Caotang-side modal for the *request* — the affordance lives in Settings.
2. **Settings › Data gains a "Storage" row** (typed schema addition, app-level): `persisted: boolean` (from `navigator.storage.persisted()`), `usage`/`quota` (from `navigator.storage.estimate()` — same displayed-estimate honesty as token estimates), rendered as a plain status line: "Browser storage: persistent ✓" / "Browser storage: persistence not granted — the browser may evict this project under storage pressure."
3. **Eviction-risk banner (persisted === false):** a **dismissible, non-alarming** info banner in the editor pane — Dabble-style constant warning is noise; a one-time dismissible banner with two actions: "Export a backup" (opens the artifact export, project-format §7) and "Learn why" (static explainer: what eviction means, what persistence grants). Never re-shown after dismissal this session; re-appears next session while `persisted === false`.
4. **Failure-message template:** any write-path failure surface adopts Dabble's framing — *"your words are waiting on your device, not gone"* class wording (pending writes remain in the runtime store; the artifact export is the recovery path). Concretely: the autosave-flush-failure indicator (editor-engine §9) and any storage-quota error envelope state what is safe *right now* + the one corrective action, never a bare code.
5. **Not a command, not agent-visible:** persistence is browser-API state, not project state — no bus command, no activity-log entry, agent cannot touch it (app-level class, command-bus §9). Backups remain the real mitigation (the manifest's rolling snapshots, project-format §4, + the artifact round-trip); persistence reduces eviction *risk*, never replaces export.
6. **Evals:** Playwright-mocked `navigator.storage` (persist → true/false, estimate fixtures) — banner shows iff `persisted === false`, hides on grant; Settings row reflects both states; no banner when mocked as persisted.

### 5.4 First-run wizard entry
Settings opens pre-populated on the Providers section during the first-run wizard (context-assembly §6): the wizard's "paste your key" step deep-links here; `listModels` failure renders inline (never a toast-only failure).

### 5.5 The Project panel

The Project panel is a dialog that opens from the project's name in the toolbar (`apps/desktop/src/components/ProjectPanel.tsx`). It holds the fields epub-metadata.md specifies, in a writer's terms: **Title**, **Author**, **Language**, **ISBN** and **Cover**. Each field saves through its own command when the writer leaves it or presses Enter, so each change is one activity row and one undo: `project.rename` for the title; `project.setMetadata` for the author, the language, the ISBN and the cover reference; and `project.importAsset` for a cover chosen from an image file, whose bytes are staged, and which the command writes into `assets/` and points the project at in one undo group. A value the command refuses is said beside its field, and nothing is written. An ISBN is shown as its digits, not as the `urn:isbn:` form it is stored in. These commands are UI-driven, and the agent has no tool for any of them. Their write-confirm rating is the bus's own gate (command-bus §9: the project commands are write-confirm).

### 5.6 Keyboard chords added since v0.1

- **`Ctrl+Alt+F`** focuses the binder's filter field (binder-filters §5). **`Ctrl+Shift+F`** stays focus mode, which shipped first and is in the user guide. The filter takes the Alt chord, as docs/decisions.md records. The filter chord is supplementary, not part of the §2.5 set (binder-filters §5).
- **The agent's Intent box** (a combobox, harness §8): **`/`** at the start opens the list of slash commands; **Down**, **Up**, **Home** and **End** move through it; **Tab** completes the command; **Enter** completes it and runs it when it needs no argument; **Escape** closes the list and keeps the text; **`//`** sends a literal leading slash. The list does not open while an input method is composing, nor for a full-width `／`. The panel's Escape (stop the turn, with the box empty) is not taken while the list is open.

### 5.7 The Skills panel

The Skills panel is a dialog that opens from **Skills** in the toolbar, or from **Review skills** in the agent panel's note that skills are waiting (`apps/desktop/src/components/SkillsPanel.tsx`; its model is `apps/desktop/src/app/skills-model.ts`, extensibility.md §10). Its subtitle is "Reusable writing instructions for the agent". The words in it are a writer's: **Skills**, **instructions**, **approve**, **on/off**. The folder's main-file name and the pin appear only in the docs; the main file is **Instructions** here. It has four views:

- **The list**, in name order: each skill's name, description, where it stands with the review (**Not approved yet**, **Approved**, **Changed since you approved it**), and chips for **Off**, **Includes scripts** and **Only you use it**. Each row has **Read and approve…** (**Read again** once approved), **Edit**, **Turn off / Turn on** and **Delete** (undoable). **New skill…**, **Import a folder…** and **Import a zip…** sit above the list. A folder that cannot be a skill (its name is not its folder's, its front matter does not read) is listed under **Skills that cannot be used** with what to change. The agent panel carries a note, "N skills are waiting for you to approve them", while a skill that is on and open to the agent is unreviewed.
- **The review**: the description, notes for scripts (named, with "Caotang reads the instructions and does not run them" and the line about other programs), for `allowed-tools` ("Not enforced in this build"), for the other files ("kept with the skill; the agent cannot read them in this build"), for characters that cannot be seen and for comments; then every file as plain text in a `<pre>` (nothing is rendered), with each hidden or bidirectional control character shown as `⟦U+XXXX⟧`, and a file that is not text named with its size. **Approve this skill** records the approval of those bytes (skill-reviews.ts).
- **The editor**: one text area for the instructions, with live validation (the skill, with this text, must parse: a name that is its folder's, a description) and **Save** off while it cannot. Saving a change to an approved skill says it will need approving again.
- **New skill**: a name, checked as it is typed (lower-case letters, digits and hyphens, not taken), then the editor on a template that parses.

Escape goes back one view, and out of the panel from the list. Import reads the picked files only to find and check the skills among them (50 skills, 64 files, 256 KB a file, 2 MB a skill; a path that leaves the folder refuses the zip whole), then takes each through `skill.import`. Nothing in it is fetched or run.

### 5.8 Save as macro

A turn whose plan card the writer approved and that ran has **Save as macro…** under its card (`SaveAsMacro.tsx`; `savesAsMacro` in `app/agent-model.ts` decides, extensibility.md §10). It opens a dialog: a name, an optional description, and the plan's values (every string, number and yes/no in its steps, each labelled by its step and where it sits, such as "Step 1, targets[1]") each with a checkbox, **Ask for…**, and a name for the value once ticked. A ticked value becomes a macro value of the kind the tool's field takes, starting as it was; unticked values stay fixed. **Save macro** is off while `macroFromPlan` has a reason, which the dialog shows in words, and one reason is that the macro, run with no changes, would not expand to exactly the plan on the card. Saving is `macro.save`. Escape closes the dialog.

## 6. Playwright traceability (the UI modules' shared eval bar)

Per command-bus §10 + ARCHITECTURE §1.6: every scripted gesture must produce the **same command trace an agent plan would** — that equivalence is the eval:

- binder: create → rename → move → setMeta → delete(+confirm) trace asserted with node ids.
- corkboard: reorder of 3 cards → `binder.move` index sequence asserted.
- inspector: synopsis + keywords + status edits → debounced command assertions (fake timers).
- settings: profile add → `listModels` probe mocked → active switch → request-log shows the probe call (provider-gateway request log).
- All traces run headless; no pixel assertions in v0.1 (component screenshots = polish backlog).

## 7. Assumptions & open questions

| # | Assumption | Status |
|---|---|---|
| U1 | Fixed pane layout (no resizable panes) suffices for v0.1 | Explicit; Scrivener's default layout is similarly fixed; resizable panes = polish backlog if real use complains. |
| U2 | Single-select in binder/corkboard suffices for v0.1 | Explicit; multi-select meta operations (`meta.set` already takes ≤50 targets) arrive with batch UI in v0.2. |
| U3 | No virtualized lists needed at v0.1 scale (≤ ~500 nodes) | Flagged; virtualization is a standard swap if a real project exceeds it (view-only concern). |
| U4 | Findings panel slot (third rail tab) is reserved but empty in v0.1 | Explicit (coherence.md §8 lands post-v0.1). |