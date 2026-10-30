/**
 * `restorePlan` (restore-plan.ts, command-bus §5 "Independence rule"). The planner is the one place a bug loses text, so every case
 * here is built around the way it could say `exact` wrongly, and the ones that matter are the refusals: a later write to the same
 * document, a move of an ancestor, a command with no stated footprint, and an entry nothing in the log describes.
 *
 * The groups and rows are written by hand, as the bus would leave them: an agent step's entries carry its call id, a user gesture's
 * carry none, and a row carries the command, the call, the group and the nodes the apply reported.
 */

import { describe, expect, it } from 'vitest';

import {
  COMMAND_NAMES,
  COMMAND_REGISTRY,
  FOOTPRINT_CLASS,
  restorePlan,
  type ActivityEntry,
  type CommandName,
  type RestorePlan,
  type UndoEntry,
  type UndoGroup,
} from '../src/index.js';

// ---------------------------------------------------------------- the tree the cases share

/**
 *   root
 *   ├─ ch1 ── a, b
 *   ├─ ch2 ── c
 *   └─ ch3 ── d
 */
const PARENT: Record<string, string> = { ch1: 'root', ch2: 'root', ch3: 'root', a: 'ch1', b: 'ch1', c: 'ch2', d: 'ch3' };

function chainOf(parents: Record<string, string>) {
  return (id: string): readonly string[] => {
    const chain: string[] = [];
    for (let at = parents[id]; at !== undefined; at = parents[at]) chain.push(at);
    return chain;
  };
}

const tree = chainOf(PARENT);

// ---------------------------------------------------------------- builders

let serial = 0;

interface Made {
  readonly group: UndoGroup;
  readonly rows: readonly ActivityEntry[];
}

/** One command of a group: the entry the store registered and the row the log wrote for it. */
interface Step {
  readonly name: CommandName | string;
  readonly nodes: readonly string[];
  readonly callId?: string;
  /** A move's inverse puts the node back under this parent. */
  readonly from?: string;
}

function entryOf(step: Step): UndoEntry {
  const base = { commandId: `cmd_${(serial += 1)}`, name: step.name as CommandName, label: `undo ${step.name}`, ...(step.callId === undefined ? {} : { callId: step.callId }) };
  return step.from === undefined
    ? { kind: 'compensable', ...base, restore: () => undefined }
    : {
        kind: 'inverse',
        ...base,
        inverse: { id: 'cmd_inv', name: step.name as CommandName, params: { nodeId: step.nodes[0], newParentId: step.from, index: 0 }, issuedBy: 'user', createdAt: 1 },
      };
}

function rowOf(groupId: string, step: Step): ActivityEntry {
  return {
    at: 1,
    command: step.name,
    issuedBy: step.callId === undefined ? 'user' : 'agent',
    ...(step.callId === undefined ? {} : { callId: step.callId }),
    undoGroupId: groupId,
    source: 'native',
    affected: step.nodes.map((nodeId) => ({ nodeId, title: nodeId })),
    summary: 'did it',
  };
}

function made(id: string, ...steps: readonly Step[]): Made {
  return {
    group: { id, kind: 'agent-turn', at: 1, label: 'restore to before this turn', entries: steps.map(entryOf) },
    rows: steps.map((step) => rowOf(id, step)),
  };
}

function plan(target: { groupId: string; fromCallId?: string }, parts: readonly Made[], ancestors = tree, drop: (row: ActivityEntry) => boolean = () => false): RestorePlan {
  return restorePlan(
    parts.map((part) => part.group),
    parts.flatMap((part) => part.rows).filter((row) => !drop(row)),
    target,
    ancestors,
  );
}

const write = (node: string, callId?: string): Step => ({ name: 'doc.write', nodes: [node], ...(callId === undefined ? {} : { callId }) });
const moveOf = (node: string, from: string, callId?: string): Step => ({ name: 'binder.move', nodes: [node], from, ...(callId === undefined ? {} : { callId }) });

