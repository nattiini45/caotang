# @caotang/harness

The agent: the tool registry (agent-harness.md §3) and the interaction loop built on it (§2).

- **Registry** (`src/metadata.ts` for the rows, `src/runtime.ts` and `src/tools/` for the calls): the frozen fourteen
  of v0.1 (`agent.plan` is the fourteenth, the protocol row) and twelve extension rows, 26 in all
  (agent-harness §10). Every call is validated against a closed-set schema,
  prepared through the bus's own `validate`, gated, and dispatched.
- **Loop** (`src/agent/`): intent → context → model → plan or confirm → bus → verify ladder → report.
- **Evals** (`src/agent/eval.ts`, `test/eval/`): scenarios with strict and unordered matchers and token ceilings.

## Decision: the tool-call wire protocol

**The planner speaks one of two wires, picked per turn by the model's capabilities: native tool calls
when the gateway's `modelCaps` reports `tools` for the request's profile and model, the JSON-in-text
envelope otherwise.** The turn's steps, cards and ladder are the same either way; the wire only
changes how calls and results travel (`src/agent/protocol.ts`, `src/agent/loop.ts`).

On the JSON wire the reply is exactly one of two objects in the content:

```json
{"steps": [{"tool": "scene.draft", "params": {...}, "expect": "..."}]}
{"reply": "..."}
```

On the native wire the request declares the tools (`plannerToolDefs`: the registry's core tools, then the
deferred rows the turn has loaded, then the external tools it has loaded), the reply's `toolCalls` are the plan's steps in order,
its text is the card's rationale — it fills each step's `expect`, which the wire does not carry — and
every call is answered by a `tool`-role message keyed by its id. A call that never ran is reported
not run, so the model always hears back about all of them.

Why this shape:

1. **The wire follows the model, it is never assumed.** `modelCaps` answers what the profile's route
   can do; a gateway or profile that reports nothing gets the JSON envelope, which every endpoint
   serves. The declarations are rebuilt for each request, so a tool `tool.search` loads mid-turn is
   declared on the next one.
2. **The spec's structured path is `responseFormat`, and only the JSON wire sends it.** provider-gateway
   §5 says the harness needs JSON for plans; the gateway states the schema in a system message and
   sends `response_format` only where a probe says the endpoint accepts it. The native wire states the
   same rules worded for calls, in the same system message (`plannerSystemNative`).
3. **The check is the registry's own.** A step's shape is checked with `planParams`, and its params with the
   tool's closed-set schema (`checkParams`). The same declaration produces the schema the planner is shown
   and the one declared on the wire, so a key the schema lists is a key the validator accepts, and no other.
4. **A model cannot write what only the loop may stage.** Generated prose, synopses and findings are
   *proposals*: the loop drafts them with a separate model call and the card shows them. A step's params
   never carry a proposal, whichever wire brought the step, and the external caller's calls have any
   proposal removed before a port sees them (`runtime.ts`).
5. **A malformed reply is answered in words.** A non-JSON reply, a refused step or a retry all go back to the
   model as a message naming the shape it should have had. A call whose arguments do not parse is refused
   by its call id, the same way. The turn does not fail on a bad reply.

The planner's system message is built from the registry: only core tools that are callable and wired are listed,
each with its risk, description and schema, and `agent.plan` never appears (it is the protocol, not a tool). A
deferred row (`load: 'deferred'`) is declared once `tool.search` or `submit(intent, { preload })` loads it for the
turn, and its descriptor follows the system message, so a mid-turn load leaves the system message as it was
(agent-harness §3).
The two system prefixes (`PLANNER_SYSTEM_PREFIX`, `DRAFT_SYSTEM_PREFIX`) are duplicated in
`@caotang/gateway/mock` so its scripts can tell the calls apart; a test asserts the copies agree.

## Module map

