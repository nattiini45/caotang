/**
 * What a read-deny keeps out of a prompt — [context-assembly.md §2](../../../docs/architecture/context-assembly.md), "Withheld".
 *
 * The harness computes the set of withheld binder nodes from the writer's rules (agent-harness §4) and hands it to assembly as
 * `AppSnapshot.withheld`. Assembly then works on a view of the project in which those nodes do not exist: not in the binder map,
 * not in the story so far, not in the focus or a scope, and not as a document body. Every layer reads the view, so no layer can
 * leak what one of them forgot to check, and the withheld text is absent from the prompt bytes, not merely unlisted.
 *
 * A codex entry is not in the tree. It is withheld when it has attachments and every one of them is withheld; an entry attached to
 * any visible node, or to none, stays (codex.md, attachments).
 *
 * The view is what the model is sent. The preview names every item it left out, by title, to the writer only.
 */

import type { ActivityEntry } from '@caotang/bus';
import type { CodexEntry, ProjectState } from '@caotang/store';

import { dropRecord } from './drops.js';
import type { AgentTask, AppSnapshot, DropRecord } from './types.js';
import { ContextError } from './errors.js';

/** Whether a read-deny withholds a codex entry: it has attachments and every node it is attached to is withheld. */
export function entryWithheld(entry: Pick<CodexEntry, 'attachments'>, withheld: ReadonlySet<string>): boolean {
  return entry.attachments.length > 0 && entry.attachments.every((id) => withheld.has(id));
}

/**
 * The project as the agent may read it: without the withheld nodes, their bodies, and the codex entries attached only to them.
 * Anything that reads the project for the agent and is not context assembly (the coherence review's context) reads this.
 */
export function withheldState(state: ProjectState, hidden: ReadonlySet<string>): ProjectState {
  if (hidden.size === 0) return state;
  const entries = state.manifest.codex ?? [];
  return {
    ...state,
    manifest: {
      ...state.manifest,
      tree: state.manifest.tree.filter((node) => !hidden.has(node.id)),
      ...(state.manifest.codex === undefined ? {} : { codex: entries.filter((entry) => !entryWithheld(entry, hidden)) }),
    },
    documents: new Map([...state.documents].filter(([id]) => !hidden.has(id))),
  };
}

/**
 * An activity row that changed a withheld node reads as a change to a withheld part of the project, since its digest names the node
 * by title and L6 sends the digests of the last two turns. The writer’s own words in an earlier request are not edited.
 */
function scrubbed(row: ActivityEntry, hidden: ReadonlySet<string>): ActivityEntry {
  if (!row.affected.some((node) => hidden.has(node.nodeId))) return row;
  return { ...row, summary: 'changed a part of the project that a rule now withholds', affected: row.affected.filter((node) => !hidden.has(node.nodeId)) };
}

export interface WithheldView {
  readonly app: AppSnapshot;
  readonly task: AgentTask;
  /** One record per item left out, for the preview. */
  readonly drops: readonly DropRecord[];
}

/**
 * The snapshot and task assembly runs on. With nothing withheld they are the ones given. A task whose focus is withheld is refused:
 * the harness refuses such a call first (a read-deny implies a write-deny), so reaching here means that check was skipped.
 */
export function withhold(task: AgentTask, app: AppSnapshot): WithheldView {
  const hidden = app.withheld;
  if (hidden === undefined || hidden.size === 0) return { app, task, drops: [] };
  if (task.focus !== undefined && hidden.has(task.focus)) {
    throw new ContextError('withheld', `the focus of ${task.tool} is withheld by a rule, so no prompt was assembled`);
  }
  const { state } = app;
  const present = state.manifest.tree.filter((node) => hidden.has(node.id));
  const entries = state.manifest.codex ?? [];
  const entriesOut = entries.filter((entry) => entryWithheld(entry, hidden));
  const view = withheldState(state, hidden);
  const drops: DropRecord[] = [
    ...present.map((node) => dropRecord(`${node.title} (${node.type})`, { kind: 'withheld' }, 'withheld')),
    ...entriesOut.map((entry) => dropRecord(`${entry.name} (codex)`, { kind: 'withheld' }, 'withheld')),
  ];
  const scope = task.scope?.filter((id) => !hidden.has(id));
  return {
    app: { ...app, state: view, ...(app.activity === undefined ? {} : { activity: app.activity.map((row) => scrubbed(row, hidden)) }) },
    task: scope === undefined || scope.length === (task.scope?.length ?? 0) ? task : { ...task, scope },
    drops,
  };
}