function withLater(result: RestorePlan): Extract<RestorePlan, { kind: 'with-later' }> {
  expect(result.kind).toBe('with-later');
  return result as Extract<RestorePlan, { kind: 'with-later' }>;
}

// ---------------------------------------------------------------- exact

describe('exact: only on a proof of independence', () => {
  it('is exact when a later group wrote a document the target did not touch', () => {
    const result = plan({ groupId: 'g1' }, [made('g1', write('a', 's.1')), made('g2', write('c'))]);
    expect(result).toEqual({ kind: 'exact', undo: { groupId: 'g1' } });
  });

  it('is exact for several later groups, newest or oldest, each in a different place', () => {
    const result = plan({ groupId: 'g1' }, [made('g1', write('a', 's.1')), made('g2', write('c')), made('g3', write('d')), made('g4', { name: 'binder.setMeta', nodes: ['ch3'] })]);
    expect(result.kind).toBe('exact');
  });

  it('is exact with nothing after the target', () => {
    expect(plan({ groupId: 'g1' }, [made('g1', write('a', 's.1'))]).kind).toBe('exact');
  });

  it('is exact when a later group only wrote nodes in another folder, and the target only fields of its own', () => {
    const result = plan({ groupId: 'g1' }, [made('g1', { name: 'binder.setSynopsis', nodes: ['a'], callId: 's.1' }, { name: 'notes.append', nodes: ['b'], callId: 's.2' }), made('g2', write('c'), write('d'))]);
    expect(result.kind).toBe('exact');
  });

  it('is exact for a move whose old and new parents no later group touched', () => {
    // a moves from ch1 to ch2 (now under ch2); a later group writes c, which is under ch2.
    const parents = { ...PARENT, a: 'ch2' };
    const result = plan({ groupId: 'g1' }, [made('g1', moveOf('a', 'ch1', 's.1')), made('g2', write('d'))], chainOf(parents));
    expect(result.kind).toBe('exact');
  });
});

// ---------------------------------------------------------------- with-later: overlap