| File | Role |
|---|---|
| `src/runtime.ts` | `createHarness`: the call path, the tool gate, the port path, plan execution, external callers |
| `src/plan.ts` | Plans: preflight, execution from a step (`from`), the shared `AskBack` envelope (six codes) |
| `src/hooks.ts` | Hooks (hooks.md): `createHookRunner`, the four pure checks, the literal whole-word matching, and the decisions. The runtime asks it at the plan's preflight, as a call runs, and after it returns |
| `src/macro.ts` | Macros (extensibility.md §10): `checkMacro` against the registry, `expandMacro` into a `Plan`, the derived risk. A macro is the writer's, not a registry row |
| `src/agent/preload.ts` | `PRELOAD_BY_CONTEXT`: the deferred rows a turn starts with when a dialogue container or a storyboard is open |
| `src/agent/protocol.ts` | The two wire protocols, the reply shapes, the tool declarations, the planner's system messages, the model-facing messages |
| `src/agent/context.ts` | `ContextPort` and the product's port over `@caotang/context`: the layers it assembles (L1–L7), the harness's own L0 role text, the turns before this one as L6, the drop reasons, the layer budgets and the prompt preview (`buildPreview`) |
| `src/agent/drafting.ts` | Generation for the three model-backed tools and the planner's reply, streamed through the gateway, with each finish reason (and the reported completion tokens) read |
| `src/agent/ports.ts` | `codex.read` (via `@caotang/codex`), `scene.draft`, `synopsis.fill`, `continuity.scan`, and previews |
| `src/agent/cards.ts` | Status cards (their lifecycle), grouping, plan cards, edits, the dependency badge, the steps that have run |
| `src/agent/loop.ts` | `createAgentSession`: the turn, the decisions, the ladder, the conflict re-show, the bound, the report, the restore |
| `src/agent/events.ts` | The event stream (§8), the report, the trace, the checkpoint label |
| `src/agent/trace.ts` | The agent trace (§5.2): the `caotang.trace/1` records and their schema, the in-tab store, the gateway observer and `parseTrace` |
| `src/commands/` | Slash commands (§2): `parseSlash`, `expandTemplate` and `resolveSlash` (`slash.ts`), the nine built-ins and the plans they build (`builtins.ts`), and the document resolver (`resolver.ts`); pure, no model |
| `src/agent/eval.ts` | The scenario format, the runner, the matchers, the undo-replay check |

## How a turn runs

1. **Context.** The `ContextPort` assembles the layers for the intent. The assembler is `@caotang/context`,
   which this package depends on. The port replaces the system message with the harness's own L0 text, and
   the turns before this one reach the call as L6.
2. **Reply.** The planner is called with the reply schema. Reads run at once and their results go back to
   the model. Anything else is a write.
3. **Staging.** Model-backed steps are drafted before anything is shown. A refusal here (no such document,
   an empty draft, a call the turn cannot afford) goes back to the model. Each draft records its document's
   revision before the model is asked, so the draft is staged against the text the model was given.
4. **Cards.** One write-auto call runs at once, with no card. One write-confirm call gets a one-step confirm
   card. Several steps get a plan card. A card whose preflight refuses a step is shown, and it cannot be
   approved. The user can edit it or cancel it.
5. **Decisions.** The session asks `decide(pending)` for each card and waits. An edit is checked and the card
   is shown again, so an approval always covers the card as it now stands. A retry drafts the pending steps
   again. A cut draft is approved only with `acceptTruncated`. An approval the card refuses is shown again with
   the reason, and five decisions in a row that change nothing end the turn.
6. **Execution.** Approved steps run through the harness under the approval the card carries (`confirmed`
   or `approvedPlan`), so the bus gate checks it. A port's `editor.replaceRange` runs under the port's own
   grant (`inheritedGrant`), and a direct dispatch of the same primitive is refused.
7. **Verify ladder** (agent-harness §7). A refused step that changed nothing is adjusted by the model, shown
   again and approved again, twice at most. A step that changed something, or an anchor that did not resolve,
   stops the turn with an ask-back. Nothing is undone automatically.
   **Steps that have run are pinned.** A step that applied is recorded by origin in its card's `completed`
   set. It is shown as done, a retry resumes after it and never runs it again, and no edit may drop, change or
   move it (a reorder cannot carry a pending step across one). So a retry after an applied step, and a cancel
   after it, both keep the turn's undo group.
8. **Conflicts.** A draft whose document has changed since it was staged is refused at apply by the revision
   backstop (command-bus §6). The draft is kept on the card, marked stale, and the card is shown again with the
   reason. It cannot be approved until it is drafted again (Retry) or the card is cancelled.
9. **Bound.** Every model request passes one call site that counts it against `maxModelCalls` (default 8).
   A draft is checked against the calls left before it is asked for, so a batch the turn cannot afford is
   refused back to the model with a split named, and a retry the turn cannot afford is a notice on the card.
