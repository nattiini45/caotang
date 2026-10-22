/**
 * `@caotang/sdk` — run Caotang's agent against a project folder from Node (agent-harness.md §11).
 *
 * ```ts
 * import { openProject } from '@caotang/sdk';
 *
 * await using project = await openProject({ root: './my-novel', provider: 'mock' });
 * const run = project.run('Check the manuscript for continuity problems.');
 * for await (const event of run) if (event.type === 'model.delta') process.stdout.write(event.delta);
 * console.log((await run.report).summary);
 * ```
 *
 * The public surface is `openProject` and the types around it. Nothing from an internal package is re-exported as a value.
 */

export { openProject, type CaotangProject, type OpenOptions } from './open.js';
export type { ApprovalPolicy } from './approval.js';
export type { ProviderConfig } from './providers.js';
export type { AgentRun } from './run.js';
export type { FileChange } from './diff.js';
export { LOCK_FILE, ProjectLockedError } from './lock.js';
export { FolderChangedError, NoProjectError } from './folder.js';

// The types a caller meets on the events, the cards and the reports, so it need not depend on the internal packages to name them.
export type { AgentEvent, Decision, PendingCard, ToolOutcome, TurnReport } from '@caotang/harness';
export type { NewProfile, TaskRole, ThinkingLevel } from '@caotang/gateway';
export type { LoadNotice, ProjectState } from '@caotang/store';
export type { CommandError, Result, UndoOutcome } from '@caotang/bus';
