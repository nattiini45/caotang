/**
 * `binder.restructure` — write-confirm, one undo group for the whole op list, and
 * every op validated against the tree the earlier ops leave.
 */

import { describe, expect, it } from 'vitest';

import { CHAPTER_ONE, CHAPTER_TWO, FRIEND, LANDING, STORM, makeHarness, makeState, refusalOf, run, snapshotOf, valueOf } from './fixtures.js';
import { createHarness } from '../src/index.js';
import { createProjectCommandRegistry } from '@caotang/store';

const CONFIRMED = { permission: { confirmed: true } } as const;

function childrenOf(state: ReturnType<typeof makeState>, parentId: string): string[] {
  return state.manifest.tree
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((node) => node.id);
}

describe('binder.restructure', () => {
  it('is refused without a plan or a confirmation, because it is write-confirm, and nothing is written', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const error = refusalOf(run(makeHarness({}, state), 'binder.restructure', { ops: [{ action: 'rename', node: CHAPTER_ONE, title: 'Prologue' }] }));
    expect(error.code).toBe('permission-denied');
    expect(error.risk).toBe('write-confirm');
    expect(snapshotOf(state)).toBe(before);
  });

  it('creates, moves and renames in order, and the tree reflects every op', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const outcome = valueOf(
      run(harness, 'binder.restructure', {
        ops: [
          { action: 'rename', node: CHAPTER_TWO, title: 'Epilogue' },
          { action: 'move', node: STORM, newParent: CHAPTER_TWO, index: 0 },
          { action: 'create', parent: 'manuscript', type: 'folder', title: 'Act 2' },
        ],
      }, CONFIRMED),
    );
    expect(state.manifest.tree.find((node) => node.id === CHAPTER_TWO)?.title).toBe('Epilogue');
    // The moved scene lands first; the friend that was already in chapter two follows it.
    expect(childrenOf(state, CHAPTER_TWO)).toEqual([STORM, FRIEND]);
    expect(state.manifest.tree.some((node) => node.title === 'Act 2' && node.type === 'folder')).toBe(true);
    expect(outcome.data['applied']).toBe(3);
    expect(outcome.undoGroupId).toBeDefined();
  });

  it('is undone, as one group, back to the byte-identical prior tree', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const before = snapshotOf(state);
    const outcome = valueOf(
      run(
        harness,
        'binder.restructure',
        {
          ops: [
            { action: 'create', parent: 'manuscript', type: 'folder', title: 'Act 2' },
            { action: 'move', node: LANDING, newParent: CHAPTER_TWO, index: 0 },
            { action: 'rename', node: STORM, title: 'The Storm (rev)' },
          ],
        },
        CONFIRMED,
      ),
    );
    expect(snapshotOf(state)).not.toBe(before);
    expect(harness.undo.undo(outcome.undoGroupId ?? '').ok).toBe(true);
    expect(snapshotOf(state)).toBe(before);
  });

  // The chapter rule: a create of a document directly under the manuscript is refused, in
  // the binder's words, and nothing in the batch runs. A document created in a chapter, and a chapter created under the manuscript, pass.
  it('refuses a document created directly under the manuscript, and runs none of the batch', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const error = refusalOf(
      run(
        makeHarness({}, state),
        'binder.restructure',
        {
          ops: [
            { action: 'rename', node: STORM, title: 'Renamed' },
            { action: 'create', parent: 'manuscript', type: 'document', title: 'Loose' },
          ],
        },
        CONFIRMED,
      ),
    );
    expect(JSON.stringify(error)).toContain('A document goes inside a chapter, not directly under the manuscript.');
    expect(snapshotOf(state)).toBe(before);
    valueOf(run(makeHarness({}, state), 'binder.restructure', { ops: [{ action: 'create', parent: CHAPTER_TWO, type: 'document', title: 'Inside' }] }, CONFIRMED));
    expect(state.manifest.tree.find((node) => node.title === 'Inside')?.parentId).toBe(CHAPTER_TWO);
  });

  it('refuses more than thirty ops, and says to split the batch', () => {
    const ops = Array.from({ length: 31 }, (_, index) => ({ action: 'rename', node: LANDING, title: `T${index}` }));
    const error = refusalOf(run(makeHarness(), 'binder.restructure', { ops }, CONFIRMED));
    expect(error.code).toBe('limit-exceeded');
    expect(error.message).toBe('params.ops has 31 entries, at most 30 allowed');
  });

  it('lists the failing op before anything runs, and writes none of the good ones', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const error = refusalOf(
      run(
        makeHarness({}, state),
        'binder.restructure',
        {
          ops: [
            { action: 'rename', node: CHAPTER_ONE, title: 'Prologue' },
            { action: 'move', node: STORM, newParent: 'n_MSSNG00001', index: 0 },
          ],
        },
        CONFIRMED,
      ),
    );
    expect(error.code).toBe('invalid-params');
    expect(error.details?.['failures']).toEqual([expect.objectContaining({ target: 'ops[1]', code: 'not-found' })]);
    expect(error.correctiveHint).toContain('nothing was written');
    expect(snapshotOf(state)).toBe(before);
  });

  it('refuses a move that closes a cycle which only an earlier move in the same batch creates', () => {
    const state = makeState();
    const before = snapshotOf(state);
    // Chapter two moves under chapter one; then chapter one tries to move under chapter two,
    // which is now its own descendant. Checked against the tree as the first op leaves it.
    const error = refusalOf(
      run(
        makeHarness({}, state),
        'binder.restructure',
        {
          ops: [
            { action: 'move', node: CHAPTER_TWO, newParent: CHAPTER_ONE, index: 0 },
            { action: 'move', node: CHAPTER_ONE, newParent: CHAPTER_TWO, index: 0 },
          ],
        },
        CONFIRMED,
      ),
    );
    expect(error.code).toBe('invalid-params');
    expect(error.details?.['failures']).toEqual([expect.objectContaining({ target: 'ops[1]', code: 'cycle' })]);
    expect(snapshotOf(state)).toBe(before);
  });

  it('refuses to move a fixed root, because the manuscript stays the root of the manuscript tier', () => {
    const error = refusalOf(run(makeHarness(), 'binder.restructure', { ops: [{ action: 'move', node: 'manuscript', newParent: 'research', index: 0 }] }, CONFIRMED));
    expect(error.details?.['failures']).toEqual([expect.objectContaining({ code: 'invalid-params' })]);
  });

  it('refuses a create under a document, because a document holds no children', () => {
    const error = refusalOf(run(makeHarness(), 'binder.restructure', { ops: [{ action: 'create', parent: LANDING, type: 'document', title: 'Under' }] }, CONFIRMED));
    expect(error.details?.['failures']).toEqual([expect.objectContaining({ target: 'ops[0]', code: 'invalid-params' })]);
  });

  it('refuses a reference to a node created earlier in the same batch, because ids do not exist until the batch runs', () => {
    const error = refusalOf(
      run(
        makeHarness(),
        'binder.restructure',
        {
          ops: [
            { action: 'create', parent: 'manuscript', type: 'folder', title: 'Act 2' },
            { action: 'create', parent: 'Act 2', type: 'document', title: 'Scene' },
          ],
        },
        CONFIRMED,
      ),
    );
    expect(error.details?.['failures']).toEqual([expect.objectContaining({ target: 'ops[1]', code: 'not-found' })]);
  });

  it('rejects an op with an action it does not know, at the closed-set check', () => {
    const error = refusalOf(run(makeHarness(), 'binder.restructure', { ops: [{ action: 'delete', node: LANDING }] }, CONFIRMED));
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('params.ops[0].action must be one of create, move, rename');
  });

  it('reports the bus’s own gate on a command the bus refuses, and says earlier effects are in place when there were any', () => {
    // The bus's per-command gate still runs on every command. Here the create's
    // descriptor is hard-set to `never`, so the first op is refused by the bus
    // itself, after the tool-level check has passed.
    const state = makeState();
    const registry = createProjectCommandRegistry({ clock: { now: () => 1 } });
    const restricted = {
      ...registry,
      'binder.create': { descriptor: { ...registry['binder.create'].descriptor, agentRisk: 'never' as const }, apply: registry['binder.create'].apply },
    } as typeof registry;
    const harness = createHarness({ state, registry: restricted, clock: () => 1 });
    const before = snapshotOf(state);
    const error = refusalOf(
      run(harness, 'binder.restructure', { ops: [{ action: 'create', parent: 'manuscript', type: 'folder', title: 'Act 9' }] }, CONFIRMED),
    );
    expect(error.code).toBe('permission-denied');
    expect(error.message).toContain('"binder.create" is a never-class command');
    expect(snapshotOf(state)).toBe(before);
  });
});