10. **Report.** The status, the summary, the steps, the cards and their decisions, the trace, the undo group,
    the ask-back if there is one, and the tokens. The turn's undo group is the checkpoint: "restore to before
    this turn". The group is recorded the moment a run applies anything, so a turn that is cancelled, stopped on
    a failed model call, or stopped by the bound after an applied step still has its checkpoint, and its summary
    says what was written before the stop.

### The ask-back codes

`AskBack.code` is one type with six values:

- `needs_input`: the user has to act. This covers a refusal the ladder may adjust, a turn that used its
  model-call bound, and a provider call that failed (a rejected key, an unreachable endpoint). A provider failure
  is not a postcondition, so it is `needs_input`, with the next actions the user has: check the profile, or
  switch it.
- `conflict`: a revision moved. The draft is not rewritten by the model. It goes back to the card, where it is
  retried or cancelled (step 8 above).
- `verify_failed`: a postcondition failed, or an internal defect. Reported, and not retried.
- `anchor_unresolvable`: a selection the ladder could not place, with up to three candidates and the drift.
- `budget_exhausted`: the run reached a limit the writer set (a run limit, agent-harness §7.1), or the call that would pass one was not sent.
- `hook_blocked`: a hook the writer set refused the step (hooks.md). Only the writer can change a hook; the options say so.

### Model-call stops, and the draft a provider cut

- **A cut draft.** The provider's finish reason `length` means it stopped at its output limit. The draft is staged
  as cut, the card shows it, and approval needs either a retry or `acceptTruncated: true`. A cut `continuity.scan`
  reply is not parsed as findings, because a cut list is not a complete one: it is refused back to the model.
- **A cut planner reply.** A cut reply that parses is planned as it is. One that does not parse is answered with words
  that name the cut ("cut off at the model's output limit" when the reported completion tokens reached the request's
  cap, "cut off before it ended" otherwise) and asks for a shorter reply, not with a JSON syntax error; a native
  refusal keeps its step number. The next request asks for twice the cap, never above the model's advertised cap
  (`modelMaxOutputTokens`), and only after a reply that reached its cap. A second unreadable cut, or one that leaves no
  call for the retry, ends the turn as `needs_input` naming the output limit. A native reply cut after calls that all
  parsed is a card with `replyCut`, approved only with `acceptTruncated`. The report's `cutReplies` counts them.
- **An errored stream.** Finish reason `error` means the answer ended on a failure with part of it. Nothing is
  staged from it. The turn stops as `needs_input`, and no ghost preview is offered.
- **The bound.** A turn that uses `maxModelCalls` stops as `needs_input`, with the count in its reason.

### The prompt on a card (context-assembly §5)

Every model-backed step's card carries the prompt that produced its draft: each layer with its estimate and its
budget, each codex entry included and why (`always`, `matched 2 times in the brief`, `attached to Chapter 1`),
each dropped item and why, the focus text's first 120 characters with its clip size and the end marker, and the
estimated prompt and completion tokens (ceil(chars/4)). The card and the request are built from the same
`assemble()` call, so they cannot drift.

### Per-tool budgets (context-assembly §3)

- `synopsis.fill` sends each document's text capped at 25,000 characters from its start, with its notes after the
  body inside the same cap. A cut is a drop reason, naming both lengths.
- `continuity.scan` sends each document's last 1,000 characters. A call checks at most 20 documents, and a larger
  scope is refused with the split named. The schemas state both limits as `maxItems`.

### Anchors

`scene.draft` in `rewrite_selection` resolves its `TextAnchor` with `@caotang/editor`'s `resolveAnchor`, the same
ladder the editor's anchored apply uses (edit-anchors §3). The sync port calls it directly, after the loop has
awaited `preloadAnchorLibraries()`, because the port is synchronous and the preload is not. The anchor resolves
against the document as it is at apply time, so its drift is the apply-time revision minus the captured one. The
write itself carries the revision the draft was staged against, so a draft the user overtook is a conflict.

## Events and the status-card lifecycle

The session emits `AgentEvent`s in order: `turn`, `model.delta` (streamed text), `model.call` (a model request is about to go out: the count so far and the bound), `context`, `card` (each status
card's lifecycle: `pending-approval`, `running`, `done`, `cancelled`, `failed`), `plan`, `ghost` (a draft handed
to the ghost preview, with its words, its title and whether it was cut), `findings`, `ladder`, `checkpoint` (the
label and the undo group), and `report`. `groupCards` groups consecutive calls of one turn, open while any is running. `reduceTaskList` folds the same events into the turn's task list
(agent-harness §8), and `headerLineOf` words the line the agent header shows.

