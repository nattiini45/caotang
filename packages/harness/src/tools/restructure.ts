/**
 * `binder.restructure` — agent-harness.md §3 row 9, write-confirm, one undo group.
 *
 * **Every op is validated in order, against the tree the earlier ops leave.** A
 * move that closes a cycle which only an earlier move creates is refused here,
 * before anything runs. The check is the bus's own `binder.move` validate, run on
 * a projection of the tree (`projectedSnapshot`), so the rule has one
 * implementation and the batch cannot disagree with what the bus would say.
 *
 * **References name existing ids only.** The spec gives create, move and rename
 * over ids (agent-harness §3: "all target ids exist"), and an op cannot name a
 * node an earlier op in the same batch will create, because the bus mints that id
 * at apply time. A caller that needs both a new chapter and a move into it sends
 * two calls.
 *
 * **Preview** (agent-harness §3 row 9: "the plan card shows the resulting tree
 * diff"). Beside the one line per op, the preview carries the tree the batch leaves:
 * one entry per node it moves, renames or creates, with the parent and the title the
 * node had and the parent and the title it has once the batch has run. A node the
 * batch leaves where it began is left out. A created node is listed under its
 * parent, because its id does not exist until the bus mints it.
 *
 * **Postcondition** (agent-harness §7: "tree validates against project-format
 * schema"): after the batch, the store's manifest validator runs on a clone of the
 * manifest. A fatal finding is reported as `postcondition`, with the undo group
 * named, and nothing is undone automatically (command-bus §7).
 */

import { ok, type CommandError, type Result } from '@caotang/bus';
import { documentIds, validateManifest, type ProjectState, type TreeNode } from '@caotang/store';

import { failure, invalidParams, refusal } from '../errors.js';
import { param, type ObjectSpec } from '../schema.js';
import type {
  CallParams,
  CommandDone,
  PreparedCall,
  PreparedCommand,
  PrepareContext,
  ToolValue,
} from '../types.js';
import { batchRefusal, checkCommand, projectedSnapshot } from './common.js';

const OPS_MAX = 30;

export const restructureParams: ObjectSpec = param.object(
  'The batch of binder operations, applied in order.',
  {
    ops: param.list(
      'Operations, in order: at most 30. Each is a create, a move or a rename, and names existing node ids only.',
      param.tagged('One binder operation.', 'action', {
        create: param.object(
          'Create a folder or a document. A document goes in a chapter, not the manuscript.',
          {
            parent: param.string('The id of the folder or root that will hold the new node.', { nonBlank: true }),
            type: param.choice('Whether the new node is a folder or a document.', ['folder', 'document']),
            title: param.string('The title of the new node.', { nonBlank: true }),
          },
          ['parent', 'type', 'title'],
        ),
        move: param.object(
          'Move an existing node under a new parent, at a position among its siblings.',
          {
            node: param.string('The id of the node to move.', { nonBlank: true }),
            newParent: param.string('The id of the folder or root it moves under.', { nonBlank: true }),
            index: param.integer('The position among the new parent’s children, from 0.', { minimum: 0 }),
          },
          ['node', 'newParent', 'index'],
        ),
        rename: param.object(
          'Change the title of an existing node.',
          {
            node: param.string('The id of the node to rename.', { nonBlank: true }),
            title: param.string('The new title.', { nonBlank: true }),
          },
          ['node', 'title'],
        ),
      }),
      { minItems: 1, maxItems: OPS_MAX },
    ),
  },
  ['ops'],
);

function titleIn(tree: readonly TreeNode[], id: string): string {
  return tree.find((node) => node.id === id)?.title ?? id;
}

/** A node's place in the tree: its parent and its title. A root has no parent. */
interface TreeSlot {
  readonly parentId: string | null;
  readonly parentTitle: string | null;
  readonly title: string;
}

/**
 * One node the batch changes, as the tree reads before and after it. The preview
 * lists these, so a plan card can show where each node was and where it lands.
 */
