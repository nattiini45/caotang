# State machines

Lifecycle contracts use `@caotang/machine`, a dependency-free leaf package. A machine has a `kind`-keyed state union, a `type`-keyed event union, a pure step and a transition table exported as data. The table is the shared vocabulary for code, tests, documentation and agents, not an actor runtime. The kit owns no clock, timer, storage, effects or subscriptions.

## Contract and API

The runtime entry point exports only `MachineTable`, `Machine`, `defineMachine`, `canMove` and `assertNever`:

```ts
interface MachineTable<S extends { kind: string }, E extends { type: string }> {
  readonly id: string;
  readonly initial: S['kind'];
  readonly final: readonly S['kind'][];
  readonly on: {
    readonly [K in S['kind']]: { readonly [T in E['type']]?: readonly S['kind'][] };
  };
}
interface Machine<S extends { kind: string }, E extends { type: string }> {
  readonly table: MachineTable<S, E>;
  step(state: S, event: E): S;
}
function defineMachine<S extends { kind: string }, E extends { type: string }>(
  table: MachineTable<S, E>, step: (state: S, event: E) => S,
): Machine<S, E>;
function canMove<S extends { kind: string }, E extends { type: string }>(
  table: MachineTable<S, E>, from: S['kind'], event: E['type'],
): boolean;
function assertNever(value: never): never;
```

`defineMachine` pairs the table with the supplied step; it does not interpret or validate transitions at runtime. A step returns a new state for an accepted change and the identical input object for an unlisted event. Listed targets include the source kind when an event can update payloads without changing kind. Multiple targets describe payload-dependent branches. An empty target list has the same meaning as an unlisted event.

Every state kind has a row, including final states with empty rows. A final state has no listed exits, including self-transitions. A state that can reset is not final, even if its name is `finished`. `initial` is a kind, not a state factory; the owner creates the initial payload. Use `assertNever` at exhaustive switch boundaries so adding a variant requires handling it.

`canMove` says whether the source row lists at least one target for the event. It is a guard for classes whose async effects stay with their owner, not a payload validator or a target selector. Callers retain responsibility for interpreting the event, selecting a listed target and preserving their persistence boundary. The kit does not run effects, replace the command bus or authorize project writes.

## Exhaustive sample checks

Only `@caotang/machine/testing` exports the test helper:

```ts
function checkMachine<S extends { kind: string }, E extends { type: string }>(
  machine: Machine<S, E>, samples: { states: S[]; events: E[] },
): string[];
```

An empty diagnostic list means every supplied state/event pair agrees with the table. The helper requires a sample for every state row and every declared event, validates initial/final kinds and target rows, checks graph reachability of every non-final state from `initial`, and rejects exits from final states. A step that throws is a diagnostic, so a single exception does not hide other failing pairs. An unlisted pair must return the identical state, not a copy with the same kind.

The event union is erased at runtime, so supply every event variant, including events absent from all rows. Include multiple payloads for guards, deadlines and other branches; the checker tests supplied samples, not all possible values, and does not prove that every listed target is exercised. Reachability is a property of the declared graph, not proof that a particular payload can traverse it. Keep scenario tests for async races, effect ordering and domain invariants. Test helpers never load from the runtime entry point.

## Registration and generated documentation

`test/state-machines.registry.ts` imports each converted table explicitly. Register a table when its conversion lands; do not list planned machines as implemented. `test/state-machines.test.ts` renders the registry through `test/state-machines-render.ts` and compares the exact bytes with [state-machines.tables.md](state-machines.tables.md). Duplicate IDs are refused. Machines, state rows, events, final kinds and target lists are sorted without depending on the host locale.

After changing a registered table, regenerate and run its model tests:

```sh
UPDATE_STATE_MACHINES=1 pnpm exec vitest run test/state-machines.test.ts
pnpm verify
```

The generated table is not a second specification to edit. Add the machine's events, persistence boundary and owning spec here, and change its owning spec deliberately when behavior changes. Agent-facing machines may publish transitions through the trace and UI-only machines may expose `data-state`; the kit itself emits nothing and adds no trace or project-format fields.

## Registered machines

### `findings.review`

