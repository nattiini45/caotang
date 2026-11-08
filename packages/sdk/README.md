# @caotang/sdk

Run Caotang's agent against a project folder from Node: a script, a CLI, CI, a scheduled task, another tool. It is the same agent the app has, on the same command bus, with a policy answering the cards where the app has a person.

The package is MIT-licensed and private to this workspace, like the others. Node 22.19 or later.

```ts
import { openProject } from '@caotang/sdk';

await using project = await openProject({ root: './my-novel', provider: 'mock' });
const run = project.run('Check the manuscript for continuity problems.');
for await (const event of run) {
  if (event.type === 'model.delta') process.stdout.write(event.delta);
}
const report = await run.report;
console.log(report.status, report.summary);
```

## What it gives you

- `openProject(options)` opens a folder that holds a Caotang project, takes the folder's single-writer lock (`.caotang-mcp.lock`) and resolves to a `CaotangProject`. A second `openProject` on the same folder is refused with `ProjectLockedError` while the first is open, and so is a folder the desktop app or an MCP server holds.
- `project.run(intent, { signal })` runs one turn and returns an `AgentRun`: an async iterator of the loop's events (`turn`, `model.delta`, `card`, `plan`, `checkpoint`, `report`, ...) and a `report` promise for the `TurnReport`. The last event is the `report` event, and it equals `await run.report`. You may read only the events, or only the report. Turns run one at a time, in the order they were started.
- `project.run(intent, { plan })` runs a plan the caller wrote (`{ steps: [{ tool, params, expect }] }`) with no planner call. The plan is checked as a planner's is, its drafts are staged, and its card is decided by the policy like any other.
- `project.call(tool, params)` is one registry call, gated exactly as an MCP caller's is: it runs no model and no plan, a read runs, and a tool that needs approval is refused with its reason. A refusal is a result (`{ ok: false, error }`), never a thrown error.
- `project.diff()` lists what saving would change in the folder, file by file, as plain text (`added`, `changed`, `removed`, with `before` and `after`), before anything is saved.
- `project.save()` writes the folder, and `project.close()` (or `await using`) saves if the project is open for writing and releases the lock.
- `project.state` is a read-only view of the project. Every change goes through `run()` or `call()`, and so through the command bus and its hard-deny list.

## The project's agent rules

A project folder may carry the writer's rules for the agent in `caotang.json` (`agent.rules`), and the SDK holds every turn and every `call()` to them, exactly as the app and the MCP server do. The rules travel with the folder, so a script cannot step around what the writer set in the app.

- A `deny` with `read` (or `any`) access keeps its subtree out of **every** model request the SDK makes: the binder, the document bodies, and the codex entries attached only to it. `doc.read`, `notes.read`, a scan and a delegate that name one are refused with the rule's note, and the refusal never names the title or quotes the text. The other documents still read.
- A `deny` with `write` access refuses the step before its draft is made, so no model call is spent on it and nothing is written.
- An `ask` rule forces a card even for a call that would otherwise run at once (`meta.set`), so `'auto'` and `'read-only'` cancel it and nothing reaches the folder. `'approve-all'` approves it as shown, as it approves any card.
- A plan you write runs without a card when every step is a read: a read needs no approval, and a headless host has nobody to give one. A read a rule refuses is a refused step in the report, and the plan's other reads still run.

A rules file that cannot be read fails closed. The app shows the writer a warning for a rule the load had to drop, so a lost rule is visible there; a script has nobody to tell, and a lost rule is a restriction nobody hears about. So when `agent` is not an object, `rules` is not a list, or one rule was dropped, the SDK treats the rules as **unreadable**: every call that changes the project is refused (`permission-denied`, `the rules could not be read`) until the file is put right. Reads still work, and the rules that were read fine still withhold.

## Approval policy

The loop asks for a decision on every card and does nothing until it is answered. `approval` says who answers.

| `approval` | Cards | A write that needs no card (`meta.set`, `notes.append`) |
|---|---|---|
| `'read-only'` (default) | cancelled | refused |
| `'auto'` | cancelled | runs |
| `'approve-all'` | approved as shown | runs |
| `{ approveTools: ['synopsis.fill'] }` | approved as shown when every step still to run is a listed tool; any other card is cancelled, whole | runs |
| `(pending) => Decision` | your function decides | runs |

A card a built-in policy cancels ends the turn as `cancelled`, with `askBack.code === 'needs_input'` on the report, which names the step and the policy. `'approve-all'` never keeps a draft the provider cut off at its output limit: that card is cancelled, and the report says why. A function policy can accept the cut text with `{ action: 'approve', acceptTruncated: true }`, knowingly. `approveTools` filters whole cards, not primitives: a plan card that holds `synopsis.fill` and `binder.restructure` is cancelled when only `synopsis.fill` is listed, and the report names `binder.restructure`. It keeps `approve-all`'s rule for a cut draft. `onDecision(record)` is called with every answer to every card, whichever policy gave it, with the turn, the card's kind, the action and the rule that applied, so an unattended run can be audited. A function that throws cancels the card, and the turn's report rejects with its error once the turn has ended. Aborting the `signal` cancels a card that is waiting.

## Writing, and the safety net