interface TreeChange {
  /** The node's id. Null for a node the batch creates: the bus mints that id when the create runs. */
  readonly id: string | null;
  readonly change: 'created' | 'moved' | 'renamed' | 'moved and renamed';
  /** What a created node will be. Present on a created node only. */
  readonly type?: 'folder' | 'document';
  /** Where the node was before the batch. Absent for a created node. */
  readonly before?: TreeSlot;
  /** Where the node is once the batch has run. */
  readonly after: TreeSlot;
}

/** A node the batch creates, held until the preview is built. */
interface CreatedNode {
  readonly parentId: string;
  readonly type: 'folder' | 'document';
  readonly title: string;
}

/** A node's place as `tree` reads it: its parent's title, looked up in that same tree. */
function slotIn(tree: readonly TreeNode[], node: Pick<TreeNode, 'parentId' | 'title'>): TreeSlot {
  return {
    parentId: node.parentId,
    parentTitle: node.parentId === null ? null : titleIn(tree, node.parentId),
    title: node.title,
  };
}

export function prepareRestructure(params: CallParams, context: PrepareContext): Result<PreparedCall, CommandError> {
  const { state } = context;
  const ops = Array.isArray(params['ops']) ? (params['ops'] as readonly Record<string, unknown>[]) : [];

  // The working copy the projection is built from. It is changed only by ops that
  // validated, so a failed op cannot leak its effect into a later op's check.
  const tree: TreeNode[] = state.manifest.tree.map((node) => ({ ...node }));
  const failures: { target: string; error: CommandError }[] = [];
  const commands: PreparedCommand[] = [];
  const lines: string[] = [];
  // The existing nodes the batch moves or renames, in the order it first touches them.
  const touched: string[] = [];
  const created: CreatedNode[] = [];
  const touch = (id: string): void => {
    if (!touched.includes(id)) touched.push(id);
  };

  for (const [index, op] of ops.entries()) {
    const target = `ops[${index}]`;
    const snapshot = projectedSnapshot(state, tree);
    if (op['action'] === 'create') {
      const parentId = String(op['parent']);
      const command = { parentId, type: op['type'], title: op['title'] };
      const checked = checkCommand(context, 'binder.create', command, snapshot);
      if (!checked.ok) {
        failures.push({ target, error: checked.error });
        continue;
      }
      commands.push({ name: 'binder.create', params: command });
      created.push({ parentId, type: op['type'] === 'folder' ? 'folder' : 'document', title: String(op['title']) });
      lines.push(`create ${String(op['type'])} "${String(op['title'])}" under "${titleIn(tree, parentId)}"`);
      continue;
    }
    if (op['action'] === 'move') {
      const nodeId = String(op['node']);
      const newParentId = String(op['newParent']);
      const command = { nodeId, newParentId, index: op['index'] };
      const checked = checkCommand(context, 'binder.move', command, snapshot);
      if (!checked.ok) {
        failures.push({ target, error: checked.error });
        continue;
      }
      // The validated command is what gets dispatched, and the validated index is
      // what the preview quotes: binder.move's validate resolves the raw index
      // against the sibling count and hands back the position the node will land
      // at, so a card that echoed the raw index would promise a position the
      // dispatch re-validates away — a preview-vs-result mismatch.
      const validated = checked.value as { readonly nodeId: string; readonly newParentId: string; readonly index: number };
      commands.push({ name: 'binder.move', params: validated });
      touch(nodeId);
      lines.push(`move "${titleIn(tree, nodeId)}" under "${titleIn(tree, newParentId)}" at position ${String(validated.index)}`);
      const moved = tree.find((node) => node.id === nodeId);
      if (moved !== undefined) moved.parentId = newParentId;
      continue;
    }
    if (op['action'] === 'rename') {
      const nodeId = String(op['node']);
      const command = { nodeId, title: op['title'] };
      const checked = checkCommand(context, 'binder.rename', command, snapshot);
      if (!checked.ok) {
        failures.push({ target, error: checked.error });
        continue;
      }
      commands.push({ name: 'binder.rename', params: command });
      touch(nodeId);
      lines.push(`rename "${titleIn(tree, nodeId)}" to "${String(op['title'])}"`);
      const renamed = tree.find((node) => node.id === nodeId);
      if (renamed !== undefined) renamed.title = String(op['title']);
      continue;
    }
    failures.push({
      target,
      error: invalidParams(`ops[${index}] has no known action`, 'each op names create, move or rename as its action', target),
    });
  }

  if (failures.length > 0) {
    return failure(
      batchRefusal(failures, ops.length, 'fix every listed op and resend the whole batch — nothing was written'),
    ) as Result<PreparedCall, CommandError>;
  }

  return ok({
    commands,
    preview: { lines, tree: treeChanges(state, tree, touched, created) },
    finish: (done: readonly CommandDone[]) => verifyTree(state, done, lines),
  });
}

