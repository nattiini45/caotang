# Hooks — the writer's checks on the agent's calls (v1, first slice)

> Status: **built in part.** Built: the `tool.before` and `tool.after` events, the four `check` kinds, `agent.hooks` in the manifest, `hook.save` and `hook.delete`, and the reports (card, ask-back, turn report, trace, run log). **Specified, not built:** every other event, the Settings › Hooks panel, and every handler that is not a pure check. Each such part is marked below.
> Cross-refs: where a hook sits among the rules and the gate = [agent-harness.md](agent-harness.md) §4 · the two commands = [command-bus.md](command-bus.md) §9 · `agent.hooks` = [project-format.md](project-format.md) §2 · the note the model reads = [context-assembly.md](context-assembly.md) §2 · the extension posture = [extensibility.md](extensibility.md) §4 rule 7.

## 1. Purpose

A writer has rules the agent cannot know: never write the word *suddenly*, never touch a scene marked *Final*, tell me when a draft breaks the point of view. A hook is one such rule, written down where the harness enforces it. The owner of the check is the writer, not the model.

A hook is **data**. The only handler a project file may hold is the pure `check` (§5), so a folder someone else shares can at worst warn the agent or stop one of its steps. It cannot run a program, call a model, reach a server or write the project. That is why hooks sit inside the "no plugin system" non-goal (ARCHITECTURE §4) and not against it.

A hook **never approves**. It runs after the gate has answered, so an `allow` is only "nothing to say", and no decision a hook can return grants a call anything.

## 2. Events

| Event | Fires | Built | A failed check |
|---|---|---|---|
| `tool.before` | for each agent call: at the plan's preflight, and again as the call runs, before the bus is asked | **yes** | `warn` (default) or `block` |
| `tool.after` | after an agent call returned | **yes** | a note for the model (`context`) |
| `export.before`, `export.after` | around `export.compile`, the writer's gesture or the agent's | specified, not built | block with "Compile anyway" for the writer, a hard refusal for the agent |
| `project.save` | before `saveFolder` and `exportBundle` | specified, not built | `warn` only: **a save is never blocked by a hook**; an autosave flush never fires one |
| `turn.submit`, `turn.end` | around the planner call, and after the last step | deferred | `turn.end` `continue` is not built (it spends model calls inside the loop; a `tool.after` note covers the cases) |

All seven names are declared (`HOOK_EVENTS`), so a project file written for a later build loads. A hook for an event this build does not run is **kept and flagged** at load ("runs at export.before, which this build does not run yet; it is kept and has no effect"), and nothing fires it. `HOOK_EVENTS_RUN` is the list that does.

Every call the harness runs is an agent's, including a delegated agent's read and an external caller's (the MCP server and the SDK build their harness with the project's hooks). `matcher.issuedBy` defaults to `agent`; `user` is for the events a later build fires on the writer's own gestures, so a `user` hook matches nothing today. A matcher's `tools` names the tool a call is, and also the in-app tool a write row stands for (`mirrors`): a hook for `scene.draft` holds `scene.apply`, and one for `dialogue.draft` holds `dialogue.apply`, as a rule does.

## 3. Where a hook runs

For a call, in order: the call's params are checked (`prepareCall`), then the rules (a deny refuses), then the grant (`toolGrant`: the plan's or the card's approval), then the port's own state check, then **the hooks**, then the bus, whose gate (hard-deny, write-confirm) still runs and is unchanged. The same order holds for `call`, `callAsync` and `callExternal`. A call the rules or the gate refuse never reaches a hook.

- **At the plan's preflight** (`PlanHost.check`): `HookRunner.preflight` runs the `tool.before` hooks with no effect. It is synchronous and never awaits, never touches the gateway or a connected server, and never runs a port (a test holds all three). A block makes the step `refused`, so the card shows the hook's reason beside the disabled **Approve** (agent-harness §8, "Refusals on the card"), and a mode cannot approve a card with a refused step. A warning rides on the step (`PlanStepPreflight.hooks`, shown as a line on the step) and does not stop approval.
- **As the call runs**: the hooks are asked again, against the project as it stands then. A writer who marks the scene *Final* while the card is open gets the run-time block, not a write: the plan comes back `refused` with the hook's own ask-back (`hook_blocked`), and nothing is written.
- **After the call** (`tool.after`): the hooks run on the result. A failed check becomes a **note for the model** (below). A block cannot undo what ran, so a hook that blocks is reported as a note that says "The step has already run; the writer can undo it."
- **A write ends the turn.** The loop does not send the result of an applied write back to the model, so a `tool.after` note on a write reaches the writer (the report, the event stream, the trace) and not the model in this build. It reaches the model for every call whose result the model reads back: each read, and each external call. A `tool.before` warning travels with the result the same way.

`runtime.ts` is where the three call paths ask: `hooksBefore`, `hooksAfter`, and the plan host's `check`. `agent/loop.ts` only drains what the hooks said (`Harness.takeHookRuns(turnId)`) into the turn's report, events and trace, and puts a result's notes in the body the model is handed.