Owner: `apps/desktop/src/app/coherence-review-state.ts`, held once by `ProjectSession`; product contract: [coherence.md §6.2–6.3](coherence.md#62-run-scoping-bunshos-three-modes-mapped). `plan`, `dismiss`, `start`, `progress`, `stop`, `done` and `fail` drive the pure step. Only `planned` accepts Start, synchronously before model effects. `running` retains the plan, completed-call count and stop request until the effect settles; cancellation wins over either completion or rejection. Complete results return to idle with a retained summary; stopped, partial and failed outcomes remain until the next plan. No state is terminal because a new review can be planned.

The session owns the abort controller and pending promise, applies complete or partial results through its existing findings queue, and stops and settles the review before closing. Findings subscribes through the session and publishes `data-state`; the workspace keeps Show review and Stop visible outside the tab. There is no new persisted field, trace row, or change to the finding-transition table. Exhaustive table tests cover all event pairs; deferred effects and browser tests cover duplicate starts, remounts, progress, cancellation and outcomes.

### `interface.load`

Owner: `apps/desktop/src/app/interface.ts`; product contract: [ui-modules.md §0](ui-modules.md#0-shared-view-rules-apply-to-all-four-modules). `choose` begins loading from any state, while `loaded` and `failed` settle only a loading state. The asynchronous owner publishes only the latest request's completion. `interfaceStatus()` retains chosen and shown interfaces, with a failure detail only in `failed`; Settings subscribes, publishes `data-state` and offers retry. The existing localStorage key, shell-attribute timing and Classic fallback stay unchanged. Exhaustive model and race tests cover stale success/failure; mounted Settings tests cover announcements, retry and focus return.

### `ui.export.compile` and `ui.export.readiness`

Owner: `apps/desktop/src/app/export-dialog-model.ts`; `components/ExportDialog.tsx` interprets readiness, compile and download effects. Product contracts: [ui-modules.md §1](ui-modules.md#1-component-topology-v01-layout) and [exporter.md](exporter.md). Compile events are `start`, `reset`, `succeeded` and `failed`; phases are `idle`, `running` and `failed`. A failure carries its text and optional hook-request key. Recipe notices are separate from compile failures, and changing a choice can reset an old failure. A synchronous current-state guard blocks duplicate compiles and both Escape and Cancel while running, including before React renders the disabled button.

Readiness events are `check`, `ready` and `failed`; phases are `waiting`, `ready` and `failed`. Every check has an increasing request number, and only its matching answer can settle the waiting state. Opening the dialog or retrying a compile starts a new check and clears the old preview result. Late answers from older checks and completions after unmount cannot replace the visible result. The dialog exposes compile via `data-state` and readiness via `data-preview-state`. Neither table has terminal states or persisted fields; exports, recipes, hook overrides and compile-log bytes retain their formats. Exhaustive reducer tests are paired with held-promise browser regressions for dismissal, readiness retry and retryable compile failure.

### `ui.encoding.panel`

Owner: `apps/desktop/src/app/encoding-dialog-model.ts`; `components/EncodingDialog.tsx` owns one panel per file. Product contract: [project-format.md §3](project-format.md#3-document-files). Events are `loaded`, `unreadable`, `choose`, `action`, `ask`, `answered` and `close`. The panel moves from `loading` to `ready` or `unreadable`; `asking` holds a numbered advice request and the current encoding/action. A manual encoding or Leave/Convert choice returns to `ready`, invalidates that request and clears its note. Only a matching answer in `asking` can suggest an encoding; it does not change Leave/Convert. `closed` is terminal, and finish, cancel and unmount reject late answers.

Each file section exposes `data-state`; the existing previews, choices and advice messages are retained, with manual encoding selection available during advice. Tests cover current and stale answers, failures, subsequent requests and every exit. Panel bytes, request numbers and phases remain in memory; conversion decisions, original-byte backups and saved files do not change.

### `import.preview`

Owner: `apps/desktop/src/import-preview/phase.ts`; `ImportPreviewDialog.tsx` interprets reading and commit effects. Product contract: [import-preview.md §5](import-preview.md#5-the-commit-binderimporttree). Events are `progress`, `loaded`, `load-failed`, `commit`, `commit-failed`, `committed` and `cancel`. A source that needs reading starts `loading`; one with no load step starts `ready`. A failed read remains dismissible; a commit failure is a separate retryable phase with the choices retained. Only `committing` accepts a commit result, and it ignores repeat commit and cancel events. `closed` is terminal and carries whether this preview committed.

The dialog publishes `data-state` and an announced committing status. Request replacement settles the displaced preview once with `false`; the numbered request identity prevents its late completion from changing or closing the next dialog. An in-flight write still reports its success or failure to the workspace status line after replacement, so a completed project mutation is not silent. Only the existing command bus writes the imported project and undo step. No phase, request id or new file shape is persisted. Exhaustive reducer samples and browser tests cover rejection, retry, Escape and replacement while old custom and binder commits settle.

### `folder.save`

Owner: `apps/desktop/src/app/folder-save-model.ts`; `components/use-folder-save.ts` interprets folder picking, saves, comparisons and attachment. Product contract: [project-format.md §4](project-format.md#4-write-path-atomicity--crash-safety). Events are `pick`, `save`, `ask`, `saved`, `fail` and `cancel`. `picking` ignores a second pick; `saving` ignores pick, save and cancel. `asking` holds one discriminated question: an overwrite offer with the original snapshot identity or a non-empty folder name. Answering or choosing another folder consumes that question before effects run. Failure returns to `idle` and reports the existing error; success becomes `saved` and permits another gesture. No state is terminal.

The owner updates the reducer's current state synchronously before starting an effect, so two gestures in one React batch cannot start two pickers. Only `saving` announces **Saving to the folder…** on the existing status line; a hidden `data-testid="folder-save"` marker beside the browser-save indicator publishes every `data-state` without crowding its toolbar. Stored folder handles, digests, snapshots and files retain their previous shapes; the store write protocol is unchanged. The exhaustive test checks the table; the browser regression holds the real picker and manifest write separately to test the in-flight windows without sleeps.

### `modern.menu`

Owner: `apps/desktop/src/components/shell/modern/menu-model.ts`, interpreted by `useMenuPhase` for More, New and the narrow Views menu. Product contract: [modern-interface.md §8.5](modern-interface.md#85-the-binder-tab-bar-and-sidebar). Events are `open`, `toggle`, `close` and animation completion (`closed`). Each explicit opening increments an in-memory generation; a completion carries that generation and cannot finish a newer closing menu. Repeated dismissals while closing are ignored. Toggle during closing reopens immediately.

`GlassPopover` still owns animation cancellation, inertness and focus return. More and New keep a fresh popover key on reopening; Views retains its popover. The menu root publishes `data-state="open|closing"` while mounted and unmounts when closed. There is no persistence, trace row, visual or motion change. Exhaustive model tests and a StrictMode hook/popover harness cover stale completions, interrupted animations, timer cleanup and focus return.

### `modern.sidebar`

Owner: `apps/desktop/src/components/shell/modern/sidebar-model.ts`; product contract: [modern-interface.md §8.5](modern-interface.md#85-the-binder-tab-bar-and-sidebar). `sidebarReducer` accepts hover intent/elapsed, pointer enter/leave, close elapsed, press, external open, pin, Escape and scene-chosen events. `closed` carries pending hover intent; `closing` retains whether hover or press opened the sidebar. A close elapsed event carries live pointer/focus facts and either closes or restores the opening intent. Reentry cancels closing, a press takes over a hover-open, and pinning rejects delayed closes, Escape and scene-chosen dismissal.

Timers are effects in `BinderSidebar`, not clocks in the reducer. Changing phase or unmounting cancels them. The component retains the existing focus handoffs and editor-ready polling (the latter belongs to the editor-session batch). The nav's `data-state="open|closed"` remains compatible with existing readers; its sidebar publishes `data-panel-state` with the full phase. Pin persistence remains `caotang.modern.binderPinned`, with `true` or no key. There is no project/bundle format change or trace row. Exhaustive table tests cover every phase and event, including guarded close outcomes and stale elapsed events; browser specs cover focus, external requests and timing.

### `sprint.timer`

Owner: `packages/furniture/src/sprint.ts`; product context: [goals-progress.md §9, item 4](goals-progress.md#9-history-metrics-and-goal-kinds). Events are `start`, `pause`, `resume`, `tick`, `stop`, `setDuration` and `reset`. Timed events carry epoch milliseconds and a session word-total sample. The owner provides the clock; paused time and words typed during a pause do not count.

The existing `SprintState.status` and `transitionSprint` API remain unchanged. `sprintMachine` adapts `status` to `kind` without adding a field to an existing sprint object, preserving identity for ignored events. `sprintTable` describes the reducer's stored status, not `sprintView`'s time-derived status: a running sprint can read as finished between ticks without a transition. A late pause or tick can finish the sprint, so those rows list both outcomes. `finished` accepts `reset` and is not terminal; the table has no final states. There is no persisted sprint record, migration, trace row or new UI state. The existing sprint scenarios remain unchanged, with a separate exhaustive table suite.

### `task.status`

Owner: `apps/desktop/src/app/task-store.ts` exports `taskStatusTable`; `task-queue.ts` interprets it. Product contract: [agent-harness.md §2, Background runs](agent-harness.md#2-interaction-loop). Events are `pump`, `agent-ready`, `cancel`, `close`, `reload`, `resume`, `ready`, `fail`, `settle` and `apply`.

The runtime adds `starting` while waiting for setup and `cancelling` while a run stops. Cancellation during startup is retained, and a later close cannot overwrite it: `cancelling` accepts only `settle`, leading to `cancelled`. A closing active run may be `interrupted`; cancelling it still goes through `cancelling`. If a resumed task cannot start its agent, its pending items fail, but previously staged drafts still settle from `starting` into reviewable `ready`; a task with no drafts settles into `failed`. `failed`, `cancelled` and `applied` are terminal. Scenario tests own the async cancel/close ordering; the table alone is not evidence that an awaited operation honors cancellation.

Saved statuses remain `queued`, `running`, `ready`, `failed`, `cancelled`, `interrupted` and `applied`. `starting` and `cancelling` exist only in memory, and the snapshot keeps the stored status alongside its runtime phase. Neither phase is written to a task record or accepted by the persisted-status reader. No record migration is needed.
