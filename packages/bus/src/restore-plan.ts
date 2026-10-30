/**
 * Restore plans — [command-bus.md §5](docs/architecture/command-bus.md), "Independence rule".
 *
 * A restore to before an older checkpoint has always taken back every later group first, because a body snapshot is a full body and
 * the bus does not re-base it: putting an old snapshot back over text a later group wrote would lose that text. `restorePlan` asks
 * whether that is needed. It answers `exact` — the target can be undone on its own and the later groups stay — **only on a positive
 * proof**, and `with-later` for everything else. Nothing here runs a command; it reads groups, activity rows and the tree, and it
 * is a pure function, so a bug in it is a fixture and not a lost paragraph.
 *
 * ## What counts as a proof
 *
 * 1. **Every command is on the allowlist.** `FOOTPRINTS` names the commands whose effect is a known set of tree nodes: the body writes,
 *    the node-field writes, rename and move. Everything else — codex, vocabulary, recipes, project fields, coherence, export, mcp,
 *    shots, imports, skills, agent files, create and delete — has a *global* touch, or a footprint this file cannot state, and one such
 *    command in the target or in any later group gives `with-later`. A new command name has no footprint until someone classifies it
 *    (`FOOTPRINT_CLASS` is a `Record<CommandName, …>`, so the compiler asks, and a test lists the table).
 * 2. **Every entry has an activity row that says what it touched.** The row is the record of the node ids (`affected`); an entry with no
 *    row, a row with another command's name, an empty `affected`, a group that is not in the list, or a defect row on the group gives
 *    `with-later`. Nothing is guessed.
 * 3. **The touched nodes are disjoint.** A node written by the target and by a later group — a document's body, a node's fields — is an
 *    overlap, even when the text regions look apart: bodies are full snapshots and are never re-based.
 * 4. **The structure is disjoint.** A move changes a node and the child lists of its old and new parent. A later group that touches a
 *    node, a child of, or a structural parent in common — or that moved an ancestor of a node the target touched, or the target moved an
 *    ancestor of one the later group touched — is an overlap. The check is symmetric.
 *
 * Text inside one document is never merged: a later write to the same document is `with-later`, whatever it changed.
 */

import type { ActivityEntry } from './activity-log.js';
import type { CommandName } from './command.js';
import { entryOfCall, type UndoEntry, type UndoGroup } from './undo.js';

/** Where a restore begins: a whole group, or one step of it (the first entry of `fromCallId` and every entry after it). */
export interface RestoreTarget {
  readonly groupId: string;
  readonly fromCallId?: string;
}

export type RestorePlan =
  | { readonly kind: 'exact'; readonly undo: RestoreTarget }
  | {
      readonly kind: 'with-later';
      readonly undo: RestoreTarget;
      /** Every later group, newest first: the ones a restore through `restoreBefore` takes back. */
      readonly later: readonly string[];
      /** The later groups that overlap the target or could not be classified: why the plan is not exact. */
      readonly blockedBy: readonly string[];
      /** The node ids both sides touch (or one side's structure puts in common). Empty when the reason is not an overlap. */
      readonly overlap: readonly string[];
      /** `defect` is the planner failing on a tree it could not read: the plan is still safe (not exact), but the cause is a bug to find. */
      readonly reason: 'overlap' | 'unclassified' | 'unknown' | 'defect';
    };

/** The nodes one command touched. `moved` and `parents` are the structure: a move changes a node, and the child lists of two parents. */
interface Footprint {
  readonly nodes: ReadonlySet<string>;
  readonly moved: ReadonlySet<string>;
  readonly parents: ReadonlySet<string>;
}

type FootprintOf = (entry: UndoEntry, rows: readonly ActivityEntry[], ancestorsOf: Ancestors) => Footprint | undefined;
type Ancestors = (nodeId: string) => readonly string[];

const NONE: ReadonlySet<string> = new Set();

/** The node ids a row names. Empty is "unknown" here: every allowlisted command changes at least one node. */
function affectedIds(rows: readonly ActivityEntry[]): ReadonlySet<string> {
  return new Set(rows.flatMap((row) => row.affected.map((item) => item.nodeId)));
}

/** A command that writes the content of the nodes it reports: a body, a node field. */
const content: FootprintOf = (_entry, rows) => {
  const nodes = affectedIds(rows);
  return nodes.size === 0 ? undefined : { nodes, moved: NONE, parents: NONE };
};

/**
 * A move: the node, and the two parents whose child lists change. The old parent is the one the inverse puts the node back under; the new
 * one is where the node is now. A move whose inverse does not name a parent, or a node with no parent now, is unclassified.
 */
