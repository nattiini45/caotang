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

### `sprint.timer`

Owner: `packages/furniture/src/sprint.ts`; product context: [goals-progress.md §9, item 4](goals-progress.md#9-history-metrics-and-goal-kinds). Events are `start`, `pause`, `resume`, `tick`, `stop`, `setDuration` and `reset`. Timed events carry epoch milliseconds and a session word-total sample. The owner provides the clock; paused time and words typed during a pause do not count.

The existing `SprintState.status` and `transitionSprint` API remain unchanged. `sprintMachine` adapts `status` to `kind` without adding a field to an existing sprint object, preserving identity for ignored events. `sprintTable` describes the reducer's stored status, not `sprintView`'s time-derived status: a running sprint can read as finished between ticks without a transition. A late pause or tick can finish the sprint, so those rows list both outcomes. `finished` accepts `reset` and is not terminal; the table has no final states. There is no persisted sprint record, migration, trace row or new UI state. The existing sprint scenarios remain unchanged, with a separate exhaustive table suite.

### `task.status`

Owner: `apps/desktop/src/app/task-store.ts` exports `taskStatusTable`; `task-queue.ts` interprets it. Product contract: [agent-harness.md §2, Background runs](agent-harness.md#2-interaction-loop). Events are `pump`, `agent-ready`, `cancel`, `close`, `reload`, `resume`, `ready`, `fail`, `settle` and `apply`.

The runtime adds `starting` while waiting for setup and `cancelling` while a run stops. Cancellation during startup is retained, and a later close cannot overwrite it: `cancelling` accepts only `settle`, leading to `cancelled`. A closing active run may be `interrupted`; cancelling it still goes through `cancelling`. If a resumed task cannot start its agent, its pending items fail, but previously staged drafts still settle from `starting` into reviewable `ready`; a task with no drafts settles into `failed`. `failed`, `cancelled` and `applied` are terminal. Scenario tests own the async cancel/close ordering; the table alone is not evidence that an awaited operation honors cancellation.

Saved statuses remain `queued`, `running`, `ready`, `failed`, `cancelled`, `interrupted` and `applied`. `starting` and `cancelling` exist only in memory, and the snapshot keeps the stored status alongside its runtime phase. Neither phase is written to a task record or accepted by the persisted-status reader. No record migration is needed.