describe('with-later: the target and a later group meet', () => {
  it('names the group and the node when a later group wrote the same document', () => {
    const result = withLater(plan({ groupId: 'g1' }, [made('g1', write('a', 's.1')), made('g2', write('c')), made('g3', write('a'))]));
    expect(result.reason).toBe('overlap');
    expect(result.blockedBy).toEqual(['g3']);
    expect(result.overlap).toEqual(['a']);
    // Every later group goes with a restore that is not exact: newest first.
    expect(result.later).toEqual(['g3', 'g2']);
    expect(result.undo).toEqual({ groupId: 'g1' });
  });

  it('is with-later even when the two writes look far apart in the text: a body is a full snapshot', () => {
    // The plan has no view of the text at all; same document is enough.
    expect(plan({ groupId: 'g1' }, [made('g1', { name: 'editor.insert', nodes: ['a'] }), made('g2', { name: 'editor.replaceRange', nodes: ['a'] })]).kind).toBe('with-later');
  });

  it('is with-later when a later group wrote another field of the same node', () => {
    expect(plan({ groupId: 'g1' }, [made('g1', { name: 'binder.setMeta', nodes: ['a'] }), made('g2', { name: 'notes.set', nodes: ['a'] })]).kind).toBe('with-later');
  });

  it('is with-later when a later group moved the parent of a node the target touched', () => {
    // ch1 moved under ch3 afterwards: the tree now has ch1 under ch3.
    const after = chainOf({ ...PARENT, ch1: 'ch3' });
    const result = withLater(plan({ groupId: 'g1' }, [made('g1', write('a', 's.1')), made('g2', moveOf('ch1', 'root'))], after));
    expect(result.overlap).toEqual(['a']);
    expect(result.blockedBy).toEqual(['g2']);
  });

  it('is with-later when a later group moved an ancestor further up', () => {
    const after = chainOf({ ...PARENT, ch3: 'ch2', ch1: 'ch3' });
    expect(plan({ groupId: 'g1' }, [made('g1', write('a', 's.1')), made('g2', moveOf('ch3', 'root'))], after).kind).toBe('with-later');
  });

  it('is with-later when a later group changed the child list of a touched node’s parent', () => {
    // b moves out of ch1 into ch2: ch1 is a structural parent, and a sits under it.
    const after = chainOf({ ...PARENT, b: 'ch2' });
    const result = withLater(plan({ groupId: 'g1' }, [made('g1', write('a', 's.1')), made('g2', moveOf('b', 'ch1'))], after));
    expect(result.overlap).toContain('a');
  });

  it('is with-later when the target moved a node a later group then wrote', () => {
    const after = chainOf({ ...PARENT, a: 'ch2' });
    const result = withLater(plan({ groupId: 'g1' }, [made('g1', moveOf('a', 'ch1', 's.1')), made('g2', write('a'))], after));
    expect(result.overlap).toContain('a');
  });

  it('is with-later when the target moved a node out of a folder a later group wrote into', () => {
    // a left ch1 (now under ch2); a later group writes b, which is still in ch1 and may be renumbered by the move back.
    const after = chainOf({ ...PARENT, a: 'ch2' });
    const result = withLater(plan({ groupId: 'g1' }, [made('g1', moveOf('a', 'ch1', 's.1')), made('g2', write('b'))], after));
    expect(result.overlap).toContain('b');
  });

  it('is with-later when the target moved a node into a folder a later group wrote into', () => {
    const after = chainOf({ ...PARENT, a: 'ch2' });
    expect(plan({ groupId: 'g1' }, [made('g1', moveOf('a', 'ch1', 's.1')), made('g2', write('c'))], after).kind).toBe('with-later');
  });

  it('is with-later when both moved something under the same parent', () => {
    const after = chainOf({ ...PARENT, a: 'ch3', c: 'ch3' });
    expect(plan({ groupId: 'g1' }, [made('g1', moveOf('a', 'ch1', 's.1')), made('g2', moveOf('c', 'ch2'))], after).kind).toBe('with-later');
  });

  it('is with-later when the target moved an ancestor of a node a later group wrote', () => {
    // ch2 moved from the root under ch3 by the target; a later group wrote c, which is in ch2.
    const after = chainOf({ ...PARENT, ch2: 'ch3' });
    const result = withLater(plan({ groupId: 'g1' }, [made('g1', moveOf('ch2', 'root', 's.1')), made('g2', write('c'))], after));
    expect(result.overlap).toContain('c');
  });
});

// ---------------------------------------------------------------- with-later: nothing proved