## 4. Decisions

```ts
type HookDecision =
  | { action: 'allow' }
  | { action: 'warn';    reason: string }
  | { action: 'block';   reason: string }   // tool.before only
  | { action: 'context'; text: string };    // tool.after only
```

The union is extensible and has no `transform`: a hook never rewrites a call's params, because the writer approved the card as shown and a rewrite after the approval is a surprise the card cannot show. `onBlock` is `warn` unless the writer set `block`: blocking is the writer's explicit choice.

**A hook that throws is a warning, never a silent pass and never (by default) a block**: "The hook could not run (…), so the step was not checked." With `failClosed: true` it blocks at `tool.before`. A check that takes over two seconds (`HOOK_SLOW_MS`) is reported as a warning too; a synchronous check cannot be pre-empted, so the bound is the scope of the work (§5), the recorded `ms`, and that warning.

**The refusal.** A block is a `permission-denied` refusal (the writer can remove a hook) whose message is "The hook “name” stopped scene.draft: …" and whose `details` carry `askBackCode: 'hook_blocked'` and the hook's id and name. `AskBackCode` gains `hook_blocked`; its options are "change the step so the hook passes", "drop this step" and "tell the writer which hook is in the way; only the writer can change a hook". `exitCodeOf` maps it to the headless "needs input" code. It is not adjustable by the verify ladder: a plan that fails at run time on a hook ends there, and a step refused at preflight goes back to the model as any refused step does.

**The note for the model.** `ToolValue.hookNotes` is `{ hook, text }[]`. The text can quote the project (a coherence finding names a passage), so the model reads each note as **data**, in an envelope with the turn's id, under a line that says whose it is:

```
Hook “Codex check” reported:
<<untrusted source="hook:Codex check" id="7F3A9C21B04E">>
1 finding from codex.alias-collisions in “The Landing”.
- …
<</untrusted id="7F3A9C21B04E">>
```

