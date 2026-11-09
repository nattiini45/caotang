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

### `coherence.finding`

Owner: `packages/bus/src/coherence.ts`; contract: [coherence.md §6.3](coherence.md#63-dismissal-ui-only-and-fixes-agent-proposed). The `open`, `dismissed` and `fixed` events name the requested status. `findingTransition` guards lifecycle functions, bus validation and the store apply through one table; `findingStatusMachine` provides its pure status step. Same-status requests are refused. Dismissal reasons, notes and the agent's postcondition remain domain validation, not table authorization. Upsert retains its existing redetection behavior, including keeping dismissed and fixed findings judged.

The runtime adapter does not add `kind` to a finding or change `coherence.json`. Status undo restores the previous verdict, note and curation stamps through the existing session-only inverse restore table, including absence of `touchedAt`, so Discard run still recognizes an undone first touch. `supersededBy` is reserved and round-tripped, not written by this lifecycle. Exhaustive samples cover every state/event pair; store and browser scenarios cover undo followed by run discard.

### `bus.call-id`

Owner: `packages/bus/src/idempotency.ts`; contract: [command-bus.md §6](command-bus.md#6-idempotency--concurrency). The cache interprets this table around its async effects: `apply` takes an unseen key to in-flight or directly recorded for synchronous execution; `settle` records an in-flight result; `end-turn` forgets either live state. In-flight entries carry a promise, recorded entries carry a result, and absent map entries are unseen. Concurrent async copies share one apply, including reentrant dispatch during the first apply. A synchronous replay of an in-flight call is refused rather than applying twice.

The turn/call key and sorted-parameter fingerprint are unchanged. Mismatched reuse is refused before effects, admission refusals are not cached, and calls without both ids remain unscoped. Completing an old promise cannot repopulate a forgotten or replaced turn map. Nothing is persisted or added to traces. The async owner retains its code rather than using a reducer; an exhaustive guard matrix and pipeline scenarios cover the table, replay, mismatch and turn-end boundaries.

### `store.connection`

Owner: `packages/store/src/runtime/store.ts`; contract: [project-format.md §4 and §8](project-format.md#8-runtime-store-vs-artifact-explicit-split). `opening` accepts `opened`, `blocked` or `error`; the error branches into a newer-version refusal or the original browser failure. An open connection accepts `versionchange` into stale, or an ordinary `close` into closed. Stale, closed, blocked, newer and failed are final for that attempt. An ordinary close still yields the browser's normal closed-connection error; a stale close retains the specific newer-tab refusal.

A blocked request rejects with guidance to close the other tabs and reload, rather than leaving startup pending indefinitely. IndexedDB cannot cancel that request: a late success is closed immediately and never published as a usable store. The in-memory test factory now models the versionchange/blocked handshake, including cooperative close and delayed success. Exhaustive samples and connection scenarios cover the lifecycle. State is session-only; the public RuntimeStore API, DB version 4, saved projects and bundles are unchanged.

### `asset.staging`

Owner: `packages/store/src/asset-staging.ts`; contract: [pictures.md §6.4.2](pictures.md#642-import-reservation-and-retention-ports-p1-and-p8). Events are `reserve`, `commit`, `release`, `take`, `discard` and `cancel`. Staged and reserved states each have a cancelled variant; only reserved variants carry a reservation id. Commit, discard and take remove a token. The removed variants retain the cancellation result for reservation handles that still reference the entry. All members of a reservation are checked before any token moves, and a foreign reservation cannot commit or release a token.

This is a behavior-preserving conversion: cancellation is observable on an existing reservation even after removal; releasing a live reservation resets cancellation for retry; the legacy single-use `take` still returns cancelled staged bytes. The ten-minute expiry remains the host stager's policy, not a new timer here. Tokens and their state are memory-only, so no picture record, bundle or project format changes. Exhaustive samples include wrong reservation ids, and scenarios cover batch atomicity and stale handles.

### `asset.removal-hold`

Owner: `packages/store/src/asset-removals.ts`; contract: [pictures.md §6.4.2](pictures.md#642-import-reservation-and-retention-ports-p1-and-p8). A project/asset pair is clear or held with its active holder tokens. `acquire` adds one holder; `release` removes only that holder, returning to clear after the last one. Unknown and repeated releases change nothing. A later hold cannot be released by an older callback. The pure step replaces an implicit refcount and released flag; the existing revision-conflict refusal for a new reference during removal is unchanged. Hold state is memory-only, and exhaustive samples plus overlap/isolation scenarios cover it.

### `sprint.timer`

Owner: `packages/furniture/src/sprint.ts`; product context: [goals-progress.md §9, item 4](goals-progress.md#9-history-metrics-and-goal-kinds). Events are `start`, `pause`, `resume`, `tick`, `stop`, `setDuration` and `reset`. Timed events carry epoch milliseconds and a session word-total sample. The owner provides the clock; paused time and words typed during a pause do not count.

The existing `SprintState.status` and `transitionSprint` API remain unchanged. `sprintMachine` adapts `status` to `kind` without adding a field to an existing sprint object, preserving identity for ignored events. `sprintTable` describes the reducer's stored status, not `sprintView`'s time-derived status: a running sprint can read as finished between ticks without a transition. A late pause or tick can finish the sprint, so those rows list both outcomes. `finished` accepts `reset` and is not terminal; the table has no final states. There is no persisted sprint record, migration, trace row or new UI state. The existing sprint scenarios remain unchanged, with a separate exhaustive table suite.

### `task.status`

Owner: `apps/desktop/src/app/task-store.ts` exports `taskStatusTable`; `task-queue.ts` interprets it. Product contract: [agent-harness.md §2, Background runs](agent-harness.md#2-interaction-loop). Events are `pump`, `agent-ready`, `cancel`, `close`, `reload`, `resume`, `ready`, `fail`, `settle` and `apply`.

The runtime adds `starting` while waiting for setup and `cancelling` while a run stops. Cancellation during startup is retained, and a later close cannot overwrite it: `cancelling` accepts only `settle`, leading to `cancelled`. A closing active run may be `interrupted`; cancelling it still goes through `cancelling`. If a resumed task cannot start its agent, its pending items fail, but previously staged drafts still settle from `starting` into reviewable `ready`; a task with no drafts settles into `failed`. `failed`, `cancelled` and `applied` are terminal. Scenario tests own the async cancel/close ordering; the table alone is not evidence that an awaited operation honors cancellation.

Saved statuses remain `queued`, `running`, `ready`, `failed`, `cancelled`, `interrupted` and `applied`. `starting` and `cancelling` exist only in memory, and the snapshot keeps the stored status alongside its runtime phase. Neither phase is written to a task record or accepted by the persisted-status reader. No record migration is needed.