const move: FootprintOf = (entry, rows, ancestorsOf) => {
  const moved = affectedIds(rows);
  if (moved.size !== 1 || entry.kind !== 'inverse') return undefined;
  const oldParent = (entry.inverse.params as { readonly newParentId?: unknown }).newParentId;
  const [node] = [...moved];
  const newParent = ancestorsOf(node!)[0];
  if (typeof oldParent !== 'string' || newParent === undefined) return undefined;
  return { nodes: moved, moved, parents: new Set([oldParent, newParent]) };
};

/**
 * How each command is classified. `content` and `move` are footprints; `global` is a touch this file cannot bound to nodes, or a command
 * whose footprint it does not state; `none` registers nothing to restore (a view command). The record is exhaustive over the closed set of
 * names, so a name added to `COMMAND_NAMES` fails to compile here until it is classified, and the answer for a new name is "global".
 */
export const FOOTPRINT_CLASS: Readonly<Record<CommandName, 'content' | 'move' | 'global' | 'none'>> = {
  'binder.create': 'global',
  'binder.move': 'move',
  'binder.rename': 'content',
  'binder.setMeta': 'content',
  'binder.setSynopsis': 'content',
  'notes.set': 'content',
  'notes.append': 'content',
  'doc.write': 'content',
  'editor.insert': 'content',
  'editor.replaceRange': 'content',
  'codex.upsert': 'global',
  'codex.attach': 'global',
  'export.compile': 'global',
  'export.compileSelection': 'global',
  'project.deleteNode': 'global',
  'view.setSelection': 'none',
  'view.setActiveDoc': 'none',
  'view.setScroll': 'none',
  'view.setExpanded': 'none',
  'view.setCorkboardScope': 'none',
  'coherence.setSceneMeta': 'global',
  'coherence.setFindingStatus': 'global',
  'coherence.discardRun': 'global',
  'coherence.addKnowledgeFact': 'global',
  'coherence.editKnowledgeFact': 'global',
  'coherence.removeKnowledgeFact': 'global',
  'mcp.invoke': 'global',
  'mcp.readResource': 'global',
  'storyboard.create': 'global',
  'shot.create': 'global',
  'shot.setMeta': 'global',
  'project.rename': 'global',
  'project.setMetadata': 'global',
  'project.importAsset': 'global',
  'vocabulary.upsert': 'global',
  'vocabulary.remove': 'global',
  'recipe.save': 'global',
  'recipe.delete': 'global',
  'binder.saveFilter': 'global',
  'binder.deleteFilter': 'global',
  'project.saveGoal': 'global',
  'project.deleteGoal': 'global',
  'shot.importImage': 'global',
  'shot.importImages': 'global',
  'asset.import': 'global',
  'asset.importBatch': 'global',
  'asset.setMeta': 'global',
  'screenplay.import': 'global',
  'dialogue.importInk': 'global',
  'dialogue.setMeta': 'global',
  'skill.import': 'global',
  'skill.write': 'global',
  'skill.delete': 'global',
  'skill.setEnabled': 'global',
  'project.setInstructions': 'global',
  'memory.write': 'global',
  'memory.forget': 'global',
  'macro.save': 'global',
  'macro.delete': 'global',
  'hook.save': 'global',
  'hook.delete': 'global',
};

const FOOTPRINTS: Readonly<Record<'content' | 'move', FootprintOf>> = { content, move };

/** The entries a restore from `target` takes back: the whole group, or the first entry of the step and every entry after it. */
function targetEntries(group: UndoGroup, fromCallId: string | undefined): readonly UndoEntry[] {
  if (fromCallId === undefined) return group.entries;
  const from = group.entries.findIndex((entry) => entryOfCall(entry, fromCallId));
  return from === -1 ? [] : group.entries.slice(from);
}

/** The rows that describe one entry: the group's rows for its call (or, for a gesture with no call, the group's rows with no call). */
function rowsOf(group: UndoGroup, entry: UndoEntry, activity: readonly ActivityEntry[]): readonly ActivityEntry[] {
  return activity.filter(
    (row) => row.undoGroupId === group.id && row.defect === undefined && row.command === entry.name && row.callId === entry.callId,
  );
}

type Collected = { readonly ok: true; readonly footprint: Footprint } | { readonly ok: false };

