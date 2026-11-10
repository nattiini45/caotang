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

### `export.job`

Owner: `packages/exporter/src/export-job.ts`, interpreted by the serial emitter in `emit.ts`. Product contract: [exporter.md §2](exporter.md#2-pipeline-4-stages-all-inspectable). Events are `render`, `write`, `written` and `failed`. Jobs start queued, render every file, then write and append the log; only a successful append reaches written. Render, artifact-write, rollback and log-append failures reach failed. Both outcomes are terminal; retry creates a new job. Written carries actual output paths; failed carries the job's failures. Comic raster aborts during rendering follow the failed path without a partial file.

`job(id)` publishes the current snapshot and `settled(id)` returns its terminal snapshot. The synchronous digest identifies a queued job, not a written file. The Export dialog, SDK final report and MCP confirmed result use that job instead of cumulative failures or queue idleness. The dialog retains its existing running/failed states and Compile retry action. No state or identity is persisted; artifact bytes, compile-log rows and undo ordering are unchanged. Exhaustive model tests, held render/write/log promises, rollback and retry scenarios, comic cancellation tests and browser/host regressions cover the protocol.

### `mcp.confirmation-round`

Owner: `packages/mcp-server/src/confirm.ts`, used by `tools.ts`; product contract: [extensibility.md §9](extensibility.md#9-caotang-as-an-mcp-server). A round starts `unasked`; `ask` binds its existing sealed payload in `asked`. An elicitation `answer` becomes `accepted` only for an accept with boolean `confirmed: true`; decline, cancel and other elicitation answers become `declined`, `cancelled` and `not-confirmed`. Missing answers and non-elicitation responses leave it `asked`. The four final decisions absorb every event. Changed arguments bind no prior round and require a fresh question.

Lifecycle tags wrap, but are never added to, the signed `RoundState` payload. `accepted` names the host's answer, not a successful write: preparation and current-project checks can still refuse it. Invalid, expired and foreign seals are rejected by the MCP SDK before this dispatch path, rather than represented as reducer decisions. The nonce ledger still publishes the in-flight answer before a concurrent accepted replay can write again. No request-state bytes, TTL, key handling or persistence change; this is an in-memory decision model, not a durable confirmation store.

### `sdk.writer`

Owner: `packages/sdk/src/writer-stop.ts`, interpreted by `folder.ts`; product contracts: [extensibility.md §9](extensibility.md#9-caotang-as-an-mcp-server) and [agent-harness.md §11](agent-harness.md#11-headless-use). A writer starts `open`. A `drift` event stops it in `drift` or `saved-drift`, depending on whether its own manifest save already completed. A `partial` timeline batch stops an open writer in `partial`, or attaches its recovery words to the existing stop without replacing that cause. No stopped state can reopen; the table has no final states because a partial report can still attach recovery information without permitting a write.

`StopReason` is the shared union for these three stopped states. `OpenFolder.changed` and `stoppedError()` remain compatibility projections. The MCP server remembers the announced `StopReason` instead of a second stop flag, and reads `writtenPartway` from the folder's recovery information instead of keeping another copy. Error wording, notification timing and the first stop's precedence stay unchanged. This state is memory only; neither project files nor `.caotang-mcp.lock` change.

### `sdk.events`

Owner: `packages/sdk/src/run.ts`; product contract: [agent-harness.md §11](agent-harness.md#11-headless-use). `end` takes `open` to `ended`; `fail` takes any state to `failed` with the error. This deliberately preserves failure after end and replacement of a failure by a later failure, so no state is declared final. Pushes are accepted only while open. Buffered events drain before an end or failure is delivered.

Pending iterator requests are FIFO, including concurrent `next()` calls. Closing settles every outstanding request after delivering any held events, and iterator return settles that iterator's pending requests with `done`. A failed iterator remains finished for subsequent reads. The table tests cover closure states; scenario tests prove queue ordering, concurrent completion and early return. Nothing is persisted or added to a trace.

### `tab.stop` and `persistence.status`

Owner: `apps/desktop/src/app/tab-stop.ts` and `persistence-model.ts`, interpreted by `Persistence`. Product contract: [project-format.md §4](project-format.md#4-write-path-atomicity--crash-safety) and [ui-modules.md §5.3](ui-modules.md#53-browser-storage-persistence). Each session owns one `TabStop`: `running` accepts `stop(cause)` and becomes `stopped(cause, keptLatest: false)`; only a stopped tab accepts the latest copy's `keep(landed)` result. The cause is `newer-text` or `updated`. The stop cannot reset, but its kept-copy result can change, so it is not a final state. Persistence alone sends these events; the session, pending journal, notice and save wording read that same session's store. There is no page-global cause or current-stop record.

Persistence keeps `idle`, `writing`, `failed(error)` and terminal `conflict(error)`. A write accepts `saved`, `fail` or `stop`; a failed write drops its shadow and retries on the next scheduled pass. Conflict replaces the redundant stopped flag, refuses every later store write, and continues to keep changed words in the unsent copy. Queue coalescing and the stored document shadow stay with the executor. The notice publishes `data-state="stopped"`; the save indicator retains its existing `saved|saving|failed|conflict` contract. The notice stays above other native dialogs, including dialogs arriving later, without unmounting their fields or changing the recovery wording.

The stores and machine states are memory-only. `caotang.unsent.<projectId>` remains the versionless array of `{ stopId, savedAt, documents, origin? }`; no machine state is added to it. A successful latest write counts as kept only while this stop's own entry is still present. Stored projects, bundles and trace formats are unchanged.

### `pending.entry`

Owner: `apps/desktop/src/app/pending-entry.ts`, interpreted synchronously by `PendingJournal`; product contract: [project-format.md §4](project-format.md#4-write-path-atomicity--crash-safety). `empty` accepts `hold(entry)`; `held` and `written` accept newer words, a landed `write`, `prune(storedBody)`, document removal or a return to the stored body (`drop`), and `stop(copyLanded)`. Prune removes an entry only when the store holds its exact body. A stop clears it only when the unsent copy landed. `pruned` and `cleared-for-stop` are final; a later edit creates a fresh slot. A refused storage write leaves the slot held and keeps the journal's existing failure reporting and retry behavior.

The slot's phase is never serialized: `caotang.pending.<projectId>` still stores only `{ docId, body, baseRevision, at }[]`, mutually readable with older builds. Recovery still classifies entries as save, offer or drop before the editor mounts. Kept-word restoration retains the named `RestoreStep` decision (`create|write|done`): retries write an existing empty document rather than creating it twice, and leave a restored document the writer has since edited alone. Entries leave the unsent copy only after the put-back is saved.

### `coherence.finding`

Owner: `packages/bus/src/coherence.ts`; contract: [coherence.md §6.3](coherence.md#63-dismissal-ui-only-and-fixes-agent-proposed). The `open`, `dismissed` and `fixed` events name the requested status. `findingTransition` guards lifecycle functions, bus validation and the store apply through one table; `findingStatusMachine` provides its pure status step. Same-status requests are refused. Dismissal reasons, notes and the agent's postcondition remain domain validation, not table authorization. Upsert retains its existing redetection behavior, including keeping dismissed and fixed findings judged.

The runtime adapter does not add `kind` to a finding or change `coherence.json`. Status undo restores the previous verdict, note and curation stamps through the existing session-only inverse restore table, including absence of `touchedAt`, so Discard run still recognizes an undone first touch. `supersededBy` is reserved and round-tripped, not written by this lifecycle. Exhaustive samples cover every state/event pair; store and browser scenarios cover undo followed by run discard.

### `bus.call-id`

Owner: `packages/bus/src/idempotency.ts`; contract: [command-bus.md §6](command-bus.md#6-idempotency--concurrency). The cache interprets this table around its async effects: `apply` takes an unseen key to in-flight or directly recorded for synchronous execution; `settle` records an in-flight result; `end-turn` forgets either live state. In-flight entries carry a promise, recorded entries carry a result, and absent map entries are unseen. Concurrent async copies share one apply, including reentrant dispatch during the first apply. A synchronous replay of an in-flight call is refused rather than applying twice.

The turn/call key and sorted-parameter fingerprint are unchanged. Mismatched reuse is refused before effects, admission refusals are not cached, and calls without both ids remain unscoped. An unexpected post-admission rejection also settles into a recorded internal error result, so it never strands the key in flight or applies it again. Completing an old promise cannot repopulate a forgotten or replaced turn map. Nothing is persisted or added to traces. The async owner retains its code rather than using a reducer; an exhaustive guard matrix and pipeline scenarios cover the table, replay, mismatch and turn-end boundaries.

### `store.connection`

Owner: `packages/store/src/runtime/store.ts`; contract: [project-format.md §4 and §8](project-format.md#8-runtime-store-vs-artifact-explicit-split). `opening` accepts `opened`, `blocked` or `error`; the error branches into a newer-version refusal or the original browser failure. An open connection accepts `versionchange` into stale, or an ordinary `close` into closed. Stale, closed, blocked, newer and failed are final for that attempt. An ordinary close still yields the browser's normal closed-connection error; a stale close retains the specific newer-tab refusal.

A blocked request rejects with guidance to close the other tabs and reload, rather than leaving startup pending indefinitely. IndexedDB cannot cancel that request: a late success is closed immediately and never published as a usable store. The in-memory test factory models the versionchange/blocked handshake, including cooperative close and delayed success. It serializes opens per database through their completion event and rereads the current version after waiting, so a queued lower upgrade cannot downgrade the store or notify a connection before its success handler can install cooperative close. A throwing or explicitly aborted upgrade restores the previous schema/version, fails its request and releases the queue; a failed first creation leaves no database. Closing connections keep their unfinished transactions as blockers until completion or abort has been delivered. Exhaustive samples and connection scenarios cover the lifecycle. State is session-only; the public RuntimeStore API, DB version 4, saved projects and bundles are unchanged.

### `asset.staging`

Owner: `packages/store/src/asset-staging.ts`; contract: [pictures.md §6.4.2](pictures.md#642-import-reservation-and-retention-ports-p1-and-p8). Events are `reserve`, `commit`, `release`, `take`, `discard` and `cancel`. Staged and reserved states each have a cancelled variant; only reserved variants carry a reservation id. Commit, discard and take remove a token. The removed variants retain the cancellation result for reservation handles that still reference the entry. All members of a reservation are checked before any token moves, and a foreign reservation cannot commit or release a token.

This is a behavior-preserving conversion: cancellation is observable on an existing reservation even after removal; releasing a live reservation resets cancellation for retry; the legacy single-use `take` still returns cancelled staged bytes. The ten-minute expiry remains the host stager's policy, not a new timer here. Tokens and their state are memory-only, so no picture record, bundle or project format changes. Exhaustive samples include wrong reservation ids, and scenarios cover batch atomicity and stale handles.

### `asset.removal-hold`

Owner: `packages/store/src/asset-removals.ts`; contract: [pictures.md §6.4.2](pictures.md#642-import-reservation-and-retention-ports-p1-and-p8). A project/asset pair is clear or held with its active holder tokens. `acquire` adds one holder; `release` removes only that holder, returning to clear after the last one. Unknown and repeated releases change nothing. A later hold cannot be released by an older callback. The pure step replaces an implicit refcount and released flag; the existing revision-conflict refusal for a new reference during removal is unchanged. Hold state is memory-only, and exhaustive samples plus overlap/isolation scenarios cover it.

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

### `mcp.health`

`mcp.health` owns the in-memory configured, connecting, failed, connected and healthy states (extensibility.md §3.2–§3.4). Connect starts before credentials resolve. Listed and approve events separate a successful connection from a reviewed tool list; fail carries a typed reason beside corrective prose. Disconnect, disable and credential/address edits reset the state and invalidate in-flight work with the existing generation fence. Retry clears the old failure. Settings publishes the same state as `data-state` and the failure code as `data-reason`; nothing new is persisted.

### `turn.phase`

Owner: `packages/harness/src/agent/turn-machine.ts`, interpreted by `loop.ts`; contract: [agent-harness.md §§2, 8](agent-harness.md#2-interaction-loop). An event names the requested phase. The table admits planning, approval, execution and retry boundaries, including repeated active phases, and refuses any exit from `done`, `failed` or `cancelled` or a return to `started`. The owner throws on an illegal move rather than publishing it. A successful turn publishes its report before `done`; failed and cancelled turns retain their existing phase-before-report ordering.

### `card.status`

Owner: `packages/harness/src/agent/cards.ts`, interpreted by `loop.ts`; contract: [agent-harness.md §8](agent-harness.md#8-streaming--ui-integration). An event names the requested status. The existing `StatusCard.status`, timestamps, progress and uncertainty fields remain unchanged. A first snapshot may already be running; a step refused before execution appears as a running card that transitions to failed. Subsequent moves obey the table. A rejected move is traced as the requested event with the original state as its target and then throws. Cleanup requests cancellation only for cards that can still be cancelled, rather than silently trying to change finished cards.

A read stopped before any progress card exists ends as stopped without a card transition. If progress already created its running card, Stop ends that card as well. An absent optional progress card is not an illegal lifecycle move.

### `card.decision`

Owner: `packages/harness/src/agent/card-decision.ts`, with redrafting, storage, policy and user interaction interpreted by `loop.ts`; contract: [agent-harness.md §§2, 8](agent-harness.md#2-interaction-loop). `shown` and `held` own the editable plan, revision, notices and edit/retry/stall counts. `hold` permanently makes that card manual. `retry` and `edit` enter named effect states; `redrafted` commits their result or keeps the last good card and advances the stall count. Five ineffective decisions refuse the card. Approval, cancellation and refusal are final. A cut-text approval remains explicit. The pure step owns no model call, approval grant or write.

The turn, status-card and decision owners emit `machine` trace records with the table ID, turn ID, source, event and target. All three are memory-only; no project, task or run-log event changes. Old trace/1 readers skip the additive kind and the new reader accepts old traces unchanged.

### `budget.meter`

Owner: `packages/harness/src/agent/budget.ts`; contract: [agent-harness.md §7.1](agent-harness.md#71-run-limits). Events are `pause`, `resume`, `stop` and `dispose`. Active and paused states own their timing, including nested pause depth. Stopped and disposed states retain that timing so the existing API still accounts active time, answers reservations and detects limits after disposal. Disposal cancels the current timer; a later pause or resume that actually toggles the clock can rearm it, as before. The first stop reason wins. Counters, reservations and timer effects stay with the meter. No state is final, and no budget state is persisted or traced separately.