`write` defaults to `false`: changes stay in memory, nothing in the folder changes (an export lands in memory too), and `diff()` shows what a save would do. With `write: true` the folder is saved after each turn and each `call()` that changed the project, and `coherence.json` follows it (never under `'read-only'`). A turn that changed nothing writes nothing, and a file left spelled as it was (CRLF, say) is not rewritten by it.

`restore(turnId)` takes a turn back, in memory, while the process lives: the undo history is not saved. Call `save()` afterwards to write the restored project. Git is the long-term safety net.

If another program changes the folder while a project is open, the writes stop and the report (or `save()`) rejects with `FolderChangedError`; the change is still in memory.

## The provider and the key

`provider: 'mock'` is the deterministic demo provider: no key, no network. It answers the app's demo requests (draft the opening scene of The Friend, fill in the synopses for Chapter 1, check the manuscript for continuity problems, review the manuscript for contradictions) and refuses everything else in words.

A real provider is a profile, as the Settings form takes one, and a key:

```ts
provider: {
  profile: { name: 'Anthropic', preset: 'anthropic' }, // the preset fills in the address and the default model
  apiKey: () => process.env.ANTHROPIC_API_KEY,   // or a string
  thinking: 'low',
}
```

The key is read once, sealed into an in-memory key store, and sent only to the profile's own origin, through the gateway's egress pin. It is never written to the folder, to a report, to an event or to an error message; the gateway redacts it from a provider's reply. Caotang runs no server and no relay.

## Examples

### 1. The demo provider, no key

```ts
import { openProject } from '@caotang/sdk';

await using project = await openProject({
  root: './my-novel', // the project needs scenes called "The Landing", "The Storm" and "The Friend" for the demo intents
  provider: 'mock',
  approval: 'approve-all', // write: false, so nothing on disk changes
});

const run = project.run('Draft the opening scene of The Friend.');
const report = await run.report;
console.log(report.summary); // Applied: drafted "The Friend" (49 words).

for (const change of await project.diff()) console.log(change.kind, change.path);
```

### 2. A read-only review with a real key, for CI

```ts
import { openProject } from '@caotang/sdk';

await using project = await openProject({
  root: process.cwd(),
  provider: {
    profile: { name: 'OpenRouter', preset: 'openrouter' },
    apiKey: () => process.env.OPENROUTER_API_KEY,
  },
  // approval defaults to 'read-only': a card is cancelled, nothing is written
});

const report = await project.run('Check the manuscript for continuity problems.').report;
console.log(report.text ?? report.summary);
process.exitCode = report.status === 'failed' ? 1 : 0;
```

The deterministic scan is a read, so it runs under `'read-only'`. A model review is a card (it spends tokens), so it needs `'approve-all'` or a function policy that approves a `coherence.review` card.

### 3. Approve everything and write the folder

```ts
import { openProject } from '@caotang/sdk';

const project = await openProject({
  root: './my-novel',
  provider: { profile: { name: 'Local', preset: 'ollama' } }, // a local server needs no key
  approval: 'approve-all',
  write: true, // the folder is saved after each turn
  maxModelCalls: 12,
});

try {
  const run = project.run('Fill in the synopses for Chapter 1.');
  for await (const event of run) {
    if (event.type === 'card') console.log(event.card.tool, event.card.status);
  }
  const report = await run.report;
  console.log(report.status, report.undoGroupId);
  // Take the turn back, in memory, and write the restored project:
  // project.restore(report.turnId); await project.save();
} finally {
  await project.close();
}
```

Look at `diff()` before you set `write: true` on a project you care about.

`onSave(changes)` is called after each write of the folder with the files it changed, because `diff()` is empty once the folder is saved. `project.provider` names the preset and the model the turns run on.

## The command line

`caotang agent` in [`@caotang/cli`](../cli/README.md) is this package with flags: read-only by default, the diff printed without `--write`, the key from an environment variable, JSON out.

## How it is built

| File | What it is |
|---|---|
| `src/open.ts` | `openProject`: the folder, the product harness, the provider, the agent session and the turn queue. |
| `src/approval.ts` | The approval policies, and what a cancelled card reports. |
| `src/rules.ts` | The folder's agent rules as a headless host reads them, shared with the MCP server: a rule the load dropped, or a manifest that cannot be read, fails closed. |
| `src/providers.ts` | One profile over an in-memory key store and a gateway that sends every role through it. |
| `src/run.ts` | The event queue behind `AgentRun`. |
| `src/diff.ts` | What a save would change, compared with the folder. |
| `src/folder.ts` | The Node folder session the MCP server shares: lock, folder-drift checks, write queue, exporter with its font loaders. |
| `src/node-fs.ts`, `src/lock.ts`, `src/coherence-file.ts` | The store's `ArtifactFs` on `node:fs`, the single-writer lock, and the Node host's copy of `coherence.json`. |
| `src/folder-api.ts` | The `@caotang/sdk/folder` entry, which `@caotang/mcp-server` imports. It is a seam between two hosts, not the public surface. |

`src/` does not touch `window`, `document`, `indexedDB` or any other browser global; an ESLint rule on the folder keeps it that way. The spec is [docs/architecture/agent-harness.md](../../docs/architecture/agent-harness.md) §11.