/** The union of the footprints of some entries, or `ok: false` when any one cannot be stated. */
function collect(group: UndoGroup, entries: readonly UndoEntry[], activity: readonly ActivityEntry[], ancestorsOf: Ancestors): Collected {
  // A defect row on the group says the bus found something wrong after the fact; nothing about the group is taken on trust.
  if (activity.some((row) => row.undoGroupId === group.id && row.defect !== undefined)) return { ok: false };
  const nodes = new Set<string>();
  const moved = new Set<string>();
  const parents = new Set<string>();
  for (const entry of entries) {
    const kind = FOOTPRINT_CLASS[entry.name];
    // An unknown name has no entry in the table at all: `undefined` is "not classified", which is global.
    if (kind === undefined || kind === 'global' || kind === 'none') return { ok: false };
    const rows = rowsOf(group, entry, activity);
    if (rows.length === 0) return { ok: false };
    const footprint = FOOTPRINTS[kind](entry, rows, ancestorsOf);
    if (footprint === undefined) return { ok: false };
    footprint.nodes.forEach((id) => nodes.add(id));
    footprint.moved.forEach((id) => moved.add(id));
    footprint.parents.forEach((id) => parents.add(id));
  }
  return { ok: true, footprint: { nodes, moved, parents } };
}

function intersection(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((id) => b.has(id));
}

/**
 * The node ids in which two footprints meet. Four ways, each applied both ways round: the same node; a node of one that is a structural
 * parent of the other (a child list the other changes, or whose child the other writes); a node of one whose parent is a structural
 * parent of the other (a sibling the other's move can renumber); and a node of one that has an ancestor the other moved.
 */
function overlapOf(a: Footprint, b: Footprint, ancestorsOf: Ancestors): string[] {
  const hits = new Set<string>();
  const add = (ids: readonly string[]) => ids.forEach((id) => hits.add(id));
  add(intersection(a.nodes, b.nodes));
  add(intersection(a.parents, b.parents));
  for (const [x, y] of [[a, b], [b, a]] as const) {
    add(intersection(x.nodes, y.parents));
    for (const id of x.nodes) {
      const chain = ancestorsOf(id);
      if (chain[0] !== undefined && y.parents.has(chain[0])) hits.add(id);
      if (chain.some((ancestor) => y.moved.has(ancestor))) hits.add(id);
    }
    for (const id of x.parents) {
      if (ancestorsOf(id).some((ancestor) => y.moved.has(ancestor))) hits.add(id);
    }
  }
  return [...hits];
}

/**
 * Whether the target can be undone alone. `groups` is the undo stack, oldest first; `activity` the log; `ancestorsOf(id)` the node's
 * ancestors now, nearest first. The target group must be on the stack. Returns `exact` only when every entry of the target and of every
 * later group is classified, described by a row, and the footprints are disjoint (see the header); otherwise `with-later`.
 */
export function restorePlan(
  groups: readonly UndoGroup[],
  activity: readonly ActivityEntry[],
  target: RestoreTarget,
  ancestorsOf: Ancestors,
  onDefect?: (error: unknown) => void,
): RestorePlan {
  const at = groups.findIndex((group) => group.id === target.groupId);
  const withLater = (reason: 'overlap' | 'unclassified' | 'unknown' | 'defect', blockedBy: readonly string[], overlap: readonly string[]): RestorePlan => ({
    kind: 'with-later',
    undo: target,
    later: at === -1 ? [] : groups.slice(at + 1).map((group) => group.id).reverse(),
    blockedBy,
    overlap,
    reason,
  });
  if (at === -1) return withLater('unknown', [], []);
  const group = groups[at]!;
  const entries = targetEntries(group, target.fromCallId);
  if (entries.length === 0) return withLater('unknown', [], []);
  try {
    const own = collect(group, entries, activity, ancestorsOf);
    if (!own.ok) return withLater('unclassified', [group.id], []);

    const blocked: string[] = [];
    const overlap = new Set<string>();
    let unclassified = false;
    for (const later of groups.slice(at + 1)) {
      const theirs = collect(later, later.entries, activity, ancestorsOf);
      if (!theirs.ok) {
        unclassified = true;
        blocked.push(later.id);
        continue;
      }
      const shared = overlapOf(own.footprint, theirs.footprint, ancestorsOf);
      if (shared.length > 0) {
        blocked.push(later.id);
        shared.forEach((id) => overlap.add(id));
      }
    }
    if (blocked.length === 0) return { kind: 'exact', undo: target };
    return withLater(overlap.size > 0 ? 'overlap' : unclassified ? 'unclassified' : 'unknown', blocked.reverse(), [...overlap]);
  } catch (error) {
    // A tree that cannot be read is not a tree that can be proved disjoint. The plan stays with-later; `onDefect` lets the caller
    // record the error, since nothing else tells a bug here from a target that left the stack.
    try {
      onDefect?.(error);
    } catch {
      // A handler that throws must not turn a safe plan into an exception.
    }
    return withLater('defect', [], []);
  }
}