/**
 * The tree the batch leaves, for the preview. A touched node is listed when its parent
 * or its title differs from where it started: the start is read from the store, and the
 * end from the working copy the ops left. A created node is listed under its parent.
 */
function treeChanges(
  state: ProjectState,
  tree: readonly TreeNode[],
  touched: readonly string[],
  created: readonly CreatedNode[],
): TreeChange[] {
  const changes: TreeChange[] = [];
  for (const id of touched) {
    const was = state.manifest.tree.find((node) => node.id === id);
    const now = tree.find((node) => node.id === id);
    if (was === undefined || now === undefined) continue;
    const moved = was.parentId !== now.parentId;
    const renamed = was.title !== now.title;
    if (!moved && !renamed) continue;
    changes.push({
      id,
      change: moved && renamed ? 'moved and renamed' : moved ? 'moved' : 'renamed',
      before: slotIn(state.manifest.tree, was),
      after: slotIn(tree, now),
    });
  }
  for (const node of created) {
    changes.push({
      id: null,
      change: 'created',
      type: node.type,
      after: slotIn(tree, { parentId: node.parentId, title: node.title }),
    });
  }
  return changes;
}

function verifyTree(
  state: ProjectState,
  done: readonly CommandDone[],
  lines: readonly string[],
): Result<ToolValue, CommandError> {
  const affected = done.flatMap((entry) => [...entry.outcome.affected]);
  const undoGroupId = done[0]?.outcome.undoGroupId;
  // A clone, because the store's validator may coerce fields it reads (codex
  // enums on load). Checking live state would be a check that mutates what it checks.
  // Every document node carries a body in memory, which is what the file on save
  // will hold, so each one is passed as present: the check is the tree's, not the disk's.
  const report = validateManifest(structuredClone(state.manifest), {
    docFiles: documentIds(state).map((id) => `${id}.md`),
  });
  const fatal = report.errors.filter((finding) => finding.fatal);
  if (fatal.length > 0) {
    return failure(
      refusal(
        'postcondition',
        `the batch ran, but the tree no longer validates against the project format: ${fatal.map((finding) => `${finding.path}: ${finding.message}`).join('; ')}. The undo group is registered and intact, so this is reversible.`,
        {
          correctiveHint: 'undo the batch and report the failed check to the user; do not retry the same ops blindly',
          details: {
            ...(undoGroupId === undefined ? {} : { undoGroupId }),
            failures: fatal.map((finding) => ({ target: finding.path, code: 'postcondition', message: finding.message })),
          },
        },
      ),
    ) as Result<ToolValue, CommandError>;
  }
  return ok({
    data: { applied: done.length, operations: [...lines] },
    summary: `applied ${done.length} ${done.length === 1 ? 'operation' : 'operations'} to the binder`,
    affected,
    ...(undoGroupId === undefined ? {} : { undoGroupId }),
  });
}