## Turn identity and tokens

A turn is `<session>.turn-<n>`. The session name is random unless the caller pins one (`sessionId`; the evals
pin theirs), so two sessions on one gateway, whose ledger keys its rows by turn, never share a turn id, and the
bus's undo groups and the call cache never reuse one either. Within a turn, call ids are counted from the turn,
so a replay within a session is deterministic. Every model request carries its `turnId`, and the report reads its
totals from `gateway.ledger.turnTotals(turnId)`. A turn's figures are its own requests, not a running total.

## Evals

A scenario states an intent, a project, a gateway (its mock scripts are the model), the decisions the user makes,
and an expectation: the status and ask-back (with its candidates and drift), the cards with `strict` or `unordered`
matching, the trace with its params as a subset, the requests the model was sent (with what their system message
carries), the drops, the token and model-call ceilings, a restore check, and a state check.

- `test/eval/scenarios.test.ts`: nineteen scenarios across single-op, multi-step, plan-edit, verify-recovery,
  permission, anchor and undo. The anchor scenario asserts its candidates and its revision drift, and the undo
  scenario asserts the restored project is byte-equal to the one before the turn.
- `test/eval/codex.test.ts`: the five codex scenarios of codex.md §9. Budget-prune determinism is run twice.
- `test/eval/demo.test.ts`: the three zero-key demo intents of context-assembly §6, end to end on the mock.
- `test/eval/eviction.test.ts`: command-bus §5.1's snapshot-eviction invariants, from 108 writes the harness made.
- `test/agent/*.test.ts`: the loop, the cards, the ports, the context, the inputs, the protocol, the matchers and
  the ask-backs. Every loop test runs through `evaluate`, so the expectation it states is checked.

The three demo intents are defined here, in `@caotang/gateway/mock` (`DEMO_INTENTS`). context-assembly §6 names
the wizard's three intents by count only, so this package chose the three model-backed tools for them.

## Verification

```
node node_modules/typescript/bin/tsc --noEmit -p packages/harness/tsconfig.json
node node_modules/eslint/bin/eslint.js packages/harness
node node_modules/vitest/vitest.mjs run packages/harness
```

`packages/harness/tsconfig.json` includes `../editor/src/ambient.d.ts`: the editor's lazy `diff-match-patch` import
is typed there, and the harness program has to see it.

## Open items and known gaps

- **Context.** The layers come from `@caotang/context`: L3 (structural synopses) and L4 (prior-scene synopses)
  are built, and so are the per-tool expansions of `continuity.scan` (the codex layer at 2.5k and the
  story-so-far at 6k) and `synopsis.fill` (the document capped at 25k, with L3). The codex layer is
  fitted in two phases (context-assembly A3): the `always` entries are reserved, the rest are fitted into what they
  leave, and `always` entries that alone exceed the budget are sent whole with the overflow named in the preview.
- **The planner's cut reply.** A cut planner reply's retry is once and asks for twice the cap; the plan card's cost
  estimate is not recomputed for the raised cap, and a cut native reply of reads only runs its reads without a card.
- **Ghost preview.** The ghost is a `ghost` event with Apply (approve), Retry (`retry`) and Discard (cancel).
  The region itself, the streamed rendering and the in-editor placement are the UI's, not this package's.
- **Steering and queued messages** are v0.2 (agent-harness §10). A turn cannot be steered once it starts.
- **Restore scope.** The restore reverses the whole turn's group. The sentence that says edits made after the
  turn are included is the UI's to show.
- **`continuity.scan`** is read-only and returns findings. The coherence module (coherence.md) supersedes it
  later, as the spec says.
- **Tool descriptions.** The four port tools' descriptions dropped "Not wired in this build". `synopsis.fill` and
  `continuity.scan` state their limits and are at `descriptionVersion` 3 (§9): their schemas gained `maxItems`.
  `scene.draft` is at 2, unchanged. The other caps and versions are as before.
- **Snapshot eviction.** The fixture (`test/eval/eviction.test.ts`) runs the store's retention planner over real harness writes. It
  does not run `evictSnapshots`, which needs a browser store. The sweep's rules are pinned in `packages/store/test/snapshot-retention.test.ts`,
  and `e2e/snapshot-eviction.spec.ts` runs it against a real IndexedDB, with a mid-sweep abort and Settings › Data › Trim.