describe('with-later: when it cannot be proved, it is never exact', () => {
  it('is with-later for a global command in a later group, and does not say the nodes overlap', () => {
    const result = withLater(plan({ groupId: 'g1' }, [made('g1', write('a', 's.1')), made('g2', { name: 'codex.upsert', nodes: [] })]));
    expect(result.reason).toBe('unclassified');
    expect(result.blockedBy).toEqual(['g2']);
    expect(result.overlap).toEqual([]);
  });

  it.each(['binder.create', 'project.deleteNode', 'codex.attach', 'export.compile', 'vocabulary.upsert', 'recipe.save', 'project.rename', 'coherence.setFindingStatus', 'mcp.invoke', 'shot.setMeta', 'memory.write'])(
    'is with-later for %s in the target or in a later group, even when it names a node nothing else touches',
    (name) => {
      const global: Step = { name, nodes: ['d'] };
      expect(plan({ groupId: 'g1' }, [made('g1', write('a', 's.1')), made('g2', global)]).kind).toBe('with-later');
      expect(plan({ groupId: 'g1' }, [made('g1', { ...global, callId: 's.1' }), made('g2', write('c'))]).kind).toBe('with-later');
    },
  );

  it('is with-later for a command name the table does not know', () => {
    expect(plan({ groupId: 'g1' }, [made('g1', write('a', 's.1')), made('g2', { name: 'future.command', nodes: ['d'] })]).kind).toBe('with-later');
  });

  it('is with-later when an entry has no activity row', () => {
    const result = plan({ groupId: 'g1' }, [made('g1', write('a', 's.1')), made('g2', write('c'))], tree, (row) => row.undoGroupId === 'g2');
    expect(withLater(result).blockedBy).toEqual(['g2']);
    expect(plan({ groupId: 'g1' }, [made('g1', write('a', 's.1')), made('g2', write('c'))], tree, (row) => row.undoGroupId === 'g1').kind).toBe('with-later');
  });

  it('is with-later when a row names another command than the entry', () => {
    const parts = [made('g1', write('a', 's.1')), made('g2', write('c'))];
    const wrong = { ...parts[1]!.rows[0]!, command: 'notes.set' };
    expect(restorePlan(parts.map((part) => part.group), [parts[0]!.rows[0]!, wrong], { groupId: 'g1' }, tree).kind).toBe('with-later');
  });

  it('is with-later when a row reports no nodes: an empty list is "unknown", not "nothing"', () => {
    const parts = [made('g1', write('a', 's.1')), made('g2', write('c'))];
    const empty = { ...parts[1]!.rows[0]!, affected: [] };
    expect(restorePlan(parts.map((part) => part.group), [parts[0]!.rows[0]!, empty], { groupId: 'g1' }, tree).kind).toBe('with-later');
  });

  it('is with-later when a group has a defect row', () => {
    const parts = [made('g1', write('a', 's.1')), made('g2', write('c'))];
    const defect: ActivityEntry = { ...parts[1]!.rows[0]!, defect: 'late-undo-capture', affected: [] };
    expect(restorePlan(parts.map((part) => part.group), [...parts.flatMap((part) => part.rows), defect], { groupId: 'g1' }, tree).kind).toBe('with-later');
  });

  it('is with-later for a group that is not on the stack, and for a step the group does not have', () => {
    const parts = [made('g1', write('a', 's.1'))];
    const unknown = withLater(plan({ groupId: 'g9' }, parts));
    expect(unknown.reason).toBe('unknown');
    expect(unknown.later).toEqual([]);
    expect(withLater(plan({ groupId: 'g1', fromCallId: 'no.such' }, parts)).reason).toBe('unknown');
  });

  it('is with-later for a move whose inverse names no parent, or whose node has no parent now', () => {
    const noInverse: Step = { name: 'binder.move', nodes: ['a'], callId: 's.1' };
    expect(plan({ groupId: 'g1' }, [made('g1', noInverse), made('g2', write('d'))]).kind).toBe('with-later');
    expect(plan({ groupId: 'g1' }, [made('g1', moveOf('a', 'ch1', 's.1')), made('g2', write('d'))], () => []).kind).toBe('with-later');
  });

  it('is with-later, not a throw, when reading the tree fails, and names the defect', () => {
    const parts = [made('g1', moveOf('a', 'ch1', 's.1')), made('g2', write('d'))];
    const failure = new Error('the tree is gone');
    const seen: unknown[] = [];
    const result = restorePlan(parts.map((part) => part.group), parts.flatMap((part) => part.rows), { groupId: 'g1' }, () => {
      throw failure;
    }, (error) => seen.push(error));
    expect(withLater(result).reason).toBe('defect');
    expect(withLater(result).blockedBy).toEqual([]);
    expect(seen).toEqual([failure]);
    // Without a handler, and with one that throws, the plan is the same.
    expect(plan({ groupId: 'g1' }, parts, () => { throw failure; }).kind).toBe('with-later');
    const throwing = restorePlan(parts.map((part) => part.group), parts.flatMap((part) => part.rows), { groupId: 'g1' }, () => { throw failure; }, () => { throw new Error('handler'); });
    expect(withLater(throwing).reason).toBe('defect');
  });

  it('does not call the defect handler for a target that left the stack or has no entries', () => {
    const parts = [made('g1', write('a', 's.1'))];
    const seen: unknown[] = [];
    const run = (target: { groupId: string; fromCallId?: string }) => restorePlan(parts.map((part) => part.group), parts.flatMap((part) => part.rows), target, tree, (error) => seen.push(error));
    expect(withLater(run({ groupId: 'g9' })).reason).toBe('unknown');
    expect(withLater(run({ groupId: 'g1', fromCallId: 'no.such' })).reason).toBe('unknown');
    const emptyGroup = { ...parts[0]!.group, entries: [] };
    expect(withLater(restorePlan([emptyGroup], [], { groupId: 'g1' }, tree, (error) => seen.push(error))).reason).toBe('unknown');
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------- one step of a turn

describe('a restore from one step', () => {
  const turn = made('g1', write('a', 's.1'), { name: 'binder.setMeta', nodes: ['b'], callId: 's.2:0' }, { name: 'binder.setMeta', nodes: ['c'], callId: 's.2:1' }, write('d', 's.3'));

  it('looks only at the entries from the step on: an overlap with an earlier step does not matter', () => {
    const later = made('g2', write('a'));
    expect(plan({ groupId: 'g1', fromCallId: 's.2' }, [turn, later]).kind).toBe('exact');
    // The whole turn does overlap, on a.
    expect(plan({ groupId: 'g1' }, [turn, later]).kind).toBe('with-later');
  });

  it('looks at every entry of the step and every later step, whatever their call ids', () => {
    expect(plan({ groupId: 'g1', fromCallId: 's.2' }, [turn, made('g2', write('c'))]).kind).toBe('with-later');
    expect(plan({ groupId: 'g1', fromCallId: 's.2' }, [turn, made('g2', write('d'))]).kind).toBe('with-later');
    expect(plan({ groupId: 'g1', fromCallId: 's.3' }, [turn, made('g2', write('c'))]).kind).toBe('exact');
  });

  it('keeps the step in the plan it returns, so it is undone as it was planned', () => {
    expect(plan({ groupId: 'g1', fromCallId: 's.3' }, [turn, made('g2', write('c'))])).toEqual({ kind: 'exact', undo: { groupId: 'g1', fromCallId: 's.3' } });
  });
});

// ---------------------------------------------------------------- the table

describe('the footprint table', () => {
  it('classifies every command name and nothing else', () => {
    expect(Object.keys(FOOTPRINT_CLASS).sort()).toEqual([...COMMAND_NAMES].sort());
    expect(Object.keys(COMMAND_REGISTRY).sort()).toEqual([...COMMAND_NAMES].sort());
  });

  it('gives a footprint to exactly these commands: body writes, node fields, rename and move', () => {
    const footprinted = COMMAND_NAMES.filter((name) => FOOTPRINT_CLASS[name] === 'content' || FOOTPRINT_CLASS[name] === 'move');
    expect(footprinted).toEqual(['binder.move', 'binder.rename', 'binder.setMeta', 'binder.setSynopsis', 'notes.set', 'notes.append', 'doc.write', 'editor.insert', 'editor.replaceRange']);
  });

  it('classifies a command as none only when it is a view command, and never a project mutation as none', () => {
    for (const name of COMMAND_NAMES) {
      const mutates = COMMAND_REGISTRY[name].descriptor.mutates;
      expect(FOOTPRINT_CLASS[name] === 'none').toBe(mutates === 'view');
    }
  });

  it('gives a footprint only to commands that change the project and can be undone', () => {
    for (const name of COMMAND_NAMES) {
      if (FOOTPRINT_CLASS[name] !== 'content' && FOOTPRINT_CLASS[name] !== 'move') continue;
      const { mutates, undo } = COMMAND_REGISTRY[name].descriptor;
      expect(mutates).toBe('project');
      expect(['inverse', 'compensable']).toContain(undo);
    }
  });
});