The marker, the hidden-character reveal and the defusing of a forged marker are the ones every envelope has (context-assembly §2, `neutralise`). The hook's name is shown on one line with no marker characters. A note does not taint the turn (a hook is deterministic and its note is not a connected server's text), so a tainted turn keeps its one-step confirm and a hook cannot lift it. The refusal of a block carries only what the writer wrote in the hook and counts and titles, never a passage of the project, so it needs no envelope (a rule's `note` is treated the same way).

## 5. Handlers: the `check` kinds

A check is a synchronous pure function over the project, **scoped to the nodes the call touches**: before a call, the nodes its `targets` name (`targets.ts`, the same set a rule is matched against); after it, the nodes it changed, or for a read the nodes it read. A node a read rule withholds is not read. The text a pattern or a word bound looks at is the **prose the call would write**: the prose params of a native tool (`text`, `body`, `notes`, `synopsis`, `ink`), every string of an external tool's arguments, and the draft the loop staged (a scene's text, a dialogue's Ink, each synopsis); never the prompt behind a draft.

| Check | Fails when |
|---|---|
| `pattern` — `{ patterns: [{ match, message }] }` | a pattern occurs in the prose. **Literal and whole-word.** There is no regular expression: a synchronous regex on a shared file is a freeze risk, so none is stored or run (a `regex` key is refused). Text and pattern are NFC-normalised and case-folded and matched by code point. A word edge is open beside a non-word character, at the text's end, and beside a script written without spaces (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar), where there is no boundary to look for; Latin beside Han is two words. |
| `status` — `{ allowed: [status…] }` | a touched node's status is not one of the allowed ones, by vocabulary id or by name. A node with no status fails. |
| `words` — `{ min?, max? }` | the prose a call would write (before), or a touched document (after), is outside the bounds. Words are counted as the project counts them (an unspaced script is segmented). |
| `coherence` — `{ checks: [id…], severityAtLeast? }` | the named deterministic checks (`DETERMINISTIC_CHECK_IDS`) raise an open finding in the touched documents. It runs `scanTool` over a copy of the held coherence file, so nothing is recorded and no finding changes; a dismissed finding stays quiet. More than the scan guard's 20 documents, a check id this build does not have, or a named check the scan did not run (the dialogue checks run on a full scan only), is a failure of the hook (a warning), not a pass. |

A failed check names what failed in the writer's words and counts: `“lantern” appears: Say what the light is.`, `“The Landing” is not marked “Draft”.`, `1 finding from codex.alias-collisions in “The Landing”.` The findings' own messages ride only in a `tool.after` note.

Caps, enforced by the bus on save, by the loader on load and again by the runner: 20 hooks in a project, 50 patterns in a check, 300 characters in a pattern or a message, 30 check ids or statuses, 50 tools in a matcher, 60 characters in a name. The runner reads at most 2,000,000 characters of prose; more is a failure of the hook.

*Specified, not built:* the `mcp` handler (a connected server's read-only tool), the `model` handler (a short prompt on the Background role) and the `command` handler (a program on the writer's computer, with the desktop build). They stay out of a project file whatever else ships: they belong in app settings, after the untrusted-data labelling of outside text, and a project file that names one is dropped at load with a notice naming the hook.

## 6. Storage and commands

Hooks live in the manifest under `agent.hooks`, beside `agent.rules` (project-format §2). The loader reads each hook with the bus's own `readHook` (the check `hook.save` runs), so a hook the load keeps is one the bus would accept:

```json
"agent": {
  "hooks": [
    {
      "id": "h_7K2QX9M4A1",
      "name": "No “suddenly”",
      "event": "tool.before",
      "matcher": { "tools": ["scene.draft", "notes.append"] },
      "handler": { "kind": "check", "check": { "kind": "pattern", "patterns": [
        { "match": "suddenly", "message": "Show the change instead." }
      ] } },
      "onBlock": "block",
      "enabled": true
    }
  ]
}
```

A hook that cannot be read (a handler that is not a `check`, an unknown key, a name or pattern over its cap, a `__proto__` key, a duplicate id, a 21st hook) is **dropped with a notice that names it**, and the project opens. The key set of a hook is closed, so a field this build does not know drops the hook rather than being guessed at. With no hook left the key is removed, and with nothing else under `agent` the `agent` object goes too. Any other key under `agent` is kept as it was read and written back, except the names the app's settings own (`mode`, `defaultMode`, `lockAuto`, `budget`, `loadEveryTool`, `keepTraces`), which a project never carries and a save leaves out (agent-harness §4). Saving then loading is byte for byte the same (`test/hooks.test.ts` in the store).

`hook.save` creates a hook or replaces the one with the same `id` (the store mints the id of a new one); `hook.delete` removes one. Both are `issuedBy: 'user'` in effect (`agentRisk: 'never'`), undoable by an inverse command, and named in `NEVER_EXPOSED`, so no tool can be written over them. A planner-emitted call is refused in the writer's words ("hooks are set in Settings › Hooks, and the agent cannot add, change or remove one"). A test holds that no agent-reachable command writes a hook. `ProjectSession.setAgentRules` keeps the hooks when the writer changes the rules.

Until **Settings › Hooks** ships, the writer writes a hook in `caotang.json`; the commands are the seam the panel will use.

## 7. What the writer and the tools see

- **The plan card.** A blocked step is `refused` with the hook's reason beside the disabled **Approve**; a warning is a line on the step (`PlanStepView.hooks`).
- **The report and the stream.** `TurnReport.hooks` lists, in order, every hook that spoke on the turn (a warning, a block, a note; a hook that allowed is not kept), and each also arrives as an `AgentEvent` of type `hook`. The same hook saying the same thing about the same call is kept once, however often the card is checked.
- **The trace** (agent-harness §5.2). A `hook` record: the turn, the hook's id and name, the event, the tool, the action (`warn`, `block` or `context`), the text it said, the milliseconds, and `failed` when the check threw. The Trace tab shows it as a row. A result's notes are also in the `tool.result` body, because that is what the model was handed. `Leave out manuscript text` stubs the name, the text and the failure.
- **The run log.** A step a hook blocks at run time is a `step.failed` with the hook's words, so a resumed run does not run it.
- **Macros** (extensibility §10). A macro's expansion is a plan like any other: each step passes `tool.before` at the card's preflight and as it runs, and `tool.after` when it returns. A step a hook blocks refuses the whole card.
- **The MCP server.** `toCallResult` carries `hookNotes` in the result. The text can quote the project, so a host reads it as data.

## 8. Evals and tests

`packages/harness/test/hooks.test.ts` holds the matching rules (literal, whole-word, NFC, case-fold, CJK, no pattern syntax), the runner (order, first block wins, throw, slow, caps, `failClosed`), the four checks, the three call paths, and the three invariants: a hook cannot widen the gate (an unapproved write-confirm call and a rule's deny are refused by the gate and the hooks are not asked; `project.deleteNode` stays hard-denied), `PlanHost.check` never awaits or reaches a server or a port, and no tool dispatches a hook command. `test/agent/hooks-loop.test.ts` runs the mock provider: a pattern hook blocks a draft on the card and a note appears in the next request; a hook that blocks at run time ends the step with `hook_blocked`; modes are unchanged; the report, events, trace and run log carry the hook. `agent/untrusted-loop.test.ts` holds that a tainted turn keeps its confirm, and `macro-turn.test.ts` that a macro step is held to a hook. The store's `hooks.test.ts` holds the tolerant load and the round trip.

## 9. Decisions

The decision line is in [decisions.md](../decisions.md), "Agent and tools". The slices that follow: (2) `export.before`, `export.after` and the "Compile anyway" override, a warn-only `project.save`, Settings › Hooks with a test button, the status-card row and an open-time "This project defines N hooks" notice; (3) separate issues for `mcp` and `model` handlers and an app-settings slice, `turn.end` `continue` and `turn.submit` only on demonstrated need, and `command` with the desktop build.
